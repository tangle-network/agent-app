/**
 * The rendered half of the session shell: the history view behind the rail's
 * session list, and the rename/delete dialogs both surfaces drive.
 *
 * Storage is a seam, not a dependency. Every product keeps sessions somewhere
 * different (gtm threads, tax sessions, legal matters), so this takes a
 * `fetchPage` data port and injected mutations — the same shape
 * `AgentActivityPanel` (`fetchActivity`) and `ReviewQueuePanel` (`fetchQueue`)
 * already use, rather than a fifth pattern.
 *
 * sandbox-ui free on purpose: `/web-react` must not force the optional peer, so
 * these render on the shared design tokens like the rest of the subpath. The
 * pure logic (nav items, routing, cookies, merging) lives in `/session-shell`,
 * which a server loader can import without pulling React.
 */

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  type SessionPage,
  type SessionRailAction,
  type SessionSort,
  type SessionSummary,
  mergeSessionPages,
  sessionLabel,
  UNTITLED_SESSION_LABEL,
} from '../session-shell/index'
import { OVERLAY_SHADOW, PopoverSurface, usePopover } from './controls'

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

// ---------------------------------------------------------------------------
// useSessionActions — rename / delete over injected mutations
// ---------------------------------------------------------------------------

export interface SessionActionsOptions {
  /** Persist a new title. Reject to surface the error in the dialog. */
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  /** Called after a successful rename/delete — revalidate the rail here. */
  onChanged?: () => void
  /** Called after deleting the session the user is currently viewing, so the
   *  product can navigate away from a route that no longer resolves. */
  onDeletedCurrent?: () => void
  /** The open session, compared against the delete target. */
  currentSessionId?: string | null
  /** Product toast/log seam. Errors also render inside the dialog. */
  notify?: (level: 'success' | 'error', message: string) => void
  labels?: Partial<SessionActionLabels>
}

export interface SessionActionLabels {
  renameTitle: string
  renameField: string
  renameSubmit: string
  deleteTitle: string
  deleteBody: (title: string) => string
  deleteSubmit: string
  cancel: string
  renamed: string
  deleted: string
  renameFailed: string
  deleteFailed: string
}

const DEFAULT_LABELS: SessionActionLabels = {
  renameTitle: 'Rename session',
  renameField: 'Title',
  renameSubmit: 'Save',
  deleteTitle: 'Delete session?',
  deleteBody: (title) => `This will permanently delete “${title}” and its messages. This cannot be undone.`,
  deleteSubmit: 'Delete',
  cancel: 'Cancel',
  renamed: 'Session renamed',
  deleted: 'Session deleted',
  renameFailed: 'Failed to rename session',
  deleteFailed: 'Failed to delete session',
}

export interface SessionActions {
  openRename: (session: SessionSummary) => void
  openDelete: (session: SessionSummary) => void
  /** Render once, anywhere that survives navigation (the layout). */
  dialogs: ReactNode
  busy: boolean
}

/**
 * Rename + delete for one session, shared by the rail kebab and the history
 * row menu so both drive the same dialogs and the same product mutations.
 *
 * Dialogs are owned here rather than returned as raw state: two surfaces
 * needing the same confirm step is exactly how a product ends up with two
 * subtly different delete confirmations.
 */
export function useSessionActions({
  renameSession,
  deleteSession,
  onChanged,
  onDeletedCurrent,
  currentSessionId,
  notify,
  labels,
}: SessionActionsOptions): SessionActions {
  const text = { ...DEFAULT_LABELS, ...labels }
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openRename = useCallback((session: SessionSummary) => {
    setError(null)
    setRenameTarget(session)
    setRenameValue(session.title ?? '')
  }, [])

  const openDelete = useCallback((session: SessionSummary) => {
    setError(null)
    setDeleteTarget(session)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget) return
    const title = renameValue.trim()
    // A no-op rename closes rather than writing — otherwise every accidental
    // open costs a request and a revalidation.
    if (!title || title === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await renameSession(renameTarget.id, title)
      setRenameTarget(null)
      notify?.('success', text.renamed)
      onChanged?.()
    } catch (e) {
      const message = e instanceof Error ? e.message : text.renameFailed
      setError(message)
      notify?.('error', message)
    } finally {
      setBusy(false)
    }
  }, [renameTarget, renameValue, renameSession, notify, onChanged, text.renamed, text.renameFailed])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    const deletingCurrent = currentSessionId != null && deleteTarget.id === currentSessionId
    setBusy(true)
    setError(null)
    try {
      await deleteSession(deleteTarget.id)
      setDeleteTarget(null)
      notify?.('success', text.deleted)
      onChanged?.()
      if (deletingCurrent) onDeletedCurrent?.()
    } catch (e) {
      const message = e instanceof Error ? e.message : text.deleteFailed
      setError(message)
      notify?.('error', message)
    } finally {
      setBusy(false)
    }
  }, [deleteTarget, currentSessionId, deleteSession, notify, onChanged, onDeletedCurrent, text.deleted, text.deleteFailed])

  const dialogs = (
    <>
      {renameTarget && (
        <SessionDialog
          title={text.renameTitle}
          onClose={() => setRenameTarget(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <DialogButton onClick={() => setRenameTarget(null)} disabled={busy} variant="ghost">
                {text.cancel}
              </DialogButton>
              <DialogButton onClick={() => void submitRename()} disabled={busy || !renameValue.trim()}>
                {text.renameSubmit}
              </DialogButton>
            </>
          }
        >
          <label htmlFor="agent-app-rename-session" className="text-xs text-muted-foreground">
            {text.renameField}
          </label>
          <input
            id="agent-app-rename-session"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) {
                e.preventDefault()
                void submitRename()
              }
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-strong bg-background px-3 text-sm text-foreground"
          />
        </SessionDialog>
      )}

      {deleteTarget && (
        <SessionDialog
          title={text.deleteTitle}
          onClose={() => setDeleteTarget(null)}
          busy={busy}
          error={error}
          footer={
            <>
              <DialogButton onClick={() => setDeleteTarget(null)} disabled={busy} variant="ghost">
                {text.cancel}
              </DialogButton>
              <DialogButton onClick={() => void confirmDelete()} disabled={busy} variant="destructive">
                {text.deleteSubmit}
              </DialogButton>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{text.deleteBody(sessionLabel(deleteTarget))}</p>
        </SessionDialog>
      )}
    </>
  )

  return { openRename, openDelete, dialogs, busy }
}

function DialogButton({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'destructive'
}) {
  const tone =
    variant === 'ghost'
      ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
      : variant === 'destructive'
        ? 'bg-destructive text-destructive-foreground hover:opacity-90'
        : 'bg-primary text-primary-foreground hover:opacity-90'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 rounded-md px-3 text-sm font-medium transition disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  )
}

function SessionDialog({
  title,
  children,
  footer,
  onClose,
  busy,
  error,
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  busy: boolean
  error: string | null
}) {
  // Escape closes unless a mutation is in flight — closing mid-write would hide
  // the error the user needs to see.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!busy) onClose()
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full max-w-sm rounded-xl border border-card-edge bg-popover p-5 ${OVERLAY_SHADOW}`}
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-3">{children}</div>
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SessionHistoryPanel
// ---------------------------------------------------------------------------

export interface SessionHistoryPanelProps {
  history: SessionHistoryState
  /** Whether the workspace has any sessions at all — decided by the SSR page,
   *  independent of the active search, so filtering to zero shows "no matches"
   *  rather than the first-run empty state. */
  hasAnySessions: boolean
  query: string
  onQueryChange: (value: string) => void
  sort: SessionSort
  onSortChange: (value: SessionSort) => void
  /** Product route for one session row. */
  hrefForSession: (sessionId: string) => string
  /** Rendered as the row link. Defaults to an `<a>`; pass a router Link to keep
   *  client-side navigation. */
  linkComponent?: LinkLikeComponent
  /** Ids currently mid-turn — renders the responding treatment. */
  respondingSessionIds?: ReadonlySet<string>
  onRename?: (session: SessionSummary) => void
  onDelete?: (session: SessionSummary) => void
  /** Product-owned mutation for selected rows or a workspace-wide age range. */
  onBulkAction?: (action: SessionBulkAction) => Promise<void>
  /** Menu wording, so this surface and the rail name the same act the same way
   *  — a product whose delete is really an archive says so in both places. */
  renameLabel?: string
  deleteLabel?: string
  /**
   * Row actions this shell has no opinion about — pin, categorise, share.
   * Same seam and same ordering as the rail's `SessionRowActions.extraActions`:
   * evaluated per session, placed between rename and delete. This menu is
   * text-only, so `icon` is ignored here and honoured on the rail.
   */
  extraActions?: (session: SessionSummary) => SessionRailAction[]
  /** New-session destination for the header action. Omitted ⇒ no button. */
  newSessionHref?: string
  title?: string
  untitledLabel?: string
  emptyTitle?: string
  emptyDescription?: string
  /** Absolute → relative timestamp. Defaults to a compact built-in. */
  formatTimestamp?: (isoDate: string | null) => string
  /** Max width of the reading column. `'full'` opts out for a product whose
   *  surface really is a wide table. Default keeps title and timestamp inside
   *  one scannable line rather than at opposite edges of a 1440px viewport. */
  contentWidth?: 'reading' | 'full'
  className?: string
}

export type SessionBulkAction =
  | { kind: 'selected'; ids: string[] }
  | { kind: 'older-than'; days: number }
  | { kind: 'newer-than'; days: number }

export interface LinkLikeProps {
  to: string
  className?: string
  children?: ReactNode
}

export type LinkLikeComponent = (props: LinkLikeProps) => ReactNode

function AnchorLink({ to, className, children }: LinkLikeProps) {
  return (
    <a href={to} className={className}>
      {children}
    </a>
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact relative time. Overridable — a product with its own i18n passes
 *  `formatTimestamp` rather than this being the only option. */
export function formatSessionTimestamp(isoDate: string | null): string {
  if (!isoDate) return ''
  const at = Date.parse(isoDate)
  if (Number.isNaN(at)) return ''
  const delta = Date.now() - at
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function SkeletonRows() {
  // The shimmer rows stay hidden from assistive tech — they say nothing a
  // reader can use — but the wait itself has to be announced, or the panel is
  // silent from the first paint until the rows arrive. The live region is a
  // sibling so the rows' own flex layout is untouched.
  return (
    <>
      <span role="status" aria-live="polite" aria-busy={true} className="sr-only">
        Loading sessions…
      </span>
      <div className="flex flex-col gap-0.5" aria-hidden>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <div className="h-4 w-4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </>
  )
}

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/**
 * The full session history: search, sort, cursor-paged rows with per-row
 * actions, and the states in between (first-run empty, loading, no matches,
 * error + retry).
 *
 * This is the surface the rail's capped list overflows into — the reason the
 * rail can stay short without hiding the user's work.
 */
export function SessionHistoryPanel({
  history,
  hasAnySessions,
  query,
  onQueryChange,
  sort,
  onSortChange,
  hrefForSession,
  linkComponent: Link = AnchorLink,
  respondingSessionIds,
  onRename,
  onDelete,
  onBulkAction,
  renameLabel = 'Rename',
  deleteLabel = 'Delete',
  extraActions,
  newSessionHref,
  title = 'History',
  untitledLabel = UNTITLED_SESSION_LABEL,
  emptyTitle = 'No sessions yet',
  emptyDescription = 'Your chat sessions will show up here once you start one.',
  formatTimestamp = formatSessionTimestamp,
  contentWidth = 'reading',
  className,
}: SessionHistoryPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useInfiniteScroll(history.loadMore, {
    enabled: history.hasMore && !history.isLoadingMore && !history.isError,
    root: scrollRef,
    rootMargin: '300px',
  })
  const searchTerm = query.trim()
  const isSearching = searchTerm.length > 0
  const column = contentWidth === 'full' ? 'w-full' : 'mx-auto w-full max-w-4xl'
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [ageDays, setAgeDays] = useState('30')
  const [bulkTarget, setBulkTarget] = useState<{
    action: SessionBulkAction
    title: string
    body: string
  } | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedIds(new Set())
  }, [searchTerm, sort])

  useEffect(() => {
    const visible = new Set(history.items.map((item) => item.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [history.items])

  const selectedCount = selectedIds.size
  const allVisibleSelected = history.items.length > 0 && history.items.every((item) => selectedIds.has(item.id))
  const parsedAgeDays = Number(ageDays)
  const validAgeDays = Number.isInteger(parsedAgeDays) && parsedAgeDays >= 1 && parsedAgeDays <= 36_500

  const openBulkAction = useCallback((action: SessionBulkAction) => {
    const verb = deleteLabel.toLowerCase()
    if (action.kind === 'selected') {
      setBulkTarget({
        action,
        title: `${deleteLabel} selected sessions?`,
        body: `${verb === 'delete' ? 'This permanently removes' : `This ${verb}s`} ${action.ids.length} selected session${action.ids.length === 1 ? '' : 's'} and its messages.`,
      })
      return
    }
    const range = action.kind === 'older-than' ? `older than ${action.days} days` : `from the last ${action.days} days`
    setBulkTarget({
      action,
      title: `${deleteLabel} sessions ${range}?`,
      body: 'This applies to every matching session in this workspace, including sessions not currently loaded in this list.',
    })
  }, [deleteLabel])

  const confirmBulkAction = useCallback(async () => {
    if (!bulkTarget || !onBulkAction) return
    setBulkBusy(true)
    setBulkError(null)
    try {
      await onBulkAction(bulkTarget.action)
      setBulkTarget(null)
      setSelectedIds(new Set())
      history.reload()
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : `Could not ${deleteLabel.toLowerCase()} sessions`)
    } finally {
      setBulkBusy(false)
    }
  }, [bulkTarget, deleteLabel, history, onBulkAction])

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${className ?? ''}`}>
      {/* 56px, matching the rail header the fleet aligned on. */}
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <div className={`flex items-center gap-3 px-3 ${column}`}>
        <h1 className="flex-1 truncate text-sm font-semibold text-foreground">{title}</h1>
        {newSessionHref && (
          <Link
            to={newSessionHref}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:opacity-90"
          >
            <span aria-hidden className="text-sm leading-none">+</span>
            New chat
          </Link>
        )}
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {hasAnySessions && (
          <div className="sticky top-0 z-10 bg-background px-4 sm:px-6">
            <div className={`flex flex-col gap-2 px-3 pb-3 pt-4 sm:flex-row sm:items-center sm:gap-3 ${column}`}>
              <input
                type="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Search your sessions…"
                aria-label="Search sessions"
                className="h-9 min-w-0 appearance-none rounded-md border border-strong bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground sm:flex-1 [&::-webkit-search-cancel-button]:appearance-none"
              />
              <select
                value={sort}
                onChange={(e) => onSortChange(e.target.value as SessionSort)}
                aria-label="Sort sessions"
                className="h-9 shrink-0 appearance-none rounded-md border border-strong bg-card px-2 text-sm text-foreground sm:w-[132px]"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </div>
            {onBulkAction && (
              <div className={`flex flex-col gap-2 border-t border-border px-3 py-3 ${column}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(history.items.map((item) => item.id)))}
                    disabled={allVisibleSelected || history.items.length === 0}
                    className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    disabled={selectedCount === 0}
                    className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    Deselect all
                  </button>
                  <span className="text-xs text-muted-foreground" aria-live="polite">
                    {selectedCount} selected
                  </span>
                  {selectedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => openBulkAction({ kind: 'selected', ids: [...selectedIds] })}
                      className="h-8 rounded-md bg-destructive px-2.5 text-xs font-medium text-destructive-foreground transition hover:opacity-90"
                    >
                      {deleteLabel} selected
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="agent-app-session-age" className="text-xs text-muted-foreground">
                    Session age
                  </label>
                  <input
                    id="agent-app-session-age"
                    type="number"
                    min={1}
                    max={36_500}
                    value={ageDays}
                    onChange={(event) => setAgeDays(event.target.value)}
                    aria-invalid={ageDays.length > 0 && !validAgeDays}
                    className="h-8 w-20 rounded-md border border-strong bg-card px-2 text-xs tabular-nums text-foreground"
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                  <button
                    type="button"
                    onClick={() => openBulkAction({ kind: 'older-than', days: parsedAgeDays })}
                    disabled={!validAgeDays}
                    className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    {deleteLabel} older
                  </button>
                  <button
                    type="button"
                    onClick={() => openBulkAction({ kind: 'newer-than', days: parsedAgeDays })}
                    disabled={!validAgeDays}
                    className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    {deleteLabel} recent
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className={`px-4 pb-8 pt-1 sm:px-6 ${column}`}>
          {!hasAnySessions ? (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
              <p className="max-w-xs text-xs text-muted-foreground">{emptyDescription}</p>
            </div>
          ) : history.isLoadingFirst ? (
            <SkeletonRows />
          ) : history.items.length === 0 ? (
            history.isError ? (
              <ErrorBlock onRetry={history.retry} message="Couldn’t load your sessions." />
            ) : isSearching ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No sessions match “{searchTerm}”.
              </p>
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No sessions remain.</p>
            )
          ) : (
            <div className="flex flex-col gap-0.5">
              {history.items.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  href={hrefForSession(session.id)}
                  Link={Link}
                  responding={respondingSessionIds?.has(session.id) ?? false}
                  untitledLabel={untitledLabel}
                  timestamp={formatTimestamp(session.updatedAt)}
                  onRename={onRename}
                  onDelete={onDelete}
                  selectable={Boolean(onBulkAction)}
                  selected={selectedIds.has(session.id)}
                  onSelectedChange={(selected) => {
                    setSelectedIds((current) => {
                      const next = new Set(current)
                      if (selected) next.add(session.id)
                      else next.delete(session.id)
                      return next
                    })
                  }}
                  renameLabel={renameLabel}
                  deleteLabel={deleteLabel}
                  extraActions={extraActions}
                />
              ))}

              {history.isError ? (
                <ErrorBlock onRetry={history.retry} message="Couldn’t load more sessions." inline />
              ) : history.hasMore ? (
                <div ref={sentinelRef} className="flex items-center justify-center py-6">
                  {history.isLoadingMore && (
                    <span role="status" aria-live="polite" aria-busy={true} className="text-xs text-muted-foreground">
                      Loading…
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {bulkTarget && (
        <SessionDialog
          title={bulkTarget.title}
          onClose={() => {
            if (!bulkBusy) {
              setBulkTarget(null)
              setBulkError(null)
            }
          }}
          busy={bulkBusy}
          error={bulkError}
          footer={
            <>
              <DialogButton
                onClick={() => {
                  setBulkTarget(null)
                  setBulkError(null)
                }}
                disabled={bulkBusy}
                variant="ghost"
              >
                Cancel
              </DialogButton>
              <DialogButton onClick={() => void confirmBulkAction()} disabled={bulkBusy} variant="destructive">
                {bulkBusy ? 'Working…' : deleteLabel}
              </DialogButton>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{bulkTarget.body}</p>
        </SessionDialog>
      )}
    </div>
  )
}

function ErrorBlock({ message, onRetry, inline }: { message: string; onRetry: () => void; inline?: boolean }) {
  return (
    <div
      className={
        inline
          ? 'flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground'
          : 'flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center'
      }
    >
      <span className="text-sm text-muted-foreground">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent"
      >
        Retry
      </button>
    </div>
  )
}

function SessionRow({
  session,
  href,
  Link,
  responding,
  untitledLabel,
  timestamp,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  extraActions,
  selectable,
  selected,
  onSelectedChange,
}: {
  session: SessionSummary
  href: string
  Link: LinkLikeComponent
  responding: boolean
  untitledLabel: string
  timestamp: string
  onRename?: (session: SessionSummary) => void
  onDelete?: (session: SessionSummary) => void
  renameLabel: string
  deleteLabel: string
  extraActions?: (session: SessionSummary) => SessionRailAction[]
  selectable: boolean
  selected: boolean
  onSelectedChange: (selected: boolean) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const panelId = useId()
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(menuOpen, setMenuOpen)
  const extras = extraActions?.(session) ?? []
  const hasMenu = Boolean(onRename) || Boolean(onDelete) || extras.length > 0
  // An unread dot next to a live responding indicator is two signals for one
  // state; the working indicator wins while the turn runs.
  const showUnread = Boolean(session.unread) && !responding

  return (
    <div className={`group relative flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent ${selected ? 'bg-primary/10' : ''}`}>
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelectedChange(event.target.checked)}
          aria-label={`Select ${sessionLabel(session, untitledLabel)}`}
          className="h-4 w-4 shrink-0 rounded border-border accent-primary"
        />
      )}
      <Link to={href} className="flex min-w-0 flex-1 items-center gap-3">
        {showUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
        <MessageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={`truncate text-sm ${responding ? 'text-muted-foreground' : 'text-foreground'} ${showUnread ? 'font-semibold' : ''}`}
          {...(responding ? { role: 'status', 'aria-label': 'Agent responding' } : {})}
        >
          {sessionLabel(session, untitledLabel)}
        </span>
      </Link>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timestamp}</span>
      {hasMenu && (
        <div ref={containerRef} className="relative shrink-0">
          <button
            type="button"
            {...triggerProps}
            aria-label="Session actions"
            aria-controls={menuOpen ? panelId : undefined}
            onClick={() => setMenuOpen((open) => !open)}
            // Visible by default and hover-revealed only from `sm:` up: a
            // touch device has no hover, so an opacity-0 kebab is an action
            // the user can never reach.
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 aria-expanded:opacity-100"
          >
            <span aria-hidden className="text-base leading-none">⋯</span>
          </button>
          <PopoverSurface
            open={menuOpen}
            id={panelId}
            role="menu"
            triggerRef={triggerRef}
            panelRef={panelRef}
            className={`w-36 overflow-hidden rounded-md border border-card-edge bg-popover py-1 ${OVERLAY_SHADOW}`}
          >
            {onRename && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRename(session)
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
              >
                {renameLabel}
              </button>
            )}
            {extras.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  action.onSelect()
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs transition ${
                  action.destructive
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-foreground hover:bg-accent'
                }`}
              >
                {action.label}
              </button>
            ))}
            {onDelete && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete(session)
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-destructive transition hover:bg-destructive/10"
              >
                {deleteLabel}
              </button>
            )}
          </PopoverSurface>
        </div>
      )}
    </div>
  )
}
