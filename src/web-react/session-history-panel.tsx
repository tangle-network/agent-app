/** History search, rows, and bulk actions over caller-owned session data. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { sessionLabel, UNTITLED_SESSION_LABEL, type SessionRailAction, type SessionSort, type SessionSummary } from '../session-shell/index'
import { Button, Checkbox, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tangle-network/ui/primitives'
import { ShellHeader } from '@tangle-network/sandbox-ui/workspace'
import { ActionDialog, ActionDialogButton } from './action-dialog'
import { OVERLAY_SHADOW, PopoverSurface, usePopover } from './controls'
import { useInfiniteScroll } from './use-infinite-scroll'
import type { SessionHistoryState } from './use-session-history'

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
  /**
   * Draw the panel's own ShellHeader row (title and New chat). `false` for a host
   * that already gives the page its header, such as sandbox-ui `WorkspaceSurface`,
   * so the page keeps one header row.
   */
  showHeader?: boolean
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
function useSessionHistoryPanelViewState({
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
  showHeader = true,
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
  return { className, showHeader, column, title, newSessionHref, Link, scrollRef, hasAnySessions,
    query, onQueryChange, sort, onSortChange, onBulkAction, setSelectedIds, history,
    allVisibleSelected, selectedCount, openBulkAction, selectedIds, deleteLabel, ageDays, setAgeDays,
    validAgeDays, parsedAgeDays, emptyTitle, emptyDescription, isSearching, searchTerm, hrefForSession,
    respondingSessionIds, untitledLabel, formatTimestamp, onRename, onDelete, renameLabel,
    extraActions, sentinelRef, bulkTarget, bulkBusy, setBulkTarget, setBulkError, bulkError, confirmBulkAction }
}

type SessionHistoryPanelViewState = ReturnType<typeof useSessionHistoryPanelViewState>

export function SessionHistoryPanel(props: SessionHistoryPanelProps) {
  const view = useSessionHistoryPanelViewState(props)
  return <SessionHistoryPanelView {...view} />
}

function SessionHistoryPanelView({ className, showHeader, column, title, newSessionHref, Link,
  scrollRef, hasAnySessions, query, onQueryChange, sort, onSortChange, onBulkAction, setSelectedIds,
  history, allVisibleSelected, selectedCount, openBulkAction, selectedIds, deleteLabel, ageDays,
  setAgeDays, validAgeDays, parsedAgeDays, emptyTitle, emptyDescription, isSearching, searchTerm,
  hrefForSession, respondingSessionIds, untitledLabel, formatTimestamp, onRename, onDelete,
  renameLabel, extraActions, sentinelRef, bulkTarget, bulkBusy, setBulkTarget, setBulkError,
  bulkError, confirmBulkAction }: SessionHistoryPanelViewState) {
  return ((
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${className ?? ''}`}>
      {/* A ShellHeader row, so its divider continues the rail's. */}
      {showHeader && (
      <ShellHeader as="header" className="bg-transparent px-4 sm:px-6">
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
      </ShellHeader>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {hasAnySessions && (
          <div className="sticky top-0 z-10 bg-background px-4 sm:px-6">
            <div className={`flex flex-col gap-2 px-3 pb-3 pt-4 sm:flex-row sm:items-center sm:gap-3 ${column}`}>
              <Input
                type="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Search your sessions…"
                aria-label="Search sessions"
                className="sm:flex-1 [&::-webkit-search-cancel-button]:appearance-none"
              />
              <Select value={sort} onValueChange={(value) => onSortChange(value as SessionSort)}>
                <SelectTrigger aria-label="Sort sessions" className="shrink-0 sm:w-[132px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {onBulkAction && (
              <div className={`flex flex-col gap-2 border-t border-border px-3 py-3 ${column}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedIds(new Set(history.items.map((item) => item.id)))}
                    disabled={allVisibleSelected || history.items.length === 0}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedIds(new Set())}
                    disabled={selectedCount === 0}
                  >
                    Deselect all
                  </Button>
                  {selectedCount > 0 && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => openBulkAction({ kind: 'selected', ids: [...selectedIds] })}
                    >
                      {deleteLabel} selected
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="agent-app-session-age" className="text-xs text-muted-foreground">
                    Session age
                  </label>
                  <Input
                    id="agent-app-session-age"
                    type="number"
                    min={1}
                    max={36_500}
                    value={ageDays}
                    onChange={(event) => setAgeDays(event.target.value)}
                    aria-invalid={ageDays.length > 0 && !validAgeDays}
                    size="sm"
                    className="w-20 tabular-nums"
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openBulkAction({ kind: 'older-than', days: parsedAgeDays })}
                    disabled={!validAgeDays}
                  >
                    {deleteLabel} older
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openBulkAction({ kind: 'newer-than', days: parsedAgeDays })}
                    disabled={!validAgeDays}
                  >
                    {deleteLabel} recent
                  </Button>
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
        <ActionDialog
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
              <ActionDialogButton
                onClick={() => {
                  setBulkTarget(null)
                  setBulkError(null)
                }}
                disabled={bulkBusy}
                variant="ghost"
              >
                Cancel
              </ActionDialogButton>
              <ActionDialogButton onClick={() => void confirmBulkAction()} disabled={bulkBusy} variant="destructive">
                {bulkBusy ? 'Working…' : deleteLabel}
              </ActionDialogButton>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{bulkTarget.body}</p>
        </ActionDialog>
      )}
    </div>
  ))
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
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
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
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${sessionLabel(session, untitledLabel)}`}
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            {...triggerProps}
            aria-label="Session actions"
            aria-controls={menuOpen ? panelId : undefined}
            onClick={() => setMenuOpen((open) => !open)}
            // Visible by default and hover-revealed only from `sm:` up: a
            // touch device has no hover, so an opacity-0 kebab is an action
            // the user can never reach.
            className="text-muted-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 aria-expanded:opacity-100"
          >
            <span aria-hidden className="text-base leading-none">⋯</span>
          </Button>
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
