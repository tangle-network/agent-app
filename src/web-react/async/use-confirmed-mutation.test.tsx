// @vitest-environment jsdom
/**
 * The write half. The bug this closes shipped in production: a save button that
 * rendered "Saved" on a 404, because the only thing awaited was that the request
 * came back. Every test here asserts on the FULL sequence of statuses the hook
 * passed through, not just the final one — a success that flashes for one frame
 * is the same lie.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

import { AsyncView, MutationStatus } from './async-view'
import { useAsyncResource } from './use-async-resource'
import {
  confirmJson,
  confirmResponse,
  confirmWrite,
  isConfirmedWrite,
  rejectWrite,
  useConfirmedMutation,
  type MutationOutcome,
} from './use-confirmed-mutation'

/** Records every status the hook rendered, in order. */
function trackStatuses<TInput, TValue>(mutate: (input: TInput) => Promise<MutationOutcome<TValue>>) {
  const statuses: string[] = []
  const rendered = renderHook(() => {
    const mutation = useConfirmedMutation<TInput, TValue>({ mutate: (input) => mutate(input) })
    statuses.push(mutation.state.status)
    return mutation
  })
  return { ...rendered, statuses }
}

/**
 * A write held open until the test releases it. A real request settles in a
 * later task, so the `pending` render is a real frame the reader sees; a mutate
 * that resolves inside the same microtask batch would let React coalesce it away
 * and the full status sequence could not be asserted at all.
 */
function gate<TValue>() {
  let release!: (outcome: MutationOutcome<TValue>) => void
  const promise = new Promise<MutationOutcome<TValue>>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useConfirmedMutation', () => {
  it('never reaches succeeded for a 404 — pending then failed, with the status in the message', async () => {
    const held = gate<Response>()
    const { result, statuses } = trackStatuses<{ id: string }, Response>(async () => held.promise)

    let run: Promise<MutationOutcome<Response>> | undefined
    act(() => {
      run = result.current.run({ id: 'w1' })
    })
    await waitFor(() => expect(result.current.state.status).toBe('pending'))

    let outcome: MutationOutcome<Response> | undefined
    await act(async () => {
      held.release(await confirmResponse(new Response('missing', { status: 404 })))
      outcome = await run
    })

    expect(statuses).not.toContain('succeeded')
    expect(statuses).toEqual(['idle', 'pending', 'failed'])
    expect(result.current.state.status).toBe('failed')
    if (result.current.state.status !== 'failed') throw new Error('expected the failed state')
    expect(result.current.state.message).toContain('404')
    expect(outcome?.succeeded).toBe(false)
  })

  it('never reaches succeeded when the request throws', async () => {
    const { result, statuses } = trackStatuses<void, string>(async () => {
      throw new Error('Network request failed')
    })

    await act(async () => {
      await result.current.run(undefined)
    })

    expect(statuses).not.toContain('succeeded')
    if (result.current.state.status !== 'failed') throw new Error('expected the failed state')
    expect(result.current.state.message).toBe('Network request failed')
  })

  it('never reaches succeeded for an unbranded result — an unchecked write is a failed write', async () => {
    // Exactly what the audited code produced: a resolved promise read as a
    // landed write. Without the brand this is the "Saved on a 404" path.
    const { result, statuses } = trackStatuses<void, string>(
      async () => ({ succeeded: true, value: 'ok' }) as unknown as MutationOutcome<string>,
    )

    await act(async () => {
      await result.current.run(undefined)
    })

    expect(statuses).not.toContain('succeeded')
    if (result.current.state.status !== 'failed') throw new Error('expected the failed state')
    expect(result.current.state.message).toBe('The write could not be confirmed.')
    expect(result.current.state.error).toBeInstanceOf(Error)
  })

  it('reaches succeeded only through a confirmed 2xx, carrying the parsed value', async () => {
    const held = gate<{ id: string }>()
    const { result, statuses } = trackStatuses<{ title: string }, { id: string }>(async () => held.promise)

    let run: Promise<MutationOutcome<{ id: string }>> | undefined
    act(() => {
      run = result.current.run({ title: 'nda' })
    })
    await waitFor(() => expect(result.current.state.status).toBe('pending'))

    await act(async () => {
      held.release(
        await confirmJson(
          new Response(JSON.stringify({ id: 'saved-nda' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
          (data) => data as { id: string },
        ),
      )
      await run
    })

    expect(statuses).toEqual(['idle', 'pending', 'succeeded'])
    if (result.current.state.status !== 'succeeded') throw new Error('expected the succeeded state')
    expect(result.current.state.value).toEqual({ id: 'saved-nda' })
  })

  it('fails a 2xx whose body is not the JSON the caller asked for', async () => {
    const { result } = trackStatuses<void, { id: string }>(async () =>
      confirmJson(new Response('<html>not json</html>', { status: 200 }), (data) => data as { id: string }),
    )

    await act(async () => {
      await result.current.run(undefined)
    })

    if (result.current.state.status !== 'failed') throw new Error('expected the failed state')
    expect(result.current.state.message).toContain('JSON')
  })

  it('fails when the caller validator rejects an otherwise-ok response', async () => {
    const { result } = trackStatuses<void, { id: string }>(async () =>
      confirmJson(new Response(JSON.stringify({ nope: true }), { status: 200 }), (data) => {
        if (typeof (data as { id?: unknown }).id !== 'string') throw new Error('Server returned an unexpected shape.')
        return data as { id: string }
      }),
    )

    await act(async () => {
      await result.current.run(undefined)
    })

    if (result.current.state.status !== 'failed') throw new Error('expected the failed state')
    expect(result.current.state.message).toBe('Server returned an unexpected shape.')
  })

  it('fires onSucceeded only for a confirmed write, and onFailed otherwise', async () => {
    const onSucceeded = vi.fn()
    const onFailed = vi.fn()
    const { result } = renderHook(() =>
      useConfirmedMutation<boolean, string>({
        mutate: async (ok) => (ok ? confirmWrite('stored') : rejectWrite('Could not save.')),
        onSucceeded,
        onFailed,
      }),
    )

    await act(async () => {
      await result.current.run(false)
    })
    expect(onSucceeded).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledWith('Could not save.', undefined)

    await act(async () => {
      await result.current.run(true)
    })
    expect(onSucceeded).toHaveBeenCalledWith('stored')
  })

  it('is last-write-wins: a superseded run cannot repaint the newer one', async () => {
    const gates: Array<(outcome: MutationOutcome<string>) => void> = []
    const { result } = renderHook(() =>
      useConfirmedMutation<string, string>({
        mutate: async () => new Promise<MutationOutcome<string>>((resolve) => gates.push(resolve)),
      }),
    )

    let first: Promise<MutationOutcome<string>> | undefined
    let second: Promise<MutationOutcome<string>> | undefined
    act(() => {
      first = result.current.run('a')
      second = result.current.run('b')
    })
    await waitFor(() => expect(gates).toHaveLength(2))

    await act(async () => {
      gates[1]!(confirmWrite('b-saved'))
      await second
    })
    if (result.current.state.status !== 'succeeded') throw new Error('expected the succeeded state')
    expect(result.current.state.value).toBe('b-saved')

    await act(async () => {
      gates[0]!(rejectWrite('a failed late'))
      await first
    })
    // The stale run reported to its own caller and left the state alone.
    if (result.current.state.status !== 'succeeded') throw new Error('expected the succeeded state to survive')
    expect(result.current.state.value).toBe('b-saved')
  })

  it('reset returns to idle', async () => {
    const { result } = renderHook(() =>
      useConfirmedMutation<void, string>({ mutate: async () => confirmWrite('done') }),
    )
    await act(async () => {
      await result.current.run(undefined)
    })
    expect(result.current.state.status).toBe('succeeded')

    act(() => result.current.reset())
    expect(result.current.state.status).toBe('idle')
  })

  it('aborts a superseded run and leaves the signal alone otherwise', async () => {
    const signals: AbortSignal[] = []
    const { result } = renderHook(() =>
      useConfirmedMutation<void, string>({
        mutate: async (_input, { signal }) => {
          signals.push(signal)
          return confirmWrite('done')
        },
      }),
    )

    await act(async () => {
      await result.current.run(undefined)
    })
    expect(signals[0]!.aborted).toBe(false)

    await act(async () => {
      await result.current.run(undefined)
    })
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
  })
})

describe('confirmation helpers', () => {
  it('brands only what a confirm helper produced', async () => {
    expect(isConfirmedWrite(confirmWrite('x'))).toBe(true)
    expect(isConfirmedWrite({ succeeded: true, value: 'x' })).toBe(false)
    expect(isConfirmedWrite(rejectWrite('no'))).toBe(false)
    expect(isConfirmedWrite(null)).toBe(false)
    expect(isConfirmedWrite(undefined)).toBe(false)

    const ok = await confirmResponse(new Response(null, { status: 204 }))
    expect(isConfirmedWrite(ok)).toBe(true)
    const bad = await confirmResponse(new Response('server exploded', { status: 500 }))
    expect(isConfirmedWrite(bad)).toBe(false)
    expect(bad.succeeded === false && bad.message).toContain('500')
  })
})

describe('MutationStatus', () => {
  it('renders Saved only after a confirmed write, and the failure message on a 404', async () => {
    function SaveButton({ status }: { status: number }) {
      const save = useConfirmedMutation<void, Response>({
        mutate: async () => confirmResponse(new Response(status === 204 ? null : 'body', { status })),
      })
      return (
        <div>
          <button type="button" disabled={save.state.status === 'pending'} onClick={() => void save.run(undefined)}>
            Save
          </button>
          <MutationStatus state={save.state} />
        </div>
      )
    }

    const { unmount } = render(<SaveButton status={404} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Saved')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('404')
    unmount()

    render(<SaveButton status={200} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AsyncView + useConfirmedMutation compose', () => {
  it('keeps a failed write out of the resource branches', async () => {
    function Panel() {
      const members = useAsyncResource<string[]>({ load: async () => ['ada@example.test'] })
      const remove = useConfirmedMutation<string, Response>({
        mutate: async () => confirmResponse(new Response('', { status: 403 })),
      })
      return (
        <div>
          <AsyncView state={members} empty={{ title: 'No members yet' }}>
            {(items) => (
              <ul>
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </AsyncView>
          <button type="button" onClick={() => void remove.run('m1')}>
            Remove
          </button>
          <MutationStatus state={remove.state} />
        </div>
      )
    }

    render(<Panel />)
    await screen.findByText('ada@example.test')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await screen.findByRole('alert')

    // The list is still the list; the write failure is its own signal.
    expect(screen.getByText('ada@example.test')).toBeDefined()
    expect(screen.queryByText('No members yet')).toBeNull()
  })
})
