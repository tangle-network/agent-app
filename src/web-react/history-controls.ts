import { useCallback, useEffect } from 'react'

/** Cursor histories share retry, reload, cancellation and their visible loading projection. */
export function useHistoryControls<T>({ items, nextCursor, phase, loadMore }: {
  items: T[]
  nextCursor: string | null
  phase: 'idle' | 'loadingFirst' | 'loadingMore' | 'error'
  loadMore: () => void
}, { lastOpRef, setReloadKey, resetAbortRef, loadMoreAbortRef }: {
  lastOpRef: { current: 'first' | 'more' }
  setReloadKey: (update: (current: number) => number) => void
  resetAbortRef: { current: AbortController | null }
  loadMoreAbortRef: { current: AbortController | null }
}) {
  const retry = useCallback(() => {
    if (lastOpRef.current === 'more') loadMore()
    else setReloadKey((key) => key + 1)
  }, [loadMore])
  const reload = useCallback(() => {
    setReloadKey((key) => key + 1)
  }, [])
  useEffect(() => () => {
    resetAbortRef.current?.abort()
    loadMoreAbortRef.current?.abort()
  }, [])
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


/** Apply a page only to the view that requested it; cancellation and failures share one policy. */
export async function loadHistoryPage<T>(request: () => Promise<T>, onPage: (page: T) => void, { controller, seq, seqRef, setPhase, onSettled }: {
  controller: AbortController
  seq: number
  seqRef: { current: number }
  setPhase: (phase: 'idle' | 'loadingFirst' | 'loadingMore' | 'error') => void
  onSettled?: () => void
}): Promise<void> {
  try {
    const page = await request()
    if (seq !== seqRef.current) return
    onPage(page)
    setPhase('idle')
  } catch {
    if (controller.signal.aborted || seq !== seqRef.current) return
    setPhase('error')
  } finally {
    if (seq === seqRef.current) onSettled?.()
  }
}
