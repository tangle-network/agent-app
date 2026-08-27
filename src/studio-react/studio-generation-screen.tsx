/**
 * The generation screen: ONE batch's results, with the composer docked under
 * them.
 *
 * The screen is a flex column that fills its host — results scroll, the dock
 * does not. The dock band is deliberately OPAQUE (`bg-background`): it sits
 * above the scrolling results and a translucent band would let a tile read
 * through the composer's own card. The 28px fade above it comes from
 * `.studio-dock::before` in `./studio.css`.
 *
 * The dock's measured height is published two ways, because two different
 * consumers need it: as the `--studio-dock-h` custom property on the screen
 * root (host CSS, and anything nested that must clear the band) and through
 * `useStudioToast().setDockLift`, which lifts the toast stack off the composer.
 * The body's own bottom padding is applied from the measured value directly
 * rather than read back through that property — a CSS custom property a
 * component READS must be one `tokens.css` defines (the theme contract), and a
 * dock height is a layout measurement, not a theme token.
 *
 * A prompt sent from the DOCK starts a NEW batch, which is a different screen.
 * This one reports it (`onOpenGeneration`) exactly once per new batch key and
 * lets the host navigate; every row of that batch still flows through
 * `onGenerated` so the host's list stays whole.
 *
 * The root bakes in `min-h-full` so the sticky composer dock sits at the bottom
 * of the nearest scroll container. A `min-h-*` utility passed through
 * `className` will not reliably win: equal specificity lets the later-in-sheet
 * `.min-h-full` rule take precedence. Do not make this root its own scroll
 * container through `className`; wrap the screen in a
 * `min-h-0 flex-1 overflow-y-auto` container and let the root fill it instead
 * (issue #465, item 5).
 *
 * Assumes a `StudioToastProvider` and a `StudioPlaybackProvider` above it.
 */

import { CircleAlert } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react'

import {
  generationAspectRatio,
  generationError,
  generationStatus,
  generationsInBatch,
  WIDE_WAVEFORM_BARS,
  type DeleteGenerations,
  type Generation,
  type StudioMediaActions,
  type VaultSaveResult,
} from '../studio'
import { GenerationNoticeChip } from './generation-notice'
import { MediaTile } from './media-tile'
import { MediaViewerModal } from './media-viewer'
import { StudioComposer } from './studio-composer'
import { StudioConfirmDialog } from './studio-confirm'
import { useStudioPlayback } from './studio-playback'
import { useStudioToast } from './studio-toasts'
import { useBatchNavigation } from './use-batch-navigation'
import { useDeferredDelete } from './use-deferred-delete'
import { useVaultSaveState } from './use-vault-save-state'

export interface StudioGenerationScreenProps {
  /** Full merged list from the host (`useStudioGenerations`). */
  generations: Generation[]
  batchKey: string
  onGenerated: (generation: Generation) => void
  /** A dock submit that starts a NEW batch navigates via the host. */
  onOpenGeneration: (batchKey: string, first: Generation) => void
  workspaceId?: string
  pickReferenceImage?: () => Promise<string | null>
  actions?: StudioMediaActions
  className?: string
}

type SkeletonStyle = CSSProperties & { '--r'?: number }

/** What the body clears before the dock has ever been measured. */
const FALLBACK_DOCK_HEIGHT = 190

/** `useDeferredDelete` needs a remover unconditionally; with no `remove` seam
 *  no delete control is rendered, so this is never reached. */
const noRemove: DeleteGenerations = async () => {}

function isRunning(generation: Generation): boolean {
  const status = generationStatus(generation)
  return status === 'pending' || status === 'running'
}

export function StudioGenerationScreen({
  generations,
  batchKey,
  onGenerated,
  onOpenGeneration,
  workspaceId,
  pickReferenceImage,
  actions,
  className,
}: StudioGenerationScreenProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const { setDockLift, toast } = useStudioToast()
  const { stop } = useStudioPlayback()
  const stopRef = useRef(stop)
  stopRef.current = stop

  const [dockHeight, setDockHeight] = useState(FALLBACK_DOCK_HEIGHT)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Generation | null>(null)
  const { generations: savedGenerations, applySaveResults } = useVaultSaveState(generations)

  const remove = actions?.remove
  const { pendingIds, request } = useDeferredDelete({ remove: remove ?? noRemove })

  const rows = useMemo(
    () => generationsInBatch(savedGenerations, batchKey).filter((row) => !pendingIds.has(row.id)),
    [batchKey, pendingIds, savedGenerations],
  )
  const first = rows[0]
  const prompt = first?.prompt ?? ''
  const ratio = first ? generationAspectRatio(first) : 1.5
  const runningCount = rows.filter(isRunning).length

  // The rise stagger counts SETTLED rows only, so a batch whose slots finish out
  // of order still lands 60ms apart instead of inheriting a skeleton's slot.
  const settledOrder = new Map<string, number>()
  for (const row of rows) if (!isRunning(row)) settledOrder.set(row.id, settledOrder.size)

  const columns = rows.length === 4 ? 2 : Math.min(rows.length, 4) || 1
  // A lone image is sized like ONE tile of a two-up row (820 less the 3px gap,
  // halved) so a single picture never dominates the canvas. Video and speech
  // keep the wider band: a player is watched, not scanned next to siblings.
  const maxWidth = rows.length > 1 || first?.type === 'speech'
    ? 820
    : first?.type !== 'image' ? 640
    : ratio < 1 ? 380 : 408

  const viewerGeneration = viewerId ? rows.find((row) => row.id === viewerId) ?? null : null

  const onSaved = useCallback((results: readonly VaultSaveResult[]) => {
    applySaveResults(results)
    const saved = results[0]
    if (saved) toast({ message: `Saved to vault · ${saved.vaultPath}` })
  }, [applySaveResults, toast])

  const navigateNewBatch = useBatchNavigation({ seed: [], currentBatchKey: batchKey, onOpenGeneration })
  const handleGenerated = useCallback((generation: Generation) => {
    onGenerated(generation)
    navigateNewBatch(generation)
  }, [navigateNewBatch, onGenerated])

  useEffect(() => {
    const dock = dockRef.current
    if (!dock) return
    const apply = (height: number) => {
      // A zero reading means "not laid out yet" (jsdom, a hidden host); publishing
      // it would collapse the body's clearance onto a dock that is really there.
      if (height <= 0) return
      rootRef.current?.style.setProperty('--studio-dock-h', `${height}px`)
      setDockHeight(height)
      setDockLift(height)
    }
    const measure = () => apply(dock.getBoundingClientRect().height)
    measure()
    // jsdom and older browsers have no ResizeObserver; the window listener still
    // covers the case that matters (the viewport getting narrower).
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => apply(entries[0]?.contentRect.height ?? dock.getBoundingClientRect().height))
    observer?.observe(dock)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      setDockLift(null)
    }
  }, [setDockLift])

  // Leaving the screen stops whatever it was playing — the audio element lives
  // in the provider ABOVE this component and would otherwise keep going.
  useEffect(() => () => stopRef.current(), [])

  function confirmDelete(): void {
    if (!deleteTarget) return
    request([deleteTarget])
    if (viewerId === deleteTarget.id) setViewerId(null)
    setDeleteTarget(null)
  }

  return (
    <div ref={rootRef} className={`flex min-h-full flex-col ${className ?? ''}`}>
      <header className="studio-gen-head mx-auto flex w-full max-w-[868px] justify-end px-6 pb-4 pt-1 max-[900px]:px-4">
        <p
          title={prompt}
          className="min-w-0 max-w-full truncate rounded-full border border-border bg-card px-4 py-2 text-[14px] shadow-sm"
        >
          {prompt}
        </p>
      </header>

      <div
        className="studio-gen-body flex-1 px-6 max-[900px]:px-4"
        style={{ paddingBottom: `${dockHeight + 16}px` }}
      >
        {rows.length === 0 ? (
          <div className="mx-auto flex max-w-[520px] flex-col items-center gap-1 py-16 text-center">
            <p className="text-[14px]">Nothing left from this generation.</p>
            <p className="text-[13px] text-muted-foreground">Send another prompt below to start a new one.</p>
          </div>
        ) : (
          <>
            <div
              className="mx-auto grid gap-[3px]"
              aria-busy={runningCount > 0}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxWidth }}
            >
              {rows.map((row) => {
                if (isRunning(row)) {
                  return <div key={row.id} className="studio-skeleton" style={{ '--r': ratio } as SkeletonStyle} />
                }
                // A failed row is NOT a tile: `MediaTile` reads a null result as
                // "still running" and draws a skeleton, which would leave a dead
                // slot sweeping for ever. The cell states the reason instead.
                if (generationStatus(row) === 'failed') {
                  const reason = generationError(row)
                  return (
                    <div
                      key={row.id}
                      className="flex flex-col items-center justify-center gap-1.5 bg-accent p-3 text-center"
                      style={{ aspectRatio: ratio }}
                    >
                      <CircleAlert aria-hidden className="h-4 w-4 flex-none text-destructive" strokeWidth={2} />
                      <p className="text-[13px] font-medium text-foreground">Generation failed</p>
                      {reason && reason !== 'Generation failed' && (
                        <p className="line-clamp-3 text-[12px] text-muted-foreground">{reason}</p>
                      )}
                    </div>
                  )
                }
                return (
                  <div
                    key={row.id}
                    className="studio-rise"
                    style={{ animationDelay: `${(settledOrder.get(row.id) ?? 0) * 60}ms` }}
                  >
                    <MediaTile
                      generation={row}
                      context="generation"
                      aspectRatio={ratio}
                      waveformBars={WIDE_WAVEFORM_BARS}
                      actions={actions}
                      onOpen={(generation) => setViewerId(generation.id)}
                      onRequestDelete={remove ? setDeleteTarget : undefined}
                      onSaved={onSaved}
                    />
                  </div>
                )
              })}
            </div>
            {runningCount > 0 && (
              <p className="sr-only" aria-live="polite">
                Generating {runningCount} result{runningCount > 1 ? 's' : ''}…
              </p>
            )}
          </>
        )}
      </div>

      <div
        ref={dockRef}
        className="studio-dock sticky bottom-0 z-[5] bg-background px-6 pb-[18px] pt-4 max-[900px]:px-4"
      >
        <div className="mx-auto w-full max-w-[820px]">
          <div className="mb-2.5 flex justify-center">
            <GenerationNoticeChip />
          </div>
          <StudioComposer
            variant="docked"
            workspaceId={workspaceId}
            pickReferenceImage={pickReferenceImage}
            onGenerated={handleGenerated}
          />
        </div>
      </div>

      <MediaViewerModal
        generation={viewerGeneration}
        onClose={() => setViewerId(null)}
        actions={actions}
        onRequestDelete={remove ? setDeleteTarget : undefined}
        onSaved={onSaved}
      />
      <StudioConfirmDialog
        open={deleteTarget !== null}
        count={1}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
