import { Card, CardContent, Badge } from '@tangle-network/sandbox-ui/primitives'
import { Send } from 'lucide-react'
import {
  type Generation,
  DESTINATIONS,
  generationError,
  generationStatus,
  isPublishPackage,
  relativeTime,
} from '../studio'
import { typeConfigFor } from './type-config'

export function GenerationCard({
  generation,
  onSelect,
}: {
  generation: Generation
  onSelect: (generation: Generation) => void
}) {
  const cfg = typeConfigFor(generation.type)
  const Icon = cfg.icon
  const status = generationStatus(generation)
  const publishPackage = generation.metadata?.publishPackage
  return (
    <button type="button" onClick={() => onSelect(generation)} className="group text-left animate-row-in">
      <Card className="overflow-hidden transition-all group-hover:border-primary/50 group-hover:shadow-md">
        <div className="relative aspect-video bg-secondary">
          {generation.type === 'image' && generation.result ? (
            <img src={generation.result} alt={generation.prompt} className="h-full w-full object-cover" />
          ) : (generation.type === 'video' || generation.type === 'avatar') && generation.result ? (
            <video src={generation.result} className="h-full w-full object-cover" muted />
          ) : generation.type === 'speech' && generation.result ? (
            <div className="flex h-full items-center justify-center">
              <Icon className="h-6 w-6 text-muted-foreground/40" />
            </div>
          ) : generation.type === 'transcription' && generation.result ? (
            <div className="flex h-full items-center justify-center p-4">
              <p className="line-clamp-5 text-xs text-muted-foreground">{generation.result}</p>
            </div>
          ) : status === 'pending' || status === 'running' ? (
            <div className="shimmer h-full w-full" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Icon className="h-8 w-8 text-muted-foreground/20" />
            </div>
          )}
          <div className="absolute left-2 top-2">
            <Badge variant="outline" className={`${cfg.color} gap-1 text-xs`}>
              <Icon className="h-3 w-3" />
              {cfg.label}
            </Badge>
          </div>
          <GenerationStatusBadge generation={generation} />
        </div>
        <CardContent className="p-3">
          <p className="mb-2 line-clamp-2 text-sm font-medium text-foreground">{generation.prompt}</p>
          {status === 'failed' && (
            <p className="mb-2 line-clamp-2 text-xs text-destructive">{generationError(generation)}</p>
          )}
          <div className="flex items-center justify-between">
            {generation.model && (
              <span className="truncate text-xs text-muted-foreground">{generation.model}</span>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {generation.cost != null && (
                <span className="text-xs text-muted-foreground">${generation.cost.toFixed(3)}</span>
              )}
              <span className="text-xs text-muted-foreground">{relativeTime(generation.createdAt)}</span>
            </div>
          </div>
          {isPublishPackage(publishPackage) && (
            <div className="mt-3 rounded-md border border-border bg-secondary p-2">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Send className="h-3 w-3" />
                {(publishPackage.destinations ?? [])
                  .map((id) => DESTINATIONS.find((destination) => destination.id === id)?.label ?? id)
                  .join(', ') || 'Publish package'}
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {publishPackage.caption || 'Caption pending'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </button>
  )
}

export function GenerationStatusBadge({
  generation,
  inline = false,
}: {
  generation: Generation
  inline?: boolean
}) {
  const status = generationStatus(generation)
  if (status === 'succeeded') return null

  const label = status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : 'Pending'
  // Solid tint mixed onto the card surface — the badge floats over media, so an
  // alpha fill would let the thumbnail bleed through.
  const className = status === 'failed'
    ? 'border-destructive/30 bg-[color-mix(in_srgb,hsl(var(--destructive))_10%,hsl(var(--card)))] text-destructive'
    : 'border-warning/30 bg-[color-mix(in_srgb,hsl(var(--warning))_10%,hsl(var(--card)))] text-warning'

  return (
    <div className={inline ? '' : 'absolute bottom-2 left-2'}>
      <Badge variant="outline" className={`${className} text-xs`}>
        {label}
      </Badge>
    </div>
  )
}
