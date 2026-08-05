import type { Meta, StoryObj } from '@storybook/react'

import { WorkProductCard } from '../../web-react'
import { openWorkProduct, workProductParts } from './fixtures'

/**
 * The transcript anchor card for one work-product version. One story per
 * status pill tone; the composite stacks all six so the tones read as a set.
 */

const meta: Meta<typeof WorkProductCard> = {
  title: 'ChatControls/WorkProductCard',
  component: WorkProductCard,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof WorkProductCard>

/** The part fixtures are indexed by status order in `workProductParts`. */
const [draft, ready, changesRequested, approved, blocked, superseded] = workProductParts

export const Draft: Story = {
  args: { part: draft ?? workProductParts[0]!, onOpen: openWorkProduct },
}

export const ReadyForReview: Story = {
  name: 'Ready for review',
  args: { part: ready ?? workProductParts[0]!, onOpen: openWorkProduct },
}

export const ChangesRequested: Story = {
  name: 'Changes requested',
  args: { part: changesRequested ?? workProductParts[0]!, onOpen: openWorkProduct },
}

export const Approved: Story = {
  args: { part: approved ?? workProductParts[0]!, onOpen: openWorkProduct },
}

export const Blocked: Story = {
  args: { part: blocked ?? workProductParts[0]!, onOpen: openWorkProduct },
}

export const Superseded: Story = {
  args: { part: superseded ?? workProductParts[0]!, onOpen: openWorkProduct },
}

/** No `onOpen` — the Review button drops out, the card is a pure pointer. */
export const ReadOnly: Story = {
  name: 'Read-only (no Review button)',
  args: { part: ready ?? workProductParts[0]! },
}

/** All six status tones stacked — the set read at a glance. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-2.5">
      {workProductParts.map((part) => (
        <WorkProductCard key={part.status} part={part} onOpen={openWorkProduct} />
      ))}
      <WorkProductCard part={ready ?? workProductParts[0]!} />
    </div>
  ),
}
