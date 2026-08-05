import type { Meta, StoryObj } from '@storybook/react'

import { InteractionQuestionCard } from '../../web-react'
import {
  answeredQuestionInteraction,
  channelsQuestionInteraction,
  credentialsQuestionInteraction,
  expiredQuestionInteraction,
  freeTextQuestionInteraction,
  logResolved,
  okLateAnswer,
  okSubmitAnswer,
  selectQuestionInteraction,
} from './fixtures'

/**
 * The agent-ask card. The pending stories submit through the fake answer route
 * and flip to "Answered" on success; the expired one late-answers as a new
 * chat message.
 */

const meta: Meta<typeof InteractionQuestionCard> = {
  title: 'ChatControls/InteractionQuestionCard',
  component: InteractionQuestionCard,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof InteractionQuestionCard>

/** Single-select with per-option descriptions — the radio rows. */
export const SelectSingle: Story = {
  name: 'Select (single)',
  args: {
    interaction: selectQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
  },
}

/** Multi-select with a granted write-in row (`allowCustom`). */
export const SelectMultiCustom: Story = {
  name: 'Select (multi + write-in)',
  args: {
    interaction: channelsQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
  },
}

/** Free text with a length cap. */
export const FreeText: Story = {
  name: 'Free text',
  args: {
    interaction: freeTextQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
  },
}

/** Boolean + number + secret — every open input kind on one card. */
export const OpenInputKinds: Story = {
  name: 'Open input kinds',
  args: {
    interaction: credentialsQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
  },
}

/** What happens if nobody answers — host-owned copy beside the submit action. */
export const WithTimeoutNote: Story = {
  name: 'With timeout note',
  args: {
    interaction: selectQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onResolved: logResolved,
    timeoutNote: 'No answer in 10 minutes — the agent falls back to Claude Haiku 4.',
  },
}

/** Terminal: answered — the persisted selection is restored, read-only. */
export const Answered: Story = {
  args: {
    interaction: answeredQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
  },
}

/** Expired — answer anyway; it goes out as a new chat message. */
export const ExpiredLateAnswer: Story = {
  name: 'Expired (late answer)',
  args: {
    interaction: expiredQuestionInteraction,
    canWrite: true,
    submitAnswer: okSubmitAnswer,
    onLateAnswer: okLateAnswer,
  },
}

/** Viewer gate — options render, nothing is toggleable. */
export const ReadOnlyViewer: Story = {
  name: 'Read-only viewer',
  args: {
    interaction: channelsQuestionInteraction,
    canWrite: false,
    submitAnswer: okSubmitAnswer,
  },
}

/** The field kinds plus the two terminal states, stacked for comparison. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-4">
      <InteractionQuestionCard
        interaction={selectQuestionInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onResolved={logResolved}
      />
      <InteractionQuestionCard
        interaction={channelsQuestionInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onResolved={logResolved}
      />
      <InteractionQuestionCard
        interaction={freeTextQuestionInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onResolved={logResolved}
      />
      <InteractionQuestionCard
        interaction={answeredQuestionInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
      />
      <InteractionQuestionCard
        interaction={expiredQuestionInteraction}
        canWrite
        submitAnswer={okSubmitAnswer}
        onLateAnswer={okLateAnswer}
      />
    </div>
  ),
}
