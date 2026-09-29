// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { confirmWrite, rejectWrite, useConfirmedMutation, type MutationOutcome } from './use-confirmed-mutation'

function gate<T>() {
  let release!: (value: MutationOutcome<T>) => void
  const promise = new Promise<MutationOutcome<T>>(resolve => { release = resolve })
  return { promise, release }
}

describe('single-flight confirmed writes', () => {
  it.each(['confirmed', 'rejected', 'thrown'] as const)('refuses a concurrent write and reopens after %s settlement', async kind => {
    const held = gate<string>()
    const mutate = vi.fn(async () => {
      const result = await held.promise
      if (kind === 'thrown') throw new Error('write unavailable')
      return result
    })
    const { result } = renderHook(() => useConfirmedMutation({ mutate, concurrency: 'reject' }))
    let pending!: Promise<MutationOutcome<string>>
    act(() => { pending = result.current.run(undefined) })
    await act(async () => {
      expect(await result.current.run(undefined)).toMatchObject({ succeeded: false, message: 'Another operation is still in progress.' })
    })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(result.current.state.status).toBe('pending')
    await act(async () => { held.release(kind === 'confirmed' ? confirmWrite('saved') : rejectWrite('refused')); await pending })
    expect(result.current.state.status).toBe(kind === 'confirmed' ? 'succeeded' : 'failed')
    await act(async () => { await result.current.run(undefined) })
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('an older completion cannot unlock a newer single-flight operation', async () => {
    const held = [gate<string>(), gate<string>()]
    const mutate = vi.fn((_input: number) => held[_input]!.promise)
    const { result } = renderHook(() => useConfirmedMutation({ mutate, concurrency: 'reject' }))
    let first!: Promise<MutationOutcome<string>>, second!: Promise<MutationOutcome<string>>
    act(() => { first = result.current.run(0) })
    act(() => { result.current.reset(); second = result.current.run(1) })
    await act(async () => { held[0]!.release(confirmWrite('old')); await first })
    await act(async () => { expect((await result.current.run(0)).succeeded).toBe(false) })
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(result.current.state.status).toBe('pending')
    await act(async () => { held[1]!.release(confirmWrite('new')); await second })
    expect(result.current.state).toMatchObject({ status: 'succeeded', value: 'new' })
  })
})
