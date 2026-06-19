import { Link } from 'react-router'
import { Badge, Button } from '@tangle-network/sandbox-ui/primitives'
import { FolderOpen } from 'lucide-react'
import {
  type Generation,
  generationError,
  generationVaultPath,
} from '../studio'
import { typeConfigFor } from './type-config'
import { GenerationStatusBadge } from './generation-card'

export function GenerationDetail({
  generation,
  workspaceId,
  onNavigate,
}: {
  generation: Generation
  workspaceId?: string
  onNavigate?: () => void
}) {
  const cfg = typeConfigFor(generation.type)
  const Icon = cfg.icon
  const vaultPath = generationVaultPath(generation)
  const vaultHref = vaultPath
    ? `/app/${workspaceId}/vault?file=${encodeURIComponent(vaultPath)}`
    : `/app/${workspaceId}/vault`

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg bg-muted/50">
        {generation.type === 'image' && generation.result ? (
          <img src={generation.result} alt={generation.prompt} className="max-h-[420px] w-full object-contain" />
        ) : (generation.type === 'video' || generation.type === 'avatar') && generation.result ? (
          <video src={generation.result} controls className="max-h-[420px] w-full" />
        ) : generation.type === 'speech' && generation.result ? (
          <div className="p-6">
            <audio src={generation.result} controls className="w-full" />
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <Icon className="h-8 w-8 text-muted-foreground/20" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cfg.color}>{cfg.label}</Badge>
        <GenerationStatusBadge generation={generation} inline />
        {generationError(generation) && (
          <span className="text-xs text-destructive">{generationError(generation)}</span>
        )}
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-muted-foreground">Prompt</span>
        <p className="text-sm text-foreground">{generation.prompt}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {generation.model && (
          <div>
            <span className="block text-[10px] font-medium text-muted-foreground">Model</span>
            <span className="text-xs text-foreground">{generation.model}</span>
          </div>
        )}
        {generation.cost != null && (
          <div>
            <span className="block text-[10px] font-medium text-muted-foreground">Cost</span>
            <span className="text-xs text-foreground">${generation.cost.toFixed(4)}</span>
          </div>
        )}
        {generation.createdAt && (
          <div>
            <span className="block text-[10px] font-medium text-muted-foreground">Created</span>
            <span className="text-xs text-foreground">{new Date(generation.createdAt).toLocaleString()}</span>
          </div>
        )}
      </div>

      {generation.type === 'transcription' && generation.result && (
        <div>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Transcription</span>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-sm text-foreground">
            {generation.result}
          </pre>
        </div>
      )}

      <div className="border-t border-border pt-2">
        <Link to={vaultHref} prefetch="intent" onClick={onNavigate}>
          <Button size="sm" variant="outline">
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            Open in Vault
          </Button>
        </Link>
      </div>
    </div>
  )
}
