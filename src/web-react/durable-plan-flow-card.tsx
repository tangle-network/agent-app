import type { ReactNode } from 'react'
import type { ChatPlan } from '../plans/index'
import { DurablePlanCard } from './durable-plan-card'
import { useDurablePlanFlow, type DurablePlanDecisionClient, type UseDurablePlanFlowOptions } from './durable-plan-flow'
import { InteractionActionButton } from './interaction-question-card'

/** Props for a plan card wired to the durable decision flow. */
export interface DurablePlanFlowCardProps {
  plan: ChatPlan
  /** Product transport, usually `createDurablePlanDecisionClient` on the product's plan-decision route. */
  client: DurablePlanDecisionClient
  canWrite: boolean
  onUpdated?: (plan: ChatPlan) => void
  /** Re-enter the turn machinery with the decision's follow-up. Must be
   *  idempotent by `receipt.receiptId`; throw to have the bounded restore retry it. */
  attachFollowUp?: UseDurablePlanFlowOptions['attachFollowUp']
  renderMarkdown?: (markdown: string) => ReactNode
  className?: string
}

/**
 * The durable plan card as a product mounts it: `DurablePlanCard` on
 * `useDurablePlanFlow` with automatic restore, so a plan decided in another
 * tab (or before a reconnect) still attaches its follow-up. Two recoveries
 * render under the card: a saved decision whose follow-up effect is still
 * pending offers Continue, and a follow-up that could not be attached after
 * the bounded retry offers Retry.
 */
export function DurablePlanFlowCard({
  plan,
  client,
  canWrite,
  onUpdated,
  attachFollowUp,
  renderMarkdown,
  className,
}: DurablePlanFlowCardProps) {
  const flow = useDurablePlanFlow({ plan, client, onUpdated, attachFollowUp, autoRestore: true })
  const current = flow.plan
  const decided = current.status === 'approved' || current.status === 'rejected'
  const rejected = current.status === 'rejected'

  return (
    <div className="space-y-2">
      <DurablePlanCard
        plan={current}
        canWrite={canWrite}
        decide={flow.decide}
        deciding={flow.deciding}
        error={flow.error ?? flow.attachError}
        renderMarkdown={renderMarkdown}
        className={className}
      />
      {flow.effectPending && decided && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
          <p>The decision is saved. Its follow-up still needs confirmation.</p>
          <InteractionActionButton
            disabled={!canWrite || flow.deciding !== null}
            onClick={() => void flow.decide(rejected ? 'rejected' : 'approved', current.status === 'rejected' ? current.feedback : undefined)}
          >
            {flow.deciding ? 'Continuing…' : rejected ? 'Continue revision' : 'Continue plan'}
          </InteractionActionButton>
        </div>
      )}
      {flow.attachError && (
        <button
          type="button"
          onClick={flow.retryAttach}
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Retry notifying the agent
        </button>
      )}
    </div>
  )
}
