import { useMemo } from 'react'
import {
  Tabs, TabsList, TabsTrigger,
} from '@tangle-network/sandbox-ui/primitives'
import { DollarSign } from 'lucide-react'
import { type Generation } from '../studio'
import { TYPE_CONFIG } from './type-config'
import { GenerationGrid, filterGenerations } from './generation-grid'

/**
 * Inline asset gallery — the same filter + stats + card grid as the library
 * drawer's list view, but with no sheet chrome so it can sit on the page beside
 * the composer. In-flight generations need no special handling: they arrive at
 * the front of `generations` (via `useStudioGenerations.mergedGenerations`) and
 * `GenerationCard` renders their `pending`/`running` shimmer.
 */
export function LibraryPanel({
  generations,
  totalCost,
  typeFilter,
  onFilterChange,
  onSelect,
}: {
  generations: Generation[]
  totalCost: number
  typeFilter: string | null
  onFilterChange: (type: string | null) => void
  onSelect: (generation: Generation) => void
}) {
  const visible = useMemo(() => filterGenerations(generations, typeFilter), [generations, typeFilter])

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={typeFilter ?? 'all'} onValueChange={(v) => onFilterChange(v === 'all' ? null : v)}>
          <TabsList className="h-9 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-[var(--md3-surface-container-low)] p-1">
            <TabsTrigger
              value="all"
              className="rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-primary/10 data-[state=active]:font-semibold data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              All
            </TabsTrigger>
            {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
              <TabsTrigger
                key={key}
                value={key}
                className="rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-primary/10 data-[state=active]:font-semibold data-[state=active]:text-primary data-[state=active]:shadow-none"
              >
                {cfg.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{visible.length} generation{visible.length !== 1 ? 's' : ''}</span>
          <span className="flex items-center gap-0.5">
            <DollarSign className="h-3 w-3" />
            {totalCost.toFixed(2)} spent
          </span>
        </div>
      </div>

      <GenerationGrid generations={visible} typeFilter={typeFilter} onSelect={onSelect} />
    </div>
  )
}
