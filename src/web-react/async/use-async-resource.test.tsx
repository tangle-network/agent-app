// @vitest-environment jsdom
/**
 * The state machine itself. Each test names the shipped anti-pattern it makes
 * unrepresentable: a rejected load rendering as an empty list, a non-ok response
 * returning early into the same empty list, and a late response from a
 * superseded view repainting over the current one.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { requireOk } from './state'
import { useAsyncResource } from './use-async-resource'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drains the microtask chain a settled load walks (load → hook continuation →
 *  state write), so "nothing repainted" is asserted after the repaint would
 *  have happened rather than before it. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useAsyncResource', () => {
  it('lands a rejected load on error with a message and a retry — never on empty', async () => {
    const load = vi.fn(async () => {
      throw new Error('Network request failed')
    })
    const { result } = renderHook(() => useAsyncResource<string[]>({ load }))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('error'))
    if (result.current.status !== 'error') throw new Error('expected the error branch')
    expect(result.current.message).toBe('Network request failed')
    expect(result.current.error).toBeInstanceOf(Error)
    expect(typeof result.current.retry).toBe('function')
  })

  it('recovers through retry', async () => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return ['template-1']
    })
    const { result } = renderHook(() => useAsyncResource<string[]>({ load }))

    await waitFor(() => expect(result.current.status).toBe('error'))
    result.current.retry()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('expected the ready branch')
    expect(result.current.value).toEqual(['template-1'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('routes a non-ok response to error, not to the empty branch', async () => {
    // The anti-pattern this replaces: `if (!res.ok) return` leaves the caller
    // rendering an empty list for a 404.
    const load = async () => {
      const response = await requireOk(new Response('missing', { status: 404 }))
      return (await response.json()) as string[]
    }
    const { result } = renderHook(() => useAsyncResource<string[]>({ load }))

    await waitFor(() => expect(result.current.status).toBe('error'))
    if (result.current.status !== 'error') throw new Error('expected the error branch')
    expect(result.current.message).toContain('404')
  })

  it('separates a successful empty load from a failure', async () => {
    const { result } = renderHook(() => useAsyncResource<string[]>({ load: async () => [] }))

    await waitFor(() => expect(result.current.status).toBe('empty'))
    if (result.current.status !== 'empty') throw new Error('expected the empty branch')
    expect(result.current.value).toEqual([])
  })

  it('applies a custom isEmpty to an envelope shape', async () => {
    const { result } = renderHook(() =>
      useAsyncResource({
        load: async () => ({ items: [] as string[], nextCursor: null }),
        isEmpty: (page) => page.items.length === 0,
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('empty'))
  })

  it('treats a non-empty value as ready', async () => {
    const { result } = renderHook(() => useAsyncResource({ load: async () => ({ id: 'w1' }) }))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    if (result.current.status !== 'ready') throw new Error('expected the ready branch')
    expect(result.current.value).toEqual({ id: 'w1' })
  })

  it('drops a superseded load: a late first response cannot repaint the current view', async () => {
    const pending = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const load = vi.fn(async () => {
      const slot = pending[call]
      call += 1
      if (!slot) throw new Error('unexpected extra load')
      return slot.promise
    })

    const { result, rerender } = renderHook(({ key }: { key: string }) => useAsyncResource({ load, deps: [key] }), {
      initialProps: { key: 'a' },
    })
    rerender({ key: 'b' })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))

    pending[1]!.resolve(['b'])
    await waitFor(() => expect(result.current.status).toBe('ready'))

    pending[0]!.resolve(['a'])
    await settle()
    if (result.current.status !== 'ready') throw new Error('expected the ready branch')
    expect(result.current.value).toEqual(['b'])
  })

  it('a superseded load that rejects cannot paint an error over the current view', async () => {
    const pending = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const load = async () => {
      const slot = pending[call]
      call += 1
      if (!slot) throw new Error('unexpected extra load')
      return slot.promise
    }

    const { result, rerender } = renderHook(({ key }: { key: string }) => useAsyncResource({ load, deps: [key] }), {
      initialProps: { key: 'a' },
    })
    rerender({ key: 'b' })
    pending[1]!.resolve(['b'])
    await waitFor(() => expect(result.current.status).toBe('ready'))

    pending[0]!.reject(new Error('stale failure'))
    await settle()
    expect(result.current.status).toBe('ready')
  })

  it('aborts the in-flight load on unmount and on a dependency change', async () => {
    const signals: AbortSignal[] = []
    const load = async ({ signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return new Promise<string[]>(() => {})
    }

    const { rerender, unmount } = renderHook(({ key }: { key: string }) => useAsyncResource({ load, deps: [key] }), {
      initialProps: { key: 'a' },
    })
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender({ key: 'b' })
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]!.aborted).toBe(true)

    unmount()
    expect(signals[1]!.aborted).toBe(true)
  })

  it('holds at idle while disabled and loads when enabled flips', async () => {
    const load = vi.fn(async () => ['x'])
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAsyncResource({ load, enabled }),
      { initialProps: { enabled: false } },
    )

    expect(result.current.status).toBe('idle')
    expect(load).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('starts resolved from a seed without a first load, and reloads on retry', async () => {
    const load = vi.fn(async () => ['fresh'])
    const { result } = renderHook(() => useAsyncResource({ load, initialValue: ['seeded'] }))

    expect(result.current.status).toBe('ready')
    if (result.current.status !== 'ready') throw new Error('expected the ready branch')
    expect(result.current.value).toEqual(['seeded'])
    expect(load).not.toHaveBeenCalled()

    result.current.retry()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      if (result.current.status !== 'ready') throw new Error('expected the ready branch')
      expect(result.current.value).toEqual(['fresh'])
    })
  })

  it('an empty seed starts on the empty branch', () => {
    const { result } = renderHook(() =>
      useAsyncResource({ load: async () => [] as string[], initialValue: [] as string[] }),
    )
    expect(result.current.status).toBe('empty')
  })

  it('maps the message through errorMessage when supplied', async () => {
    const { result } = renderHook(() =>
      useAsyncResource<string[]>({
        load: async () => {
          throw new Error('raw upstream detail')
        },
        errorMessage: () => 'We could not load your templates.',
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('error'))
    if (result.current.status !== 'error') throw new Error('expected the error branch')
    expect(result.current.message).toBe('We could not load your templates.')
  })

  it('falls back to a readable message for a thrown non-Error', async () => {
    const { result } = renderHook(() =>
      useAsyncResource<string[]>({
        load: async () => {
          throw 42
        },
      }),
    )

    await waitFor(() => expect(result.current.status).toBe('error'))
    if (result.current.status !== 'error') throw new Error('expected the error branch')
    expect(result.current.message.trim().length).toBeGreaterThan(0)
  })
})
