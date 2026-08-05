import type { Meta, StoryObj } from '@storybook/react'

import { InteractionPlanCard } from '../../web-react'
import {
  approvedPlanInteraction,
  declinedPlanInteraction,
  expiredPlanInteraction,
  logResolved,
  longPlanInteraction,
  okReRequest,
  okSubmitAnswer,
  pendingPlanInteraction,
  renderStoryMarkdown,
} from './fixtures'

/**
 * The plan-approval round-trip card. The pending stories are live: Approve and
 * Request changes POST through the fake submitter and the card flips to its
 * terminal chrome on success.
 */

const meta: Meta<typeof InteractionPlanCard> = {
  title: 'ChatControls/InteractionPlanCard',
  component: InteractionPlanCard,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof InteractionPlanCard>

/** Waiting for approval — markdown body, optional feedback field, both actions. */
export const Pending: Story = {
  args: {
    interaction: pendingPlanInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Body past 320px — collapsed behind "Show full plan" with the fade. */
export const LongPlanCollapsed: Story = {
  name: 'Long plan (collapsed)',
  args: {
    interaction: longPlanInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Terminal: approved. */
export const Approved: Story = {
  args: {
    interaction: approvedPlanInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
  },
}

/** Terminal: rejected — the revision note explains what happens next. */
export const Declined: Story = {
  name: 'Declined (changes requested)',
  args: {
    interaction: declinedPlanInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
  },
}

/** Expired with the re-request affordance wired — clicking it flips to "Re-submission requested". */
export const Expired: Story = {
  args: {
    interaction: expiredPlanInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onReRequest: okReRequest,
  },
}

/** Viewer gate — everything renders, nothing is actionable. */
export const ReadOnlyViewer: Story = {
  name: 'Read-only viewer',
  args: {
    interaction: pendingPlanInteraction,
    canWrite: false,
    submitAnswer: okSubmitAnswer,
    renderMarkdown: renderStoryMarkdown,
  },
}

/** Pending / approved / declined / expired stacked — the lifecycle at a glance. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-4">
      <InteractionPlanCard
        interaction={pendingPlanInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onResolved={logResolved}
        renderMarkdown={renderStoryMarkdown}
      />
      <InteractionPlanCard interaction={approvedPlanInteraction} canWrite submitAnswer={okSubmitAnswer} />
      <InteractionPlanCard interaction={declinedPlanInteraction} canWrite submitAnswer={okSubmitAnswer} />
      <InteractionPlanCard
        interaction={expiredPlanInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onReRequest={okReRequest}
      />
    </div>
  ),
}
