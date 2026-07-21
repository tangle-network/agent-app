// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { rankFileMentions, useFileMentions, type MentionItem } from './use-file-mentions'
import type { FileMention } from '../chat-routes/wire'
import type { FileIndexResponse } from '../chat-routes/file-index'

afterEach(cleanup)

function readyResponse(files: FileMention[], truncated = false): FileIndexResponse {
  return { status: 'ready', files, truncated, generatedAt: new Date(0).toISOString() }
}

function fetchReturning(...bodies: FileIndexResponse[]): typeof fetch {
  let call = 0
  return vi.fn(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)]
    call++
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
}

// ── rankFileMentions (pure) ─────────────────────────────────────────────────

describe('rankFileMentions', () => {
  const files: FileMention[] = [
    { path: 'src/utils/format.ts', name: 'format.ts' },
    { path: 'src/api-format.ts', name: 'api-format.ts' },
    { path: 'docs/format/notes.md', name: 'notes.md' },
    { path: 'README.md', name: 'README.md' },
  ]

  it('ranks name-prefix above name-substring above path-substring', () => {
    const ranked = rankFileMentions(files, 'format', 10)
    // format.ts: name starts with "format" (tier 0)
    // api-format.ts: name contains "format" but doesn't start with it (tier 1)
    // notes.md: name doesn't match, but path contains "format" (tier 2)
    expect(ranked.map((f) => f.path)).toEqual([
      'src/utils/format.ts',
      'src/api-format.ts',
      'docs/format/notes.md',
    ])
  })

  it('excludes entries matching neither name nor path', () => {
    const ranked = rankFileMentions(files, 'zzz-no-match', 10)
    expect(ranked).toEqual([])
  })

  it('is case-insensitive', () => {
    const ranked = rankFileMentions(files, 'FORMAT', 10)
    expect(ranked.map((f) => f.path)).toContain('src/utils/format.ts')
  })

  it('returns the first N entries unranked for an empty query', () => {
    expect(rankFileMentions(files, '', 2)).toEqual(files.slice(0, 2))
    expect(rankFileMentions(files, '   ', 2)).toEqual(files.slice(0, 2))
  })

  it('caps results at the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `x-${i}.ts`, name: `x-${i}.ts` }))
    expect(rankFileMentions(many, 'x', 5)).toHaveLength(5)
  })

  it('filters a 10k-entry index in well under 50ms', () => {
    const big: FileMention[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `pkg/module-${i}/file-${i}.ts`,
      name: `file-${i}.ts`,
    }))
    const start = performance.now()
    const ranked = rankFileMentions(big, 'module-4242', 20)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
    expect(ranked.length).toBeGreaterThan(0)
  })
})

// ── useFileMentions ─────────────────────────────────────────────────────────

describe('useFileMentions', () => {
  it('fetches the index once and answers fetchItems from the in-memory filter', async () => {
    const files: FileMention[] = [
      { path: 'src/app.ts', name: 'app.ts' },
      { path: 'src/index.ts', name: 'index.ts' },
    ]
    const fetchImpl = fetchReturning(readyResponse(files))
    const { result } = renderHook(() => useFileMentions({ indexUrl: '/api/files', fetchImpl }))

    let items: MentionItem[] = []
    await act(async () => {
      items = await result.current.mention.fetchItems('app')
    })
    expect(items).toEqual([{ id: 'src/app.ts', label: 'app.ts', detail: 'src/app.ts', kind: 'file' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // A second query within the same session reuses the cached index — no refetch.
    await act(async () => {
      items = await result.current.mention.fetchItems('index')
    })
    expect(items).toEqual([{ id: 'src/index.ts', label: 'index.ts', detail: 'src/index.ts', kind: 'file' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces a typed warming state as an empty result + explanatory emptyText, never blocking', async () => {
    const fetchImpl = fetchReturning({ status: 'warming' })
    const { result } = renderHook(() => useFileMentions({ indexUrl: '/api/files', fetchImpl }))

    let items: MentionItem[] = []
    await act(async () => {
      items = await result.current.mention.fetchItems('')
    })
    expect(items).toEqual([])
    await waitFor(() => expect(result.current.mention.emptyText).toMatch(/warming|starting/i))
  })

  it('surfaces a fetch failure as an empty result + error emptyText', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const { result } = renderHook(() => useFileMentions({ indexUrl: '/api/files', fetchImpl }))

    let items: MentionItem[] = []
    await act(async () => {
      items = await result.current.mention.fetchItems('')
    })
    expect(items).toEqual([])
    await waitFor(() => expect(result.current.mention.emptyText).toMatch(/network down/))
  })

  it('tracks onMentionsChange into `mentions`, and clearMentions resets it', async () => {
    const fetchImpl = fetchReturning(readyResponse([{ path: 'a.ts', name: 'a.ts' }]))
    const { result } = renderHook(() => useFileMentions({ indexUrl: '/api/files', fetchImpl }))

    act(() => {
      result.current.mention.onMentionsChange?.([{ id: 'a.ts', label: 'a.ts', detail: 'a.ts', kind: 'file' }])
    })
    expect(result.current.mentions).toEqual([{ path: 'a.ts', name: 'a.ts' }])

    act(() => result.current.clearMentions())
    expect(result.current.mentions).toEqual([])
  })

  it('background-refreshes a stale index on the next fetchItems without blocking the answer', async () => {
    const first = readyResponse([{ path: 'old.ts', name: 'old.ts' }])
    const second = readyResponse([{ path: 'new.ts', name: 'new.ts' }])
    const fetchImpl = fetchReturning(first, second)
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(0)

    const { result } = renderHook(() =>
      useFileMentions({ indexUrl: '/api/files', fetchImpl, refreshAfterMs: 1000 }),
    )
    await act(async () => {
      await result.current.mention.fetchItems('')
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Still fresh — no refetch yet.
    nowSpy.mockReturnValue(500)
    await act(async () => {
      await result.current.mention.fetchItems('')
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Past refreshAfterMs — this call answers from the still-cached (stale)
    // data immediately, and kicks a background refetch.
    nowSpy.mockReturnValue(2000)
    let items: MentionItem[] = []
    await act(async () => {
      items = await result.current.mention.fetchItems('')
    })
    expect(items.map((i) => i.id)).toEqual(['old.ts'])
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))

    // The next query sees the refreshed data.
    await waitFor(async () => {
      const refreshed = await result.current.mention.fetchItems('')
      expect(refreshed.map((i) => i.id)).toEqual(['new.ts'])
    })

    nowSpy.mockRestore()
  })

  it('refresh() forces a re-fetch even when the cache is still within refreshAfterMs', async () => {
    const first = readyResponse([{ path: 'old.ts', name: 'old.ts' }])
    const second = readyResponse([{ path: 'new.ts', name: 'new.ts' }])
    const fetchImpl = fetchReturning(first, second)

    const { result } = renderHook(() =>
      useFileMentions({ indexUrl: '/api/files', fetchImpl, refreshAfterMs: 5 * 60 * 1000 }),
    )
    await act(async () => {
      await result.current.mention.fetchItems('')
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Well within refreshAfterMs — a normal fetchItems call would not
    // trigger a refetch here, but an explicit refresh() ignores the TTL.
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    let items: MentionItem[] = []
    await act(async () => {
      items = await result.current.mention.fetchItems('')
    })
    expect(items.map((i) => i.id)).toEqual(['new.ts'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refresh() dedupes against an already-in-flight load', async () => {
    const files = readyResponse([{ path: 'a.ts', name: 'a.ts' }])
    let resolveFetch: (() => void) | undefined
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve
      })
      return { ok: true, status: 200, json: async () => files } as unknown as Response
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useFileMentions({ indexUrl: '/api/files', fetchImpl }))

    let firstDone = false
    let secondDone = false
    act(() => {
      void result.current.mention.fetchItems('').then(() => {
        firstDone = true
      })
    })
    act(() => {
      void result.current.refresh().then(() => {
        secondDone = true
      })
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)

    await act(async () => {
      resolveFetch?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(firstDone).toBe(true))
    await waitFor(() => expect(secondDone).toBe(true))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
