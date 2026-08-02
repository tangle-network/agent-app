import { ListChecks } from 'lucide-react'
import { cn } from '@tangle-network/sandbox-ui/utils'
import type { ComposerPlanModeSelection } from './types'

export interface ComposerModeControlsProps {
  /**
   * Plan-approval mode. Products pass it only when the selected backend can
   * propose a plan and wait for approval; omitted means nothing renders.
   */
  planMode?: ComposerPlanModeSelection
}

/**
 * The shared plan-mode toggle for the left side of an agent composer.
 * Plan mode is a behavioral switch, not part of the profile/backend/model/
 * thinking identity controls on the right.
 */
export function ComposerModeControls({ planMode }: ComposerModeControlsProps) {
  if (!planMode) return null

  return (
    <button
      type="button"
      aria-pressed={planMode.enabled}
      disabled={planMode.saving}
      onClick={() => planMode.setEnabled(!planMode.enabled)}
      title="Plan mode: the agent proposes a plan you approve before it executes"
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors',
        planMode.enabled
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
        planMode.saving && 'opacity-60',
      )}
    >
      <ListChecks className="h-3.5 w-3.5" />
      Plan
    </button>
  )
}
