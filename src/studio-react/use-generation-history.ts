import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FetchGenerationsPage, GenerationPage, MediaTypeFilter } from '../studio/ports'
import { mergeGenerationPages, type Generation } from '../studio/generation'

export interface UseGenerationHistoryOptions {
  fetchPage: FetchGenerationsPage
  /** ALREADY debounced by the caller. */
  q: string
  type: MediaTypeFilter
  /** SSR/loader page 1 for the DEFAULT view only (q === '' && type === 'all'). */
  initialPage?: GenerationPage
}

export interface GenerationHistoryState {
  items: Generation[]
  hasMore: boolean
  isLoadingFirst: boolean
  isLoadingMore: boolean
  isError: boolean
  loadMore: () => void
  retry: () => void
  reload: () => void
}

/** Content identity keeps inline-equivalent loader pages from reseeding. */
function seedSignature(page: GenerationPage | undefined): string {
  if (!page) return ''
  return `${page.nextCursor ?? ''}|${page.items.map((item) => item.id).join(',')}`
}

/** Cursor-paged generation history over the product-supplied data port. */
export function useGenerationHistory({
  fetchPage,
  q,
  type,
  initialPage,
}: UseGenerationHistoryOptions): GenerationHistoryState {
  const startsFromSeed = q === '' && type === 'all' && initialPage !== undefined
  const [items, setItems] = useState<Generation[]>(startsFromSeed ? initialPage.items : [])
  const [nextCursor, setNextCursor] = useState<string | null>(
    startsFromSeed ? initialPage.nextCursor ?? null : null,
  )
  const [phase, setPhase] = useState<'idle' | 'loadingFirst' | 'loadingMore' | 'error'>(
    startsFromSeed ? 'idle' : 'loadingFirst',
  )
  const [reloadKey, setReloadKey] = useState(0)

  const seqRef = useRef(0)
  const resetAbortRef = useRef<AbortController | null>(null)
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  const loadingFirstRef = useRef(!startsFromSeed)
  const loadingMoreRef = useRef(false)
  const lastOpRef = useRef<'first' | 'more'>('first')
  const seedEligibleRef = useRef(true)

  const nextCursorRef = useRef(nextCursor)
  nextCursorRef.current = nextCursor
  const viewRef = useRef({ q, type, fetchPage })
  viewRef.current = { q, type, fetchPage }
  const seedRef = useRef(initialPage)
  seedRef.current = initialPage

  const isDefaultView = q === '' && type === 'all'
  const seedKey = useMemo(() => seedSignature(initialPage), [initialPage])

  useEffect(() => {
    resetAbortRef.current?.abort()
    loadMoreAbortRef.current?.abort()
    loadingFirstRef.current = false
    loadingMoreRef.current = false
    const seq = ++seqRef.current

    if (!isDefaultView) seedEligibleRef.current = false
    const seed = seedRef.current
    if (isDefaultView && seedEligibleRef.current && reloadKey === 0 && seed) {
      setItems(seed.items)
      setNextCursor(seed.nextCursor ?? null)
      setPhase('idle')
      return
    }

    const controller = new AbortController()
    resetAbortRef.current = controller
    loadingFirstRef.current = true
    lastOpRef.current = 'first'
    setItems([])
    setNextCursor(null)
    setPhase('loadingFirst')

    void (async () => {
      try {
        const current = viewRef.current
        const page = await current.fetchPage({
          q: current.q.trim(),
          type: current.type,
          cursor: null,
          signal: controller.signal,
        })
        if (seq !== seqRef.current) return
        setItems(page.items)
        setNextCursor(page.nextCursor ?? null)
        setPhase('idle')
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return
        setPhase('error')
      } finally {
        if (seq === seqRef.current) loadingFirstRef.current = false
      }
    })()

    return () => controller.abort()
  }, [q, type, seedKey, isDefaultView, reloadKey])

  const loadMore = useCallback(() => {
    const cursor = nextCursorRef.current
    if (!cursor || loadingFirstRef.current || loadingMoreRef.current) return

    const current = viewRef.current
    const seq = seqRef.current
    loadMoreAbortRef.current?.abort()
    const controller = new AbortController()
    loadMoreAbortRef.current = controller
    loadingMoreRef.current = true
    lastOpRef.current = 'more'
    setPhase('loadingMore')

    void (async () => {
      try {
        const page = await current.fetchPage({
          q: current.q.trim(),
          type: current.type,
          cursor,
          signal: controller.signal,
        })
        if (seq !== seqRef.current) return
        setItems((previous) => mergeGenerationPages(previous, page.items))
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
