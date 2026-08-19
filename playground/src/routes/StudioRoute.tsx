import { useEffect, useMemo, useState } from 'react'
import {
  MediaTile,
  MediaViewerModal,
  MenuPill,
  StudioConfirmDialog,
  StudioPlaybackProvider,
  StudioToastProvider,
  useDeferredDelete,
  useStudioToast,
} from '@tangle-network/agent-app/studio-react'
import '@tangle-network/agent-app/studio-react/styles'
import {
  MEDIA_TYPE_FILTERS,
  generationVaultPath,
  type Generation,
  type MediaTypeFilter,
  type StudioMediaActions,
} from '@tangle-network/agent-app/studio'
import { makeStudioGenerations } from '../fixtures'

/**
 * Visual audit for the studio media surface: the shared `MediaTile` across the
 * states a library actually holds (image, video, one speech row with its own
 * waveform, one still generating, several already in the vault), the
 * `MediaViewerModal` those tiles open, the `MenuPill` type filter, and the two
 * flows that are easy to get wrong — save-to-vault, and a delete that confirms
 * first and is still undoable for a few seconds after that.
 *
 * The popover hit-test drives this route in two passes, because the surface has
 * two popover contexts and only one of them can be probed per page load:
 *
 *   ROUTE=/studio        node playground/scripts/popover-hit-test.mjs
 *   ROUTE=/studio/viewer node playground/scripts/popover-hit-test.mjs
 *
 * See `ViewerAuditPage` below for why the second pass is its own page.
 */

const noop = () => {}

/** A tile whose save popover is worth probing: not yet in the vault, so the
 *  "Save to vault" trigger renders at all. */
const isSaveable = (generation: Generation): boolean =>
  generation.result !== null && generationVaultPath(generation) === null

export function StudioRoute({ viewerOpen = false }: { viewerOpen?: boolean }) {
  return (
    <StudioToastProvider>
      <StudioPlaybackProvider>
        {viewerOpen ? <ViewerAuditPage /> : <StudioLibrary />}
      </StudioPlaybackProvider>
    </StudioToastProvider>
  )
}

function StudioLibrary() {
  const { toast } = useStudioToast()
  const [items, setItems] = useState(makeStudioGenerations)
  const [filter, setFilter] = useState<MediaTypeFilter>('all')
  const [viewing, setViewing] = useState<Generation | null>(null)
  const [confirming, setConfirming] = useState<Generation | null>(null)

  const deferred = useDeferredDelete({
    remove: async (ids) => {
      // The seam a product points at DELETE /api/generations. It runs only
      // after the undo window closes — an Undo inside the window means this is
      // never called at all.
      console.log('[studio] committed delete', ids)
    },
    onCommitted: (ids) => setItems((rows) => rows.filter((row) => !ids.includes(row.id))),
  })

  const actions: StudioMediaActions = useMemo(
    () => ({
      download: (generations) => console.log('[studio] download', generations.map((g) => g.id)),
      save: async ({ generations, path }) => {
        const results = generations.map((generation) => ({
          generationId: generation.id,
          vaultPath: `${path}/${generation.id}`,
        }))
        // Saving is what moves a row INTO the vault — until it lands the media
        // only exists in Studio, which is why the tile flips its chip and drops
        // the save control here rather than on generation.
        setItems((rows) =>
          rows.map((row) => {
            const saved = results.find((result) => result.generationId === row.id)
            return saved ? { ...row, metadata: { ...row.metadata, vaultPath: saved.vaultPath } } : row
          }),
        )
        return results
      },
      remove: async (ids) => console.log('[studio] delete requested', ids),
      vaultHref: (filePath) => `/vault?path=${encodeURIComponent(filePath ?? '')}`,
      onOpenVault: (generation) => console.log('[studio] open in vault', generationVaultPath(generation)),
    }),
    [],
  )

  const visible = items.filter(
    (row) => !deferred.pendingIds.has(row.id) && (filter === 'all' || row.type === filter),
  )
  const openable = items.find(isSaveable) ?? items[0] ?? null

  function onSaved(results: readonly { vaultPath: string }[]) {
    const first = results[0]
    if (first) toast({ message: `Saved to ${first.vaultPath}` })
  }

  function confirmDelete() {
    if (!confirming) return
    if (viewing?.id === confirming.id) setViewing(null)
    deferred.request([confirming])
    setConfirming(null)
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl space-y-5 px-6 py-8">
        <header className="space-y-1">
          <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Recent media</h2>
          <p className="text-[13px] text-muted-foreground">
            {visible.length} of {items.length} items. Generated media stays in Studio until you save it
            into the vault.
          </p>
        </header>

        {/* The filter pill and the viewer entry point. `data-popover-audit`
            marks the cluster for the popover hit test; the "Open viewer" button
            carries no `aria-haspopup`, so the audit walks past it. */}
        <div
          data-popover-audit="studio-filter"
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/40 p-3"
        >
          <MenuPill
            label="Media type"
            value={filter}
            choices={MEDIA_TYPE_FILTERS}
            onSelect={setFilter}
          />
          <button
            type="button"
            onClick={() => setViewing(openable)}
            disabled={openable === null}
            className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-[12.5px] font-medium transition hover:bg-accent disabled:opacity-50"
          >
            Open viewer
          </button>
          <span className="text-[12px] text-muted-foreground">
            Hover a tile for download / save / delete.
          </span>
        </div>

        {/* The grid is the audited tile host. A tile is its OWN clip host —
            `.studio-tile` is `overflow-hidden` and 230px wide — so a save
            popover rendered in place next to the trigger would be erased by the
            tile that owns it. Every not-yet-saved tile here is a probe target. */}
        <div data-popover-audit="studio-grid" className="studio-grid studio-grid-library">
          {visible.map((generation) => (
            <MediaTile
              key={generation.id}
              generation={generation}
              context="home"
              onOpen={setViewing}
              actions={actions}
              onRequestDelete={setConfirming}
              onSaved={onSaved}
            />
          ))}
        </div>

        {visible.length === 0 && (
          <p className="rounded-2xl border border-border bg-card/40 p-6 text-[13px] text-muted-foreground">
            No {filter} results in this fixture set. Switch the media type filter back to All media.
          </p>
        )}
      </div>

      <MediaViewerModal
        generation={viewing}
        onClose={() => setViewing(null)}
        actions={actions}
        onRequestDelete={setConfirming}
        onSaved={onSaved}
      />

      <StudioConfirmDialog
        open={confirming !== null}
        count={1}
        onConfirm={confirmDelete}
        onCancel={() => setConfirming(null)}
      />
    </div>
  )
}

/**
 * The second popover context, on its own page: the save-to-vault popover opened
 * from INSIDE the viewer. Only a browser can settle it — the viewer is a fixed,
 * blurred backdrop at `z-index: 900` and the popover portals to `document.body`
 * at `z-index: 1000`, so "is the panel above the backdrop" is a cascade
 * question, not a DOM one.
 *
 * Two things force this to be a separate page rather than an always-open viewer
 * dropped onto the library above:
 *
 *  - The viewer's own backdrop covers the page, so every other audited trigger
 *    would sit under it and Playwright's click would never land. The audit
 *    enumerates triggers in document order and cannot open a modal first, so
 *    the viewer's popover must already be reachable on load.
 *  - `MediaViewerModal` portals to `document.body`, so no wrapper in this tree
 *    is an ancestor of its trigger. `data-popover-audit` therefore goes on
 *    `document.body` itself, which is only safe because this page renders
 *    nothing else with an `aria-haspopup` trigger.
 */
function ViewerAuditPage() {
  const [generation] = useState(() => makeStudioGenerations().find(isSaveable) ?? null)

  useEffect(() => {
    document.body.setAttribute('data-popover-audit', 'studio-viewer')
    return () => document.body.removeAttribute('data-popover-audit')
  }, [])

  const actions: StudioMediaActions = useMemo(
    () => ({
      download: noop,
      save: async ({ generations, path }) =>
        generations.map((item) => ({ generationId: item.id, vaultPath: `${path}/${item.id}` })),
    }),
    [],
  )

  return (
    <div className="h-full w-full bg-background px-6 py-8">
      <p className="max-w-prose text-[13px] text-muted-foreground">
        Audit page: one always-open <code>MediaViewerModal</code>. Its footer &ldquo;Save to
        vault&rdquo; popover has to be clickable above the viewer&rsquo;s own backdrop.
      </p>
      {/* onClose is deliberately inert: the viewer must still be open when the
          audit probes it, including after the Escape it presses between
          triggers (the viewer ignores Escape while a popover is open). */}
      <MediaViewerModal generation={generation} onClose={noop} actions={actions} />
    </div>
  )
}
