import { Badge } from '@tangle-network/sandbox-ui/primitives'
import { ArrowRight, Sparkles } from 'lucide-react'
import {
  type Generation,
  generationError,
  generationStatus,
} from '../studio'
import { typeConfigFor } from './type-config'

export function ResultCanvas({
  batch,
  onOpenLibrary,
  onSelect,
}: {
  batch: Generation[]
  onOpenLibrary: () => void
  onSelect: (generation: Generation) => void
}) {
  const cardClass = 'rounded-xl border border-border bg-card shadow-[var(--shadow-card)]'

  if (batch.length === 0) {
    return (
      <section className={`${cardClass} flex min-h-[180px] flex-col items-center justify-center gap-2 p-8 text-center`}>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Sparkles className="h-6 w-6 text-muted-foreground/40" />
        </div>
        <p className="text-sm font-medium text-foreground">Your creations appear here</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Write a prompt above and hit Generate — your latest result blooms here, and everything lives in your library.
        </p>
      </section>
    )
  }

  const cfg = typeConfigFor(batch[0]?.type ?? 'image')
  const statuses = batch.map(generationStatus)
  const runLabel = statuses.some((s) => s === 'pending' || s === 'running')
    ? 'Generating…'
    : statuses.every((s) => s === 'failed')
      ? 'Last run failed'
      : 'Latest creation'
  const isWorking = statuses.some((s) => s === 'pending' || s === 'running')

  return (
    <section className={`${cardClass} p-5`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`${cfg.color} text-[10px]`}>{cfg.label}</Badge>
          <span className="text-sm font-medium text-foreground">{runLabel}</span>
          {isWorking && <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />}
        </div>
        <button
          type="button"
          onClick={onOpenLibrary}
          className="flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
        >
          View in Library
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className={`grid gap-3 ${batch.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {batch.map((generation) => (
          <button
            key={generation.id}
            type="button"
            onClick={() => onSelect(generation)}
            className="studio-bloom group relative aspect-video overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-primary/40"
          >
            <CanvasTile generation={generation} />
          </button>
        ))}
      </div>

      {batch.length > 1 && (
        <p className="mt-2 text-xs text-muted-foreground">{batch.length} results from this run</p>
      )}
    </section>
  )
}

function CanvasTile({ generation }: { generation: Generation }) {
  const cfg = typeConfigFor(generation.type)
  const Icon = cfg.icon
  const status = generationStatus(generation)

  if (status === 'pending' || status === 'running') {
    return <div className="studio-shimmer absolute inset-0 h-full w-full" />
  }
  if (status === 'failed') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
        <Icon className="h-6 w-6 text-destructive/50" />
        <p className="line-clamp-3 text-xs text-destructive">{generationError(generation) ?? 'Generation failed'}</p>
      </div>
    )
  }
  if (generation.type === 'image' && generation.result) {
    return <img src={generation.result} alt={generation.prompt} className="absolute inset-0 h-full w-full object-contain" />
  }
  if ((generation.type === 'video' || generation.type === 'avatar') && generation.result) {
    return <video src={generation.result} controls className="absolute inset-0 h-full w-full object-contain" />
  }
  if (generation.type === 'speech' && generation.result) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <audio src={generation.result} controls className="w-full" />
      </div>
    )
  }
  if (generation.type === 'transcription' && generation.result) {
    return (
      <div className="absolute inset-0 overflow-y-auto p-4">
        <p className="whitespace-pre-wrap text-xs text-foreground">{generation.result}</p>
      </div>
    )
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <Icon className="h-8 w-8 text-muted-foreground/20" />
    </div>
  )
}
