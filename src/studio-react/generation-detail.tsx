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
  vaultHref,
  onNavigate,
}: {
  generation: Generation
  vaultHref?: (filePath?: string | null) => string
  onNavigate?: () => void
}) {
  const cfg = typeConfigFor(generation.type)
  const Icon = cfg.icon
  // Only offer the vault link when the generation actually persisted a file.
  // generationVaultPath is null for failed/pending/running and storage-failed
  // generations; without this guard vaultHref(null) falls back to the vault
  // root, rendering a button that opens nothing relevant.
  const vaultPath = generationVaultPath(generation)
  const href = vaultHref && vaultPath ? vaultHref(vaultPath) : null

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg bg-secondary">
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
        <Badge variant="outline" className={`${cfg.color} gap-1`}>
          <Icon className="h-3 w-3" />
          {cfg.label}
        </Badge>
        <GenerationStatusBadge generation={generation} inline />
        {generationError(generation) && (
          <span className="text-xs text-destructive">{generationError(generation)}</span>
        )}
      </div>

      <div>
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Prompt</span>
        <p className="text-sm text-foreground">{generation.prompt}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {generation.model && (
          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Model</span>
            <span className="text-xs text-foreground">{generation.model}</span>
          </div>
        )}
        {generation.cost != null && (
          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Cost</span>
            <span className="text-xs text-foreground">${generation.cost.toFixed(3)}</span>
          </div>
        )}
        {generation.createdAt && (
          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Created</span>
            <span className="text-xs text-foreground">
              {new Date(generation.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </div>
        )}
      </div>

      {generation.type === 'transcription' && generation.result && (
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Transcription</span>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-secondary p-4 font-mono text-[13px] tabular-nums text-foreground">
            {generation.result}
          </pre>
        </div>
      )}

      {href && (
        <div className="border-t border-border pt-2">
          <Link to={href} prefetch="intent" onClick={onNavigate}>
            <Button size="sm" variant="outline">
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              Open in Vault
            </Button>
          </Link>
        </div>
      )}
    </div>
  )
}
