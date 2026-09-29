// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { requireOk } from './state'
import { useAsyncResource } from './use-async-resource'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Let a stale promise reach its state-write opportunity before asserting. */
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('useAsyncResource', () => {
  it.each([
    { name: 'a rejected load', load: async () => { throw new Error('Network request failed') }, message: /Network request failed/, errorType: Error },
    { name: 'a non-ok response', load: async () => requireOk(new Response('missing', { status: 404 })), message: /404/, errorType: Error },
    { name: 'a custom error message', load: async () => { throw new Error('raw upstream detail') }, errorMessage: () => 'We could not load your templates.', message: /^We could not load your templates\.$/, errorType: Error },
    { name: 'a thrown non-Error', load: async () => { throw 42 }, message: /\S/, errorType: undefined },
  ])('routes $name to a readable error with retry, never empty', async ({ load, errorMessage, message, errorType }) => {
    const { result } = renderHook(() => useAsyncResource({ load, errorMessage }))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('error'))
    const state = result.current
    if (state.status !== 'error') throw new Error('expected the error branch')
    expect(state.message).toMatch(message)
    if (errorType) expect(state.error).toBeInstanceOf(errorType)
    expect(typeof state.retry).toBe('function')
  })

  it('recovers through retry', async () => {
    const load = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['template-1'])
    const { result } = renderHook(() => useAsyncResource({ load }))
    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: ['template-1'] }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'empty collection', value: [], expected: 'empty', isEmpty: undefined },
    { name: 'empty envelope', value: { items: [], nextCursor: null }, expected: 'empty', isEmpty: (value: unknown) => (value as { items: unknown[] }).items.length === 0 },
    { name: 'non-empty object', value: { id: 'w1' }, expected: 'ready', isEmpty: undefined },
  ])('classifies a successful $name', async ({ value, expected, isEmpty }) => {
    const { result } = renderHook(() => useAsyncResource<unknown>({ load: async () => value, isEmpty }))
    await waitFor(() => expect(result.current).toMatchObject({ status: expected, value }))
  })

  it.each(['resolve', 'reject'] as const)('ignores a superseded load that later calls %s', async outcome => {
    const pending = [deferred<string[]>(), deferred<string[]>()]
    const load = vi.fn<() => Promise<string[]>>()
      .mockImplementationOnce(() => pending[0]!.promise).mockImplementationOnce(() => pending[1]!.promise)
    const { result, rerender } = renderHook(({ key }) => useAsyncResource({ load, deps: [key] }), {
      initialProps: { key: 'a' },
    })
    rerender({ key: 'b' })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    pending[1]!.resolve(['b'])
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: ['b'] }))
    if (outcome === 'resolve') pending[0]!.resolve(['a'])
    else pending[0]!.reject(new Error('stale failure'))
    await settle()
    expect(result.current).toMatchObject({ status: 'ready', value: ['b'] })
  })

  it('aborts the in-flight load on dependency change and unmount', async () => {
    const signals: AbortSignal[] = []
    const load = async ({ signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return new Promise<string[]>(() => {})
    }
    const { rerender, unmount } = renderHook(({ key }) => useAsyncResource({ load, deps: [key] }), {
      initialProps: { key: 'a' },
    })
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender({ key: 'b' })
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]!.aborted).toBe(true)
    unmount()
    expect(signals[1]!.aborted).toBe(true)
  })

  it('holds at idle while disabled and loads when enabled', async () => {
    const load = vi.fn(async () => ['x'])
    const { result, rerender } = renderHook(({ enabled }) => useAsyncResource({ load, enabled }), {
      initialProps: { enabled: false },
    })
    expect(result.current.status).toBe('idle')
    expect(load).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('uses the initial seed without fetching, then fetches on retry', async () => {
    const load = vi.fn(async () => ['fresh'])
    const { result } = renderHook(() => useAsyncResource({ load, initialValue: ['seeded'] }))
    expect(result.current).toMatchObject({ status: 'ready', value: ['seeded'] })
    expect(load).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: ['fresh'] }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps an empty seed distinguishable from a failed read', () => {
    const { result } = renderHook(() => useAsyncResource({ load: async () => [] as string[], initialValue: [] as string[] }))
    expect(result.current).toMatchObject({ status: 'empty', value: [] })
  })
})
