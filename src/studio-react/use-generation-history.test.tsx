// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Generation } from '../studio/generation'
import type {
  FetchGenerationsPage,
  GenerationPage,
  GenerationPageQuery,
  MediaTypeFilter,
} from '../studio/ports'
import { useGenerationHistory, type UseGenerationHistoryOptions } from './use-generation-history'

afterEach(cleanup)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function generation(id: string): Generation {
  return {
    id,
    type: 'image',
    prompt: `prompt ${id}`,
    result: `https://example.test/${id}.png`,
    model: 'image-model',
    cost: null,
    createdAt: null,
    metadata: null,
  }
}

function controlledFetch() {
  const requests: Array<{ query: GenerationPageQuery; result: Deferred<GenerationPage> }> = []
  const fetchPage: FetchGenerationsPage = vi.fn((query) => {
    const result = deferred<GenerationPage>()
    requests.push({ query, result })
    return result.promise
  })
  return { fetchPage, requests }
}

describe('useGenerationHistory', () => {
  it('loads page 1 on mount and reports the next cursor', async () => {
    const { fetchPage, requests } = controlledFetch()
    const { result } = renderHook(() => useGenerationHistory({ fetchPage, q: '  birds  ', type: 'all' }))

    expect(result.current.isLoadingFirst).toBe(true)
    expect(requests[0]?.query).toMatchObject({ q: 'birds', type: 'all', cursor: null })

    await act(async () => requests[0]!.result.resolve({ items: [generation('a')], nextCursor: 'page-2' }))

    expect(result.current.items.map((item) => item.id)).toEqual(['a'])
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isLoadingFirst).toBe(false)
  })

  it('does not let a superseded view response repaint the current view', async () => {
    const { fetchPage, requests } = controlledFetch()
    const { result, rerender } = renderHook(
      ({ q }) => useGenerationHistory({ fetchPage, q, type: 'all' }),
      { initialProps: { q: 'view A' } },
    )

    rerender({ q: 'view B' })
    expect(requests).toHaveLength(2)

    await act(async () => requests[1]!.result.resolve({ items: [generation('b')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['b'])

    await act(async () => requests[0]!.result.resolve({ items: [generation('a')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['b'])
  })

  it('appends and dedupes load-more pages while exposing its loading phase', async () => {
    const { fetchPage, requests } = controlledFetch()
    const { result } = renderHook(() => useGenerationHistory({ fetchPage, q: 'birds', type: 'all' }))
    await act(async () => requests[0]!.result.resolve({
      items: [generation('a'), generation('b')],
      nextCursor: 'page-2',
    }))

    act(() => result.current.loadMore())
    expect(result.current.isLoadingMore).toBe(true)
    expect(requests[1]?.query.cursor).toBe('page-2')

    await act(async () => requests[1]!.result.resolve({ items: [generation('b'), generation('c')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.isLoadingMore).toBe(false)
  })

  it('seeds the default view and ignores an inline-equivalent replacement', async () => {
    const { fetchPage, requests } = controlledFetch()
    const seedItems = [generation('seed')]
    const { result, rerender } = renderHook(
      ({ initialPage }: { initialPage: GenerationPage }) => useGenerationHistory({
        fetchPage,
        q: '',
        type: 'all',
        initialPage,
      }),
      { initialProps: { initialPage: { items: seedItems, nextCursor: 'page-2' } } },
    )

    expect(fetchPage).not.toHaveBeenCalled()
    act(() => result.current.loadMore())
    await act(async () => requests[0]!.result.resolve({ items: [generation('more')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['seed', 'more'])

    rerender({ initialPage: { items: [generation('seed')], nextCursor: 'page-2' } })
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['seed', 'more']))
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('ignores the default seed for a non-default type', async () => {
    const { fetchPage, requests } = controlledFetch()
    const { result } = renderHook(() => useGenerationHistory({
      fetchPage,
      q: '',
      type: 'image',
      initialPage: { items: [generation('seed')] },
    }))

    expect(requests[0]?.query).toMatchObject({ q: '', type: 'image', cursor: null })
    expect(result.current.items).toEqual([])
    await act(async () => requests[0]!.result.resolve({ items: [generation('image')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['image'])
  })

  it('retries a failed load-more with the same cursor', async () => {
    const { fetchPage, requests } = controlledFetch()
    const { result } = renderHook(() => useGenerationHistory({ fetchPage, q: 'birds', type: 'all' }))
    await act(async () => requests[0]!.result.resolve({ items: [generation('a')], nextCursor: 'page-2' }))

    act(() => result.current.loadMore())
    await act(async () => requests[1]!.result.reject(new Error('offline')))
    expect(result.current.isError).toBe(true)
    expect(result.current.items.map((item) => item.id)).toEqual(['a'])

    act(() => result.current.retry())
    expect(requests[2]?.query.cursor).toBe('page-2')
    await act(async () => requests[2]!.result.resolve({ items: [generation('b')] }))
    expect(result.current.isError).toBe(false)
    expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('aborts an in-flight request on unmount', () => {
    const { fetchPage, requests } = controlledFetch()
    const { unmount } = renderHook(() => useGenerationHistory({ fetchPage, q: 'birds', type: 'all' }))
    const signal = requests[0]!.query.signal

    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })

  it('refetches rather than resurrecting the seed when the default view is re-entered', async () => {
    const { fetchPage, requests } = controlledFetch()
    const options: Omit<UseGenerationHistoryOptions, 'type'> = {
      fetchPage,
      q: '',
      initialPage: { items: [generation('seed')] },
    }
    const { result, rerender } = renderHook(
      ({ type }: { type: MediaTypeFilter }) => useGenerationHistory({ ...options, type }),
      { initialProps: { type: 'all' } },
    )

    rerender({ type: 'image' })
    await act(async () => requests[0]!.result.resolve({ items: [generation('image')] }))
    rerender({ type: 'all' })

    expect(requests[1]?.query).toMatchObject({ q: '', type: 'all', cursor: null })
    expect(result.current.items).toEqual([])
    await act(async () => requests[1]!.result.resolve({ items: [generation('fresh')] }))
    expect(result.current.items.map((item) => item.id)).toEqual(['fresh'])
  })
})
