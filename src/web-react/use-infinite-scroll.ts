/** Intersection-observer admission for paged lists. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

// ---------------------------------------------------------------------------
// useInfiniteScroll
// ---------------------------------------------------------------------------

export interface UseInfiniteScrollOptions {
  /** Only fire `onLoadMore` while true (a next page exists, none in flight). */
  enabled: boolean
  /** Scroll container the sentinel lives in. Defaults to the viewport. */
  root?: RefObject<HTMLElement | null>
  /** Prefetch distance before the sentinel is actually reached. */
  rootMargin?: string
}

function rethrowAsync(error: unknown) {
  queueMicrotask(() => {
    throw error
  })
}

/**
 * Fires `onLoadMore` when a sentinel element scrolls into view. Returns a ref
 * callback for that sentinel (typically the last element in a list).
 *
 * The observer is re-created whenever `enabled` flips, so a short first page
 * that leaves the sentinel on-screen keeps loading: when a load finishes and
 * `enabled` returns to true, the fresh observer re-reads the current
 * intersection state and fires again until the sentinel is pushed off-screen.
 */
export function useInfiniteScroll(
  onLoadMore: () => void,
  { enabled, root, rootMargin = '300px' }: UseInfiniteScrollOptions,
): (node: HTMLElement | null) => void {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const sentinelRef = useCallback((node: HTMLElement | null) => setSentinel(node), [])
  const onLoadMoreRef = useRef(onLoadMore)

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore
  }, [onLoadMore])

  useEffect(() => {
    if (!sentinel || !enabled) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        try {
          onLoadMoreRef.current()
        } catch (error) {
          rethrowAsync(error)
        }
      },
      { root: root?.current ?? null, rootMargin },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, enabled, root, rootMargin])

  return sentinelRef
}
