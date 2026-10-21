import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams, type ShouldRevalidateFunctionArgs } from 'react-router'
import type { FetchGenerationsPage, Generation, GenerationPage } from '../studio'

/** In-route navigation between the three studio screens: one URL, local state. */
export type StudioScreen =
  | { kind: 'home' }
  | { kind: 'generation'; batchKey: string }
  | { kind: 'history' }

/**
 * `?type=`-only URL changes never need the loader: the history screen pages
 * its own data through `fetchPage`, and the param only picks the entry screen.
 * Anything else, pathname changes included, revalidates normally.
 */
export function studioShouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate

  const stripType = (search: string) => {
    const params = new URLSearchParams(search)
    params.delete('type')
    return params.toString()
  }
  if (stripType(currentUrl.search) === stripType(nextUrl.search)) return false
  return defaultShouldRevalidate
}

/**
 * Screen state for the studio route. Viewers cannot compose, so they enter on
 * history. The previous studio page filtered its library through `?type=`; a
 * legacy filter link lands on history too, including when it arrives on an
 * already-mounted studio. A fresh `location.key` means the user opened Studio
 * again (same-path navigation does not remount), so composing users return
 * home; opening a batch changes local state only, never the key.
 */
export function useStudioScreens({ canGenerate, viewerBackHref }: { canGenerate: boolean; viewerBackHref: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const legacyFilterLink = searchParams.has('type')
  const [screen, setScreen] = useState<StudioScreen>(
    canGenerate && !legacyFilterLink ? { kind: 'home' } : { kind: 'history' },
  )
  const location = useLocation()
  const navigate = useNavigate()

  // One-way on purpose: the param clearing must not force the user home.
  useEffect(() => {
    if (legacyFilterLink) setScreen({ kind: 'history' })
  }, [legacyFilterLink])

  useEffect(() => {
    if (canGenerate && !legacyFilterLink) setScreen({ kind: 'home' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  const backToStudio = () => {
    if (canGenerate) {
      // A legacy filter link has served its purpose once the user leaves the
      // library; drop the param so a reload lands on home instead of history.
      if (legacyFilterLink) {
        const next = new URLSearchParams(searchParams)
        next.delete('type')
        setSearchParams(next, { replace: true })
      }
      setScreen({ kind: 'home' })
    } else {
      // Viewers enter history directly, so Back needs a deterministic in-app
      // target; history.back() could leave the app from a deep link.
      void navigate(viewerBackHref)
    }
  }

  return {
    screen,
    backToStudio,
    openGeneration: (batchKey: string) => setScreen({ kind: 'generation', batchKey }),
    openHistory: () => setScreen({ kind: 'history' }),
  }
}

/**
 * The cursor-paged history fetch against `{endpoint}?workspaceId&q&type&cursor`
 * (default `/api/generations`). Checks the structural assumptions callers
 * dereference so endpoint drift fails with a named error, and drops rows
 * `isRemoved` reports, so a page that raced a delete cannot resurrect a row.
 */
export function studioHistoryFetcher(
  workspaceId: string,
  options: { endpoint?: string; isRemoved?: (generationId: string) => boolean } = {},
): FetchGenerationsPage {
  const { endpoint = '/api/generations', isRemoved } = options
  return async ({ q, type, cursor, signal }) => {
    const params = new URLSearchParams({ workspaceId })
    if (q) params.set('q', q)
    if (type !== 'all') params.set('type', type)
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`${endpoint}?${params.toString()}`, { signal })
    if (!response.ok) throw new Error(`Loading generations failed: ${response.status}`)
    const page = (await response.json()) as GenerationPage
    const pageIsValid =
      !!page &&
      Array.isArray(page.items) &&
      page.items.every((item: Generation) => typeof item?.id === 'string') &&
      (page.nextCursor == null || typeof page.nextCursor === 'string')
    if (!pageIsValid) throw new Error('Unexpected generations page shape')
    return { ...page, items: isRemoved ? page.items.filter((item) => !isRemoved(item.id)) : page.items }
  }
}
