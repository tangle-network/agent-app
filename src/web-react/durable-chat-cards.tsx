import type { ReactNode } from 'react'
import { persistedPartToInteraction, type ChatInteraction, type InteractionAnswers } from './chat-interactions'
import { persistedPartToPlan, type ChatPlan } from '../plans/index'
import type { DurablePlanDecision, DurablePlanDecisionResult } from './durable-plan-flow'
import { DurablePlanCard } from './durable-plan-card'
import { InteractionPlanCard } from './interaction-plan-card'
import { InteractionQuestionCard } from './interaction-question-card'
import type { SubmitInteractionAnswer } from './interaction-card-support'

export type DurableChatCard =
  | { kind: 'plan'; key: string; plan: ChatPlan }
  | { kind: 'interaction'; key: string; interaction: ChatInteraction }

function planIdentity(planId: string, revision: number): string {
  return `${planId}:${revision}`
}

/** Converts persisted/live parts to canonical cards. Legacy interaction-plan
 * cards are suppressed only when their raw part carries an explicit planId and
 * revision matching a durable plan. Identical markdown alone is never proof. */
export function durableChatCardsFromParts(parts: Array<Record<string, unknown>>): DurableChatCard[] {
  const durablePlans = new Set<string>()
  for (const part of parts) {
    const plan = persistedPartToPlan(part)
    if (plan) durablePlans.add(planIdentity(plan.planId, plan.revision))
  }
  const cards: DurableChatCard[] = []
  for (const part of parts) {
    const plan = persistedPartToPlan(part)
    if (plan) {
      cards.push({ kind: 'plan', key: `plan:${planIdentity(plan.planId, plan.revision)}`, plan })
      continue
    }
    const interaction = persistedPartToInteraction(part)
    if (!interaction) continue
    const correlatedPlan = interaction.kind === 'plan' && typeof part.planId === 'string' &&
      typeof part.revision === 'number' && durablePlans.has(planIdentity(part.planId, part.revision))
    if (correlatedPlan) continue
    cards.push({ kind: 'interaction', key: `interaction:${interaction.id}`, interaction })
  }
  return cards
}

export interface DurableChatCardsProps {
  parts: Array<Record<string, unknown>>
  canWrite: boolean
  submitInteraction: SubmitInteractionAnswer
  decidePlan: (plan: ChatPlan, decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>
  decidingPlan?: (plan: ChatPlan) => DurablePlanDecision | null
  planError?: (plan: ChatPlan) => string | null
  onInteractionResolved?: (id: string, status: Exclude<ChatInteraction['status'], 'pending'>, answers?: InteractionAnswers) => void
  onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>
  /** Fired when the user asks the agent to re-submit an expired/withdrawn
   *  plan card as a new chat turn; receives that card's interaction. Omit to
   *  hide the affordance entirely. */
  onReRequest?: (interaction: ChatInteraction) => boolean | void | Promise<boolean | void>
  /** Overrides the default re-request button label. */
  reRequestLabel?: string
  renderMarkdown?: (markdown: string) => ReactNode
  className?: string
}

/** Ready-to-embed canonical question/plan card lane for persisted assistant
 * parts. Apps inject transport and styling callbacks instead of rebuilding the
 * lifecycle/render switch. */
export function DurableChatCards({
  parts,
  canWrite,
  submitInteraction,
  decidePlan,
  decidingPlan,
  planError,
  onInteractionResolved,
  onLateAnswer,
  onReRequest,
  reRequestLabel,
  renderMarkdown,
  className,
}: DurableChatCardsProps) {
  const cards = durableChatCardsFromParts(parts)
  if (cards.length === 0) return null
  return (
    <div className={`space-y-3 ${className ?? ''}`}>
      {cards.map((card) => {
        if (card.kind === 'plan') {
          return (
            <DurablePlanCard
              key={card.key}
              plan={card.plan}
              canWrite={canWrite}
              decide={(decision, feedback) => decidePlan(card.plan, decision, feedback)}
              deciding={decidingPlan?.(card.plan)}
              error={planError?.(card.plan)}
              renderMarkdown={renderMarkdown}
            />
          )
        }
        if (card.interaction.kind === 'plan') {
          return (
            <InteractionPlanCard
              key={card.key}
              interaction={card.interaction}
              canWrite={canWrite}
              submitAnswer={submitInteraction}
              onResolved={onInteractionResolved}
              onReRequest={onReRequest}
              reRequestLabel={reRequestLabel}
              renderMarkdown={renderMarkdown}
            />
          )
        }
        return (
          <InteractionQuestionCard
            key={card.key}
            interaction={card.interaction}
            canWrite={canWrite}
            submitAnswer={submitInteraction}
            onResolved={onInteractionResolved}
            onLateAnswer={onLateAnswer}
          />
        )
      })}
    </div>
  )
}
