import { useMemo } from 'react'
import { Link } from 'react-router'
import {
  Button, EmptyState,
  Tabs, TabsList, TabsTrigger,
} from '@tangle-network/sandbox-ui/primitives'
import { ArrowLeft, DollarSign, Film, FolderOpen, Sparkles, X } from 'lucide-react'
import {
  type Generation,
  isGenerationType,
} from '../studio'
import { TYPE_CONFIG } from './type-config'
import { StudioSheet } from './studio-sheet'
import { GenerationCard } from './generation-card'
import { GenerationDetail } from './generation-detail'

export function LibraryDrawer({
  open,
  onOpenChange,
  generations,
  totalCost,
  typeFilter,
  onFilterChange,
  workspaceId,
  selected,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  generations: Generation[]
  totalCost: number
  typeFilter: string | null
  onFilterChange: (type: string | null) => void
  workspaceId?: string
  selected: Generation | null
  onSelect: (generation: Generation | null) => void
}) {
  const visible = useMemo(() => {
    if (!typeFilter || !isGenerationType(typeFilter)) return generations
    return generations.filter((generation) => generation.type === typeFilter)
  }, [generations, typeFilter])

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
            workspaceId={workspaceId}
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
              <Link to={`/app/${workspaceId}/vault`} prefetch="intent" onClick={() => onOpenChange(false)}>
                <Button size="sm" variant="outline">
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  Vault
                </Button>
              </Link>
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
            {visible.length === 0 ? (
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
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visible.map((generation) => (
                  <GenerationCard key={generation.id} generation={generation} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </StudioSheet>
  )
}
