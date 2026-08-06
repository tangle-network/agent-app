import type { Meta, StoryObj } from '@storybook/react'

import { ChatEmptyState } from '../../web-react'
import { emptyStateDoors } from './fixtures'

/**
 * The branded first-run state behind `ChatMessages` when a thread has no
 * messages. The `doors` are the product's concrete starting actions — up to
 * three render; a fourth is silently dropped (the component slices).
 */

const meta: Meta<typeof ChatEmptyState> = {
  title: 'ChatControls/ChatEmptyState',
  component: ChatEmptyState,
}

export default meta
type Story = StoryObj<typeof ChatEmptyState>

/** Mark + headline + subline, no doors — the mark-and-prompt-only state. */
export const Default: Story = {}

/** The full state: three concrete doors with descriptions. */
export const WithDoors: Story = {
  name: 'With doors',
  args: { doors: emptyStateDoors },
}

/** Product copy override — name, headline, subline all replaced. */
export const CustomCopy: Story = {
  name: 'Custom copy',
  args: {
    productName: 'Creative',
    headline: 'Describe the asset you need',
    subline: 'The agent drafts, renders, and schedules it — you approve anything that goes out.',
    doors: emptyStateDoors,
  },
}

/** A single door — the grid degrades to one wide action. */
export const SingleDoor: Story = {
  name: 'Single door',
  args: { doors: emptyStateDoors.slice(0, 1) },
}

/** No subline — headline sits directly under the product name. */
export const NoSubline: Story = {
  name: 'No subline',
  args: { subline: '', doors: emptyStateDoors },
}

/** Default vs doored vs custom copy, stacked for the copy/spacing audit. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col divide-y divide-border">
      <ChatEmptyState />
      <ChatEmptyState doors={emptyStateDoors} />
      <ChatEmptyState
        productName="Creative"
        headline="Describe the asset you need"
        subline="The agent drafts, renders, and schedules it — you approve anything that goes out."
        doors={emptyStateDoors}
      />
    </div>
  ),
}
