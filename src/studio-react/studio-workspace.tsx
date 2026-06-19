import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@tangle-network/sandbox-ui/primitives'
import { Images } from 'lucide-react'
import type { Generation } from '../studio'
import { useStudioGenerations } from './use-studio-generations'
import { ComposerHero } from './composer-hero'
import { StudioHeader } from './studio-header'
import { ResultCanvas } from './result-canvas'
import { LibraryDrawer } from './library-drawer'

export type StudioRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface StudioWorkspaceProps {
  generations: Generation[]
  totalCost: number
  workspaceId?: string
  role: StudioRole
  /** Polling endpoint override (default `/api/generations`). */
  generationsEndpoint?: string
}

/**
 * The full studio surface: header + composer + result canvas + library drawer,
 * with the generation orchestrator (merge/poll/revalidate) wired in. The host
 * route owns the loader (auth, RBAC, the generation query) and the server
 * endpoints (`/api/generate`, `/api/media-models`, `/api/generations`); this
 * shell renders that data and drives the live UI. Role gates the composer
 * (viewers get a read-only library) and the integration-management affordances.
 */
export function StudioWorkspace({
  generations,
  totalCost,
  workspaceId,
  role,
  generationsEndpoint,
}: StudioWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const typeFilter = searchParams.get('type')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selected, setSelected] = useState<Generation | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const canGenerate = role !== 'viewer'
  const canManageIntegrations = role === 'owner' || role === 'admin'

  const { mergedGenerations, latestBatch, onGenerated } = useStudioGenerations(generations, {
    workspaceId,
    generationsEndpoint,
  })

  function setFilter(type: string | null) {
    if (type) setSearchParams({ type })
    else setSearchParams({})
  }

  function openLibrary() {
    setSelected(null)
    setDrawerOpen(true)
  }

  function openDetail(generation: Generation) {
    setSelected(generation)
    setDrawerOpen(true)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <StudioHeader
        count={mergedGenerations.length}
        canGenerate={canGenerate}
        onOpenLibrary={openLibrary}
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">
        {canGenerate ? (
          <>
            <ComposerHero
              workspaceId={workspaceId}
              canManageIntegrations={canManageIntegrations}
              onGenerated={(generation) => {
                onGenerated(generation)
                requestAnimationFrame(() => {
                  canvasRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                })
              }}
            />
            <div ref={canvasRef}>
              <ResultCanvas
                batch={latestBatch}
                onOpenLibrary={openLibrary}
                onSelect={openDetail}
              />
            </div>
          </>
        ) : (
          <section className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card p-10 text-center shadow-[var(--shadow-card)]">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Images className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {mergedGenerations.length > 0
                ? `${mergedGenerations.length} asset${mergedGenerations.length !== 1 ? 's' : ''} in this workspace`
                : 'No generations yet'}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              When workspace members generate images, video, voice, avatars, or transcripts, they appear in the library.
            </p>
            <Button size="sm" variant="outline" onClick={openLibrary}>
              <Images className="mr-1.5 h-4 w-4" />
              Open library
            </Button>
          </section>
        )}
      </div>

      <LibraryDrawer
        open={drawerOpen}
        onOpenChange={(open) => { setDrawerOpen(open); if (!open) setSelected(null) }}
        generations={mergedGenerations}
        totalCost={totalCost}
        typeFilter={typeFilter}
        onFilterChange={setFilter}
        workspaceId={workspaceId}
        selected={selected}
        onSelect={(generation) => { setSelected(generation); if (generation) setDrawerOpen(true) }}
      />
    </div>
  )
}
