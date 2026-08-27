import { useMemo } from 'react'
import { Link } from 'react-router'
import {
  Button,
  Tabs, TabsList, TabsTrigger,
} from '@tangle-network/sandbox-ui/primitives'
import { ArrowLeft, DollarSign, FolderOpen, X } from 'lucide-react'
import { type Generation } from '../studio'
import { TYPE_CONFIG } from './type-config'
import { StudioSheet } from './studio-sheet'
import { GenerationGrid, filterGenerations } from './generation-grid'
import { GenerationDetail } from './generation-detail'

export function LibraryDrawer({
  open,
  onOpenChange,
  generations,
  totalCost,
  typeFilter,
  onFilterChange,
  vaultHref,
  selected,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  generations: Generation[]
  totalCost: number
  typeFilter: string | null
  onFilterChange: (type: string | null) => void
  vaultHref?: (filePath?: string | null) => string
  selected: Generation | null
  onSelect: (generation: Generation | null) => void
}) {
  const visible = useMemo(() => filterGenerations(generations, typeFilter), [generations, typeFilter])

  return (
    <StudioSheet open={open} onOpenChange={onOpenChange} title="Asset library">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        {selected ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to library
          </button>
        ) : (
          <h2 className="text-sm font-semibold text-foreground">Asset library</h2>
        )}
        <button
          type="button"
          aria-label="Close library"
          onClick={() => onOpenChange(false)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {selected ? (
        <div className="flex-1 overflow-y-auto p-4">
          <GenerationDetail
            generation={selected}
            vaultHref={vaultHref}
            onNavigate={() => onOpenChange(false)}
          />
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border px-4 pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{visible.length} generation{visible.length !== 1 ? 's' : ''}</span>
                <span className="flex items-center gap-0.5">
                  <DollarSign className="h-3 w-3" />
                  {totalCost.toFixed(2)} spent
                </span>
              </div>
              {vaultHref && (
                <Link to={vaultHref()} prefetch="intent" onClick={() => onOpenChange(false)}>
                  <Button size="sm" variant="outline">
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    Vault
                  </Button>
                </Link>
              )}
            </div>
            <Tabs value={typeFilter ?? 'all'} onValueChange={(v) => onFilterChange(v === 'all' ? null : v)}>
              <TabsList className="h-9 w-full justify-start gap-1 overflow-x-auto bg-transparent">
                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
                  <TabsTrigger key={key} value={key} className="text-xs">{cfg.label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <GenerationGrid generations={visible} typeFilter={typeFilter} onSelect={onSelect} />
          </div>
        </>
      )}
    </StudioSheet>
  )
}
