import { EmptyState } from '@tangle-network/sandbox-ui/primitives'
import { Film, Sparkles } from 'lucide-react'
import { type Generation, isGenerationType } from '../studio'
import { TYPE_CONFIG } from './type-config'
import { GenerationCard } from './generation-card'

/** The visible set for the active type tab (all generations when unfiltered). */
export function filterGenerations(generations: Generation[], typeFilter: string | null): Generation[] {
  if (!typeFilter || !isGenerationType(typeFilter)) return generations
  return generations.filter((generation) => generation.type === typeFilter)
}

/**
 * Chrome-less asset grid — the `GenerationCard` grid plus its empty state, with
 * no surrounding tabs/stats/sheet chrome. Composed by both the inline
 * `LibraryPanel` and the `LibraryDrawer`'s list view so the grid and its
 * empty-state copy stay in one place. `generations` is the already-filtered
 * visible set; `typeFilter` only tunes the empty-state message.
 */
export function GenerationGrid({
  generations,
  typeFilter,
  onSelect,
}: {
  generations: Generation[]
  typeFilter: string | null
  onSelect: (generation: Generation) => void
}) {
  if (generations.length === 0) {
    return (
      <EmptyState
        icon={typeFilter
          ? <Film className="h-8 w-8 text-muted-foreground/30" />
          : <Sparkles className="h-10 w-10 text-muted-foreground/30" />}
        title={typeFilter
          ? `No ${TYPE_CONFIG[typeFilter]?.label ?? typeFilter} generations`
          : 'No generations yet'}
        description={typeFilter
          ? 'Try a different filter or change the type in the composer.'
          : 'Everything you and the agent create lives here.'}
        className="py-16"
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {generations.map((generation) => (
        <GenerationCard key={generation.id} generation={generation} onSelect={onSelect} />
      ))}
    </div>
  )
}
