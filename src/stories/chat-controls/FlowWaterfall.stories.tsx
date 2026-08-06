import type { Meta, StoryObj } from '@storybook/react'

import { FlowWaterfall } from '../../web-react'
import { failedFlowTrace, posterFlowTrace } from './fixtures'

/**
 * The compact proportional waterfall behind the activity lane's "timeline"
 * toggle. Bars: pipeline (muted), model (primary/60), tool (primary); a failed
 * span goes destructive; `approx` bars render at 70% opacity with a `~`.
 */

const meta: Meta<typeof FlowWaterfall> = {
  title: 'ChatControls/FlowWaterfall',
  component: FlowWaterfall,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FlowWaterfall>

/** Healthy trace — five spans, total + cost in the footer. */
export const Healthy: Story = {
  args: { trace: posterFlowTrace },
}

/** A failed tool span renders in the destructive tone. */
export const WithFailure: Story = {
  name: 'With failure',
  args: { trace: failedFlowTrace },
}

/** Both traces stacked for the tone comparison. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Healthy</p>
        <FlowWaterfall trace={posterFlowTrace} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">With failure</p>
        <FlowWaterfall trace={failedFlowTrace} />
      </div>
    </div>
  ),
}
