import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { DurablePlanCard, type DurablePlanDecision, type DurablePlanDecisionResult } from '../../web-react'
import type { ChatPlan } from '../../plans'
import {
  approvedDurablePlan,
  logResolved,
  pendingDurablePlan,
  rejectedDurablePlan,
  renderStoryMarkdown,
  withdrawnDurablePlan,
} from './fixtures'

/**
 * The durable (sandbox-SDK) plan-decision card — distinct from
 * InteractionPlanCard: revisions persist server-side and a rejection REQUIRES
 * feedback (try it: Request changes with an empty box shows the inline error).
 */

const meta: Meta<typeof DurablePlanCard> = {
  title: 'ChatControls/DurablePlanCard',
  component: DurablePlanCard,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof DurablePlanCard>

/** Pending revision 2 — actionable; the decision flips the card locally. */
export const Pending: Story = {
  render: () => {
    const [plan, setPlan] = useState<ChatPlan>(pendingDurablePlan)
    const [deciding, setDeciding] = useState<DurablePlanDecision | null>(null)
    const decide = async (decision: DurablePlanDecision, feedback?: string): Promise<DurablePlanDecisionResult | null> => {
      setDeciding(decision)
      await new Promise((resolve) => setTimeout(resolve, 900))
      const next: ChatPlan =
        decision === 'approved'
          ? { ...plan, status: 'approved', decidedAt: new Date().toISOString(), decidedBy: 'you' }
          : { ...plan, status: 'rejected', decidedAt: new Date().toISOString(), feedback: feedback ?? '', decidedBy: 'you' }
      setPlan(next)
      setDeciding(null)
      logResolved(plan.planId, decision, feedback)
      return { plan: next, idempotent: false }
    }
    return (
      <DurablePlanCard plan={plan} canWrite decide={decide} deciding={deciding} renderMarkdown={renderStoryMarkdown} />
    )
  },
}

/** Terminal: approved. */
export const Approved: Story = {
  args: {
    plan: approvedDurablePlan,
    canWrite: true,
    decide: async () => null,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Terminal: rejected — the recorded feedback rides the plan. */
export const Rejected: Story = {
  args: {
    plan: rejectedDurablePlan,
    canWrite: true,
    decide: async () => null,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Terminal: withdrawn. */
export const Withdrawn: Story = {
  args: {
    plan: withdrawnDurablePlan,
    canWrite: true,
    decide: async () => null,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** A host-reported decision error renders inline above the actions. */
export const WithError: Story = {
  name: 'With host error',
  args: {
    plan: pendingDurablePlan,
    canWrite: true,
    decide: async () => null,
    error: 'The decision could not be saved. Try again.',
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Pending + the three terminal states stacked — the decision lifecycle. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-4">
      <DurablePlanCard plan={pendingDurablePlan} canWrite decide={async () => null} renderMarkdown={renderStoryMarkdown} />
      <DurablePlanCard plan={approvedDurablePlan} canWrite decide={async () => null} renderMarkdown={renderStoryMarkdown} />
      <DurablePlanCard plan={rejectedDurablePlan} canWrite decide={async () => null} renderMarkdown={renderStoryMarkdown} />
      <DurablePlanCard plan={withdrawnDurablePlan} canWrite decide={async () => null} renderMarkdown={renderStoryMarkdown} />
    </div>
  ),
}
