/** Cursor-paged session history over the host's fetch port. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mergeSessionPages, type SessionPage, type SessionSort, type SessionSummary } from '../session-shell/index'

// ---------------------------------------------------------------------------
// useSessionHistory — cursor-paged data over an injected port
// ---------------------------------------------------------------------------

export interface SessionPageQuery {
  /** Trimmed search term; empty string means no filter. */
  q: string
  sort: SessionSort
  /** `null` for the first page. */
  cursor: string | null
  /** Aborted when the view changes or the component unmounts. */
  signal: AbortSignal
}

/** Data port — one page of sessions for the current view. */
export type FetchSessionPage = (query: SessionPageQuery) => Promise<SessionPage>

export interface UseSessionHistoryOptions {
  fetchPage: FetchSessionPage
  /** Trimmed search term driving the fetch. */
  q: string
  sort: SessionSort
  /** SSR page 1 of the default view, so the first paint costs no request. */
  initialPage: SessionPage
  /** The sort `initialPage` was rendered for. Default `'newest'`. */
  defaultSort?: SessionSort
}

export interface SessionHistoryState {
  items: SessionSummary[]
  hasMore: boolean
  isLoadingFirst: boolean
  isLoadingMore: boolean
  isError: boolean
  loadMore: () => void
  /** Re-run whichever load failed. */
  retry: () => void
  /** Refetch page 1 — call after a client-side mutation (e.g. a delete). */
  reload: () => void
}

/** Cheap content signature so a consumer inlining `initialPage={{items}}` on
 *  every render does not reseed (and re-render) forever. Identity alone — what
 *  the per-product versions keyed on — makes that an infinite loop. */
function seedSignature(page: SessionPage): string {
  return JSON.stringify({
    nextCursor: page.nextCursor ?? null,
    items: page.items.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      isPinned: Boolean(item.isPinned),
      unread: Boolean(item.unread),
      category: item.category ?? null,
    })),
  })
}

/**
 * Infinite-scroll data source for the history view. Seeds from `initialPage`
 * for the default view (no fetch) and otherwise fetches page 1 for the current
 * search/sort; `loadMore` appends the next cursor page.
 *
 * Raw promises + `AbortController` rather than a router fetcher, so a filter
 * change cancels in-flight requests, pages accumulate, and a late response from
 * a superseded view is dropped by the monotonic `seq` guard.
 */
export function useSessionHistory({
  fetchPage,
  q,
  sort,
  initialPage,
  defaultSort = 'newest',
}: UseSessionHistoryOptions): SessionHistoryState {
  const [items, setItems] = useState<SessionSummary[]>(initialPage.items)
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor ?? null)
  const [phase, setPhase] = useState<'idle' | 'loadingFirst' | 'loadingMore' | 'error'>('idle')
  const [reloadKey, setReloadKey] = useState(0)

  const seqRef = useRef(0)
  const resetAbortRef = useRef<AbortController | null>(null)
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  const loadingMoreRef = useRef(false)
  const lastOpRef = useRef<'first' | 'more'>('first')

  // Live values read inside the stable `loadMore` callback.
  const nextCursorRef = useRef(nextCursor)
  nextCursorRef.current = nextCursor
  const viewRef = useRef({ q, sort, fetchPage })
  viewRef.current = { q, sort, fetchPage }
  const seedRef = useRef(initialPage)
  seedRef.current = initialPage

  const isDefaultView = q === '' && sort === defaultSort
  const seedKey = useMemo(() => seedSignature(initialPage), [initialPage])

  // Reset on view change (q/sort), on a new SSR seed (loader revalidation), or
  // on an explicit retry/reload. The default view comes straight from SSR;
  // explicit reloads fetch page 1 so a client-only mutation refreshes this list
  // without waiting on a route loader.
  useEffect(() => {
    resetAbortRef.current?.abort()
    loadMoreAbortRef.current?.abort()
    loadingMoreRef.current = false
    const seq = ++seqRef.current

    if (isDefaultView && reloadKey === 0) {
      setItems(seedRef.current.items)
      setNextCursor(seedRef.current.nextCursor ?? null)
      setPhase('idle')
      return
    }

    const controller = new AbortController()
    resetAbortRef.current = controller
    lastOpRef.current = 'first'
    setItems([])
    setNextCursor(null)
    setPhase('loadingFirst')

    void (async () => {
      try {
        const page = await viewRef.current.fetchPage({ q, sort, cursor: null, signal: controller.signal })
        if (seq !== seqRef.current) return
        setItems(page.items)
        setNextCursor(page.nextCursor ?? null)
        setPhase('idle')
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return
        setPhase('error')
      }
    })()

    return () => controller.abort()
  }, [q, sort, seedKey, isDefaultView, reloadKey])

  const loadMore = useCallback(() => {
    const cursor = nextCursorRef.current
    if (!cursor || loadingMoreRef.current) return

    const { q: currentQ, sort: currentSort, fetchPage: currentFetch } = viewRef.current
    const seq = seqRef.current
    loadingMoreRef.current = true
    lastOpRef.current = 'more'
    const controller = new AbortController()
    loadMoreAbortRef.current = controller
    setPhase('loadingMore')

    void (async () => {
      try {
        const page = await currentFetch({ q: currentQ, sort: currentSort, cursor, signal: controller.signal })
        if (seq !== seqRef.current) return
        setItems((prev) => mergeSessionPages(prev, page.items))
        setNextCursor(page.nextCursor ?? null)
        setPhase('idle')
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return
        setPhase('error')
      } finally {
        if (seq === seqRef.current) loadingMoreRef.current = false
      }
    })()
  }, [])

  const retry = useCallback(() => {
    if (lastOpRef.current === 'more') loadMore()
    else setReloadKey((key) => key + 1)
  }, [loadMore])

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(
    () => () => {
      resetAbortRef.current?.abort()
      loadMoreAbortRef.current?.abort()
    },
    [],
  )

  return {
    items,
    hasMore: nextCursor !== null,
    isLoadingFirst: phase === 'loadingFirst',
    isLoadingMore: phase === 'loadingMore',
    isError: phase === 'error',
    loadMore,
    retry,
    reload,
  }
}
