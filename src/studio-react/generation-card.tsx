import { Card, CardContent, Badge } from '@tangle-network/sandbox-ui/primitives'
import { Send } from 'lucide-react'
import {
  type Generation,
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
  return (
    <button type="button" onClick={() => onSelect(generation)} className="group text-left animate-row-in">
      <Card className="overflow-hidden transition-all group-hover:border-primary/50 group-hover:shadow-md">
        <div className="relative aspect-video bg-muted/50">
          {generation.type === 'image' && generation.result ? (
            <img src={generation.result} alt={generation.prompt} className="h-full w-full object-cover" />
          ) : (generation.type === 'video' || generation.type === 'avatar') && generation.result ? (
            <video src={generation.result} className="h-full w-full object-cover" muted />
          ) : generation.type === 'speech' && generation.result ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex items-center gap-2">
                <Icon className="h-6 w-6 text-muted-foreground/40" />
                <span className="text-xs text-muted-foreground">Audio</span>
              </div>
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
            <Badge variant="outline" className={`${cfg.color} text-[10px] backdrop-blur-sm`}>
              {cfg.label}
            </Badge>
          </div>
          <GenerationStatusBadge generation={generation} />
        </div>
        <CardContent className="p-3">
          <p className="mb-2 line-clamp-2 text-xs text-foreground">{generation.prompt}</p>
          {status === 'failed' && (
            <p className="mb-2 line-clamp-2 text-[10px] text-destructive">{generationError(generation)}</p>
          )}
          <div className="flex items-center justify-between">
            {generation.model && (
              <span className="truncate text-[10px] text-muted-foreground">{generation.model}</span>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {generation.cost != null && (
                <span className="text-[10px] text-muted-foreground">${generation.cost.toFixed(3)}</span>
              )}
              <span className="text-[10px] text-muted-foreground">{relativeTime(generation.createdAt)}</span>
            </div>
          </div>
          {isPublishPackage(generation.metadata?.publishPackage) && (
            <div className="mt-3 rounded-md border border-border bg-muted/30 p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-foreground">
                <Send className="h-3 w-3" />
                {generation.metadata.publishPackage.destinations.join(', ')}
              </div>
              <p className="line-clamp-2 text-[10px] text-muted-foreground">
                {generation.metadata.publishPackage.caption || 'Caption pending'}
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
  const className = status === 'failed'
    ? 'border-destructive/25 bg-destructive/10 text-destructive'
    : 'border-warning/25 bg-warning/10 text-warning'

  return (
    <div className={inline ? '' : 'absolute bottom-2 left-2'}>
      <Badge variant="outline" className={`${className} text-[10px] backdrop-blur-sm`}>
        {label}
      </Badge>
    </div>
  )
}
