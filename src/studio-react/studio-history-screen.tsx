/**
 * The studio history screen — the full media library behind the home screen's
 * "View history" button: search, a media-type filter, cursor-paged infinite
 * scroll, and the multi-select bar that runs download / save-to-vault / delete
 * over a whole selection at once.
 *
 * It ASSUMES a `StudioToastProvider` and a `StudioPlaybackProvider` above it —
 * the deferred delete it drives lives in both (undo toast, stopping audio for a
 * row that is going away), and every screen in this surface makes the same
 * assumption so a route layout can mount the two providers once.
 *
 * The screen never fetches: `fetchPage` is the product's own paged endpoint and
 * `actions` are its media seams. An ABSENT action hides its control rather than
 * rendering a batch button that does nothing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type JSX,
} from 'react'
import {
  ArrowLeft,
  AudioLines,
  Download,
  FolderPlus,
  Image,
  LayoutGrid,
  Search,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react'

import type { Generation } from '../studio/generation'
import {
  MEDIA_TYPE_FILTERS,
  type FetchGenerationsPage,
  type GenerationPage,
  type MediaTypeFilter,
  type StudioMediaActions,
  type VaultSaveResult,
} from '../studio/ports'
import { POPOVER_SURFACE_ATTR, usePopover } from '../web-react/controls'
import { useInfiniteScroll } from '../web-react/session-history'
import { MenuPill } from './composer-option-controls'
import { downloadGenerationsViaAnchor } from './download-generations'
import { MediaTile } from './media-tile'
import { MediaViewerModal } from './media-viewer'
import { StudioConfirmDialog } from './studio-confirm'
import { useStudioPlayback } from './studio-playback'
import { useStudioToast } from './studio-toasts'
import { useDeferredDelete } from './use-deferred-delete'
import { useGenerationHistory } from './use-generation-history'
import { VaultPathPopover } from './vault-path-popover'

export interface StudioHistoryScreenProps {
  fetchPage: FetchGenerationsPage
  /** SSR/loader page 1 for the DEFAULT view (no search, no type filter). */
  initialPage?: GenerationPage
  onBack: () => void
  actions?: StudioMediaActions
  /** Trailing debounce before a keystroke becomes a fetch. */
  searchDebounceMs?: number
  className?: string
}

/** How many cells the first load and each subsequent page stand in for. */
const FIRST_LOAD_SKELETONS = 8
const MORE_SKELETONS = 4

const BAR = 'flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-6 pb-[18px] pt-0.5 max-[900px]:px-4'
const SEARCH_INPUT = 'h-8 w-[260px] max-w-[52vw] rounded-full border border-border bg-card pl-8 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-ring/30 max-[640px]:w-full max-[640px]:max-w-none'
const OUTLINE_PILL = 'inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40'

const FILTER_ICONS: Record<MediaTypeFilter, LucideIcon> = {
  all: LayoutGrid,
  image: Image,
  video: Video,
  speech: AudioLines,
}
const FILTER_CHOICES = MEDIA_TYPE_FILTERS.map((choice) => ({
  ...choice,
  icon: FILTER_ICONS[choice.value],
}))

/** The empty-state plural for a type filter, in the filter's own words. */
const TYPE_NOUNS: Record<Exclude<MediaTypeFilter, 'all'>, string> = {
  image: 'images',
  video: 'videos',
  speech: 'audio',
}

type SkeletonStyle = CSSProperties & { '--r'?: number }
/** `.studio-skeleton` defaults to the 3:2 generation ratio; the library grid is
 *  square, and the ratio is a custom property rather than a utility because a
 *  Tailwind `aspect-*` class ties with the stylesheet rule on specificity. */
const SQUARE_CELL: SkeletonStyle = { '--r': 1 }

function skeletonCells(count: number, keyPrefix: string) {
  return Array.from({ length: count }, (_, index) => (
    <div key={`${keyPrefix}-${index}`} className="studio-skeleton" style={SQUARE_CELL} aria-hidden />
  ))
}

function hasOpenPopover(): boolean {
  return typeof document !== 'undefined' && document.querySelector(`[${POPOVER_SURFACE_ATTR}]`) !== null
}

export function StudioHistoryScreen({
  fetchPage,
  initialPage,
  onBack,
  actions,
  searchDebounceMs = 250,
  className,
}: StudioHistoryScreenProps): JSX.Element {
  const playback = useStudioPlayback()
  const { stop } = playback
  const { toast } = useStudioToast()

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [type, setType] = useState<MediaTypeFilter>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [viewer, setViewer] = useState<Generation | null>(null)
  const [confirmTargets, setConfirmTargets] = useState<Generation[] | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [savePending, setSavePending] = useState(false)
  const savePopover = usePopover(saveOpen, setSaveOpen)

  // Trailing debounce. Clearing the search sets both halves at once, and the
  // equality guard is what keeps that from scheduling a redundant timer.
  useEffect(() => {
    if (query === debouncedQuery) return
    const timer = window.setTimeout(() => setDebouncedQuery(query), searchDebounceMs)
    return () => window.clearTimeout(timer)
  }, [debouncedQuery, query, searchDebounceMs])

  const history = useGenerationHistory({ fetchPage, q: debouncedQuery, type, initialPage })
  const deferredDelete = useDeferredDelete({
    remove: actions?.remove ?? (async () => {}),
    // Nothing to reload: `pendingIds` already hides the rows and the server has
    // dropped them. A refetch here would only re-request the page we can see.
  })
  const { pendingIds } = deferredDelete
  const rows = useMemo(
    () => history.items.filter((item) => !pendingIds.has(item.id)),
    [history.items, pendingIds],
  )
  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.id)), [rows, selected])

  useEffect(() => {
    if (history.isLoadingFirst || history.isLoadingMore || !playback.activeId) return
    if (rows.some((row) => row.id === playback.activeId) || viewer?.id === playback.activeId) return
    playback.stop()
  }, [history.isLoadingFirst, history.isLoadingMore, playback, rows, viewer])

  const sentinelRef = useInfiniteScroll(history.loadMore, {
    enabled: history.hasMore && !history.isLoadingMore && !history.isLoadingFirst && !history.isError,
  })

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelected(new Set())
    setSaveOpen(false)
  }, [])

  const toggleSelect = useCallback((id: string) => {
    if (!selectMode) {
      // Entering select mode hides every tile's play button, so a clip playing
      // underneath would have no control left to stop it.
      stop()
      setSelectMode(true)
      setSelected(new Set([id]))
      return
    }
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [selectMode, stop])

  // The residual Escape: the confirm dialog, the viewer and every popover close
  // themselves, so this handler exists only for the case none of them owns —
  // leaving select mode. It checks for those overlays rather than assuming an
  // order, because two document listeners see the same keydown.
  useEffect(() => {
    if (!selectMode) return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (confirmTargets || viewer || hasOpenPopover()) return
      event.preventDefault()
      exitSelectMode()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirmTargets, exitSelectMode, selectMode, viewer])

  useEffect(() => () => stop(), [stop])

  const clearFilters = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
    setType('all')
  }, [])

  const onSaved = useCallback((results: readonly VaultSaveResult[]) => {
    const path = results[0]?.vaultPath
    if (!path) return
    toast({
      message: results.length > 1
        ? `Saved ${results.length} items to vault · ${path}`
        : `Saved to vault · ${path}`,
    })
  }, [toast])

  function batchDownload() {
    void (actions?.download ?? downloadGenerationsViaAnchor)(selectedRows)
    exitSelectMode()
  }

  async function batchSave(path: string) {
    if (!actions?.save) return
    setSavePending(true)
    try {
      const results = await actions.save({ generations: selectedRows, path })
      setSaveOpen(false)
      onSaved(results)
      exitSelectMode()
    } finally {
      setSavePending(false)
    }
  }

  function confirmDelete() {
    const targets = confirmTargets ?? []
    setConfirmTargets(null)
    if (targets.length === 0) return
    if (viewer && targets.some((target) => target.id === viewer.id)) setViewer(null)
    deferredDelete.request(targets)
    exitSelectMode()
  }

  const viewerRow = viewer ? rows.find((row) => row.id === viewer.id) ?? viewer : null
  const searchTerm = debouncedQuery.trim()
  const isFiltered = query !== '' || debouncedQuery !== '' || type !== 'all'
  const emptyCopy = searchTerm
    ? {
      title: `No media matches “${searchTerm}”.`,
      body: 'Try a shorter word, or drop the type filter.',
    }
    : type !== 'all'
      ? {
        title: `No ${TYPE_NOUNS[type]} yet.`,
        body: 'Generate one from the Studio composer and it will show up here.',
      }
      : {
        title: 'Your history is empty.',
        body: 'Everything you generate is kept here until you delete it.',
      }

  return (
    <div className={`studio-hist-wrap pb-[72px] ${className ?? ''}`}>
      {selectMode ? (
        <div className={BAR}>
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            <button
              type="button"
              aria-label="Exit select mode"
              onClick={exitSelectMode}
              className="grid h-[26px] w-[26px] place-items-center rounded-full hover:bg-accent"
            >
              <X size={15} strokeWidth={1.5} />
            </button>
            {selected.size} selected
          </div>

          <div role="toolbar" aria-label="Selection actions" className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={batchDownload}
              className={OUTLINE_PILL}
            >
              <Download size={16} strokeWidth={1.5} /> Download
            </button>

            {actions?.save && (
              <div ref={savePopover.containerRef} className="inline-flex">
                <button
                  {...savePopover.triggerProps}
                  type="button"
                  disabled={selected.size === 0}
                  onClick={() => setSaveOpen(!saveOpen)}
                  className={OUTLINE_PILL}
                >
                  <FolderPlus size={16} strokeWidth={1.5} /> Save to vault
                </button>
                <VaultPathPopover
                  open={saveOpen}
                  triggerRef={savePopover.triggerRef}
                  panelRef={savePopover.panelRef}
                  generations={selectedRows}
                  onSubmit={batchSave}
                  onCancel={() => setSaveOpen(false)}
                  pending={savePending}
                />
              </div>
            )}

            {actions?.remove && (
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() => setConfirmTargets(selectedRows)}
                className={`${OUTLINE_PILL} text-destructive hover:border-destructive hover:bg-destructive/10`}
              >
                <Trash2 size={16} strokeWidth={1.5} /> Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={BAR}>
          <button
            type="button"
            aria-label="Back to Studio"
            onClick={onBack}
            className="grid h-8 w-8 flex-none place-items-center rounded-full border border-border bg-card shadow-sm hover:bg-accent"
          >
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>

          <div className="ml-auto flex flex-wrap items-center gap-2 max-[640px]:w-full">
            <div className="relative inline-flex items-center max-[640px]:flex-1 max-[640px]:basis-[160px]">
              <Search
                size={15}
                strokeWidth={1.5}
                aria-hidden
                className="pointer-events-none absolute left-[11px] text-muted-foreground"
              />
              <input
                type="text"
                value={query}
                placeholder="Search"
                aria-label="Search prompts"
                onChange={(event) => setQuery(event.target.value)}
                className={SEARCH_INPUT}
              />
            </div>

            <MenuPill
              label="Filter by media type"
              value={type}
              choices={FILTER_CHOICES}
              onSelect={setType}
              trigger="text"
            />
          </div>
        </div>
      )}

      {history.isError && rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center max-[900px]:px-4">
          <p className="text-[14px] text-foreground">Could not load media.</p>
          <button type="button" onClick={history.retry} className={OUTLINE_PILL}>Retry</button>
        </div>
      ) : history.isLoadingFirst && rows.length === 0 ? (
        <div className="studio-grid studio-grid-library">
          {skeletonCells(FIRST_LOAD_SKELETONS, 'first')}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-6 py-16 text-center max-[900px]:px-4">
          <p className="text-[14px] text-foreground">{emptyCopy.title}</p>
          <p className="max-w-[380px] text-[13px] text-muted-foreground">{emptyCopy.body}</p>
          {isFiltered && (
            <button type="button" onClick={clearFilters} className={`${OUTLINE_PILL} mt-2`}>Clear</button>
          )}
        </div>
      ) : (
        <div className={selectMode ? 'studio-selectmode' : undefined}>
          <div className="studio-grid studio-grid-library">
            {rows.map((row) => (
              <MediaTile
                key={row.id}
                generation={row}
                context="history"
                onOpen={setViewer}
                actions={actions}
                selectMode={selectMode}
                selected={selected.has(row.id)}
                onToggleSelect={toggleSelect}
                onRequestDelete={actions?.remove ? (generation) => setConfirmTargets([generation]) : undefined}
                onSaved={onSaved}
              />
            ))}
            {history.isLoadingMore && skeletonCells(MORE_SKELETONS, 'more')}
          </div>
        </div>
      )}

      {history.isError && rows.length > 0 && (
        <div className="flex items-center justify-center gap-3 px-6 py-4 text-[13px] text-muted-foreground max-[900px]:px-4">
          <span>Could not load more media.</span>
          <button type="button" onClick={history.retry} className={OUTLINE_PILL}>Retry</button>
        </div>
      )}

      <div ref={sentinelRef} aria-hidden />

      <MediaViewerModal
        generation={viewerRow}
        onClose={() => setViewer(null)}
        actions={actions}
        onRequestDelete={actions?.remove ? (generation) => setConfirmTargets([generation]) : undefined}
        onSaved={onSaved}
      />

      <StudioConfirmDialog
        open={confirmTargets !== null}
        count={confirmTargets?.length ?? 0}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmTargets(null)}
      />
    </div>
  )
}
