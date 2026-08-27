import { useEffect, useState, type ReactNode } from 'react'
import type { ChatPlan } from '../plans/index'
import type {
  DurablePlanDecision,
  DurablePlanDecisionResult,
} from './durable-plan-flow'
import { InteractionActionButton, InteractionBadge } from './interaction-question-card'

export interface DurablePlanCardProps {
  plan: ChatPlan
  canWrite: boolean
  decide: (decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>
  deciding?: DurablePlanDecision | null
  error?: string | null
  renderMarkdown?: (markdown: string) => ReactNode
  className?: string
}

function statusLabel(plan: ChatPlan): string {
  switch (plan.status) {
    case 'pending': return 'Waiting for your decision'
    case 'approved': return 'Approved'
    case 'rejected': return 'Changes requested'
    case 'superseded': return 'Superseded'
    case 'withdrawn': return 'Withdrawn'
    default: return 'Preparing'
  }
}

export function DurablePlanCard({
  plan,
  canWrite,
  decide,
  deciding = null,
  error,
  renderMarkdown,
  className,
}: DurablePlanCardProps) {
  const [feedback, setFeedback] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => setLocalError(null), [plan.planId, plan.revision, plan.status])

  const actionable = plan.status === 'pending'
  const disabled = !canWrite || !actionable || deciding !== null

  async function submit(decision: DurablePlanDecision) {
    const trimmed = feedback.trim()
    if (decision === 'rejected' && !trimmed) {
      setLocalError('Describe what you want changed before requesting a revision.')
      return
    }
    setLocalError(null)
    await decide(decision, decision === 'rejected' ? trimmed : undefined)
  }

  return (
    <div className={`rounded-xl border border-primary/40 bg-card p-4 shadow-sm ${className ?? ''}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <InteractionBadge variant="outline">Plan decision</InteractionBadge>
          <InteractionBadge variant={plan.status === 'approved' ? 'default' : plan.status === 'rejected' || plan.status === 'withdrawn' ? 'destructive' : 'outline'}>
            {statusLabel(plan)}
          </InteractionBadge>
        </div>
        <span className="text-xs text-muted-foreground">Revision {plan.revision}</span>
      </div>
      {plan.title && <p className="mb-3 text-sm font-medium leading-5 text-foreground">{plan.title}</p>}
      <div className="relative">
        <div className="overflow-hidden text-sm" style={expanded ? undefined : { maxHeight: 320 }}>
          {renderMarkdown ? renderMarkdown(plan.body) : <p className="whitespace-pre-wrap leading-5">{plan.body}</p>}
        </div>
        {!expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? 'Collapse plan' : 'Show full plan'}
        </button>
      </div>
      {actionable && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm font-medium leading-5 text-foreground" htmlFor={`durable-plan-feedback-${plan.planId}-${plan.revision}`}>
            Feedback for requested changes
          </label>
          <textarea
            id={`durable-plan-feedback-${plan.planId}-${plan.revision}`}
            value={feedback}
            disabled={disabled}
            onChange={(event) => setFeedback(event.target.value)}
            rows={2}
            placeholder="Describe what you want changed in the plan"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
          />
        </div>
      )}
      {(localError ?? error) && <p className="mt-3 text-xs text-destructive">{localError ?? error}</p>}
      {actionable && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <InteractionActionButton variant="outline" onClick={() => void submit('rejected')} disabled={disabled}>
            {deciding === 'rejected' ? 'Sending…' : 'Request changes'}
          </InteractionActionButton>
          <InteractionActionButton onClick={() => void submit('approved')} disabled={disabled}>
            {deciding === 'approved' ? 'Approving…' : 'Approve plan'}
          </InteractionActionButton>
        </div>
      )}
    </div>
  )
}
