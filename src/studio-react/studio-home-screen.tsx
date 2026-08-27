import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import type { Generation } from '../studio/generation'
import type { StudioMediaActions, VaultSaveResult } from '../studio/ports'
import { MediaTile } from './media-tile'
import { MediaViewerModal } from './media-viewer'
import { StudioComposer, type StudioComposerProps } from './studio-composer'
import { StudioConfirmDialog } from './studio-confirm'
import { useStudioPlayback } from './studio-playback'
import { useStudioToast } from './studio-toasts'
import { useBatchNavigation } from './use-batch-navigation'
import { useDeferredDelete } from './use-deferred-delete'

export interface StudioHomeScreenProps {
  /** Newest first, from the host loader (host runs useStudioGenerations). */
  generations: Generation[]
  onGenerated: (generation: Generation) => void
  onOpenGeneration: (batchKey: string, first: Generation) => void
  onOpenHistory: () => void
  workspaceId?: string
  pickReferenceImage?: () => Promise<string | null>
  sendTone?: StudioComposerProps['sendTone']
  actions?: StudioMediaActions
  recentLimit?: number
  className?: string
}

/**
 * Studio's create-and-recent-media landing screen. The host must render this
 * inside both `StudioToastProvider` and `StudioPlaybackProvider`.
 */
export function StudioHomeScreen({
  generations,
  onGenerated,
  onOpenGeneration,
  onOpenHistory,
  workspaceId,
  pickReferenceImage,
  sendTone,
  actions,
  recentLimit = 20,
  className,
}: StudioHomeScreenProps): JSX.Element {
  const [viewer, setViewer] = useState<Generation | null>(null)
  const [confirmTargets, setConfirmTargets] = useState<Generation[] | null>(null)
  const playback = useStudioPlayback()
  const { toast } = useStudioToast()
  const deferredDelete = useDeferredDelete({
    remove: actions?.remove ?? (async () => {}),
  })
  const navigateNewBatch = useBatchNavigation({ seed: generations, onOpenGeneration })

  const wrappedOnGenerated = useCallback((generation: Generation) => {
    onGenerated(generation)
    navigateNewBatch(generation)
  }, [navigateNewBatch, onGenerated])

  const visible = useMemo(
    () => generations.filter((generation) => !deferredDelete.pendingIds.has(generation.id)),
    [deferredDelete.pendingIds, generations],
  )
  const renderedViewer = viewer
    ? generations.find((generation) => generation.id === viewer.id) ?? viewer
    : null
  const requestDelete = actions?.remove
    ? (generation: Generation) => setConfirmTargets([generation])
    : undefined

  const onSaved = useCallback((results: readonly VaultSaveResult[]) => {
    const first = results[0]
    if (first) toast({ message: `Saved to vault · ${first.vaultPath}` })
  }, [toast])

  useEffect(() => playback.stop, [playback.stop])

  function confirmDelete(): void {
    const targets = confirmTargets
    setConfirmTargets(null)
    if (!targets?.length) return
    if (viewer && targets.some((target) => target.id === viewer.id)) setViewer(null)
    deferredDelete.request(targets)
  }

  return (
    <main className={className}>
      <div className="studio-home-top mx-auto w-full max-w-[868px] px-6 pt-[clamp(24px,22vh,220px)] max-[900px]:px-4">
        <h1 className="mb-11 text-center text-[1.75rem] font-medium tracking-tight text-foreground [text-wrap:balance] max-[640px]:text-[1.5rem]">
          What do you want to create?
        </h1>
        <StudioComposer
          variant="home"
          workspaceId={workspaceId}
          pickReferenceImage={pickReferenceImage}
          sendTone={sendTone}
          onGenerated={wrappedOnGenerated}
        />
      </div>

      <section className="studio-home-recent pb-[72px]">
        <div className="mb-3 mt-[34px] flex items-center justify-between gap-3 px-6 max-[900px]:px-4">
          <h2 className="text-[13px] font-normal tracking-[0.02em] text-muted-foreground">Recent media</h2>
          <button
            type="button"
            onClick={onOpenHistory}
            className="h-[30px] whitespace-nowrap rounded-md px-1 text-[13px] font-medium text-primary transition hover:text-primary/80"
          >
            View history
          </button>
        </div>

        <div className="studio-grid studio-grid-library">
          {visible.length === 0 ? (
            <div className="col-span-full flex flex-col items-center py-16 text-center">
              <p className="text-[14px] text-foreground">Nothing generated yet.</p>
              <p className="max-w-[380px] text-[13px] text-muted-foreground">
                Whatever you make lands here first — it only reaches the vault when you save it.
              </p>
            </div>
          ) : visible.slice(0, recentLimit).map((generation) => (
            <MediaTile
              key={generation.id}
              generation={generation}
              context="home"
              onOpen={setViewer}
              actions={actions}
              onRequestDelete={requestDelete}
              onSaved={onSaved}
            />
          ))}
        </div>
      </section>

      <MediaViewerModal
        generation={renderedViewer}
        onClose={() => setViewer(null)}
        actions={actions}
        onRequestDelete={requestDelete}
        onSaved={onSaved}
      />
      <StudioConfirmDialog
        open={confirmTargets !== null}
        count={confirmTargets?.length ?? 0}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmTargets(null)}
      />
    </main>
  )
}
