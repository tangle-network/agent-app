import type { Meta, StoryObj } from '@storybook/react'

import { MissionActivityLane } from '../../web-react'
import { activityLaneRuns, AutoClick } from './fixtures'

/**
 * The collapsed sub-rows under a mission step — one per delegated run. The
 * live row pulses with its iter/phase chip; the "timeline" toggle expands the
 * step's waterfall (held open in the second story via AutoClick).
 */

const meta: Meta<typeof MissionActivityLane> = {
  title: 'ChatControls/MissionActivityLane',
  component: MissionActivityLane,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof MissionActivityLane>

/** Collapsed — completed + live + failed rows with cost/duration mono stats. */
export const Collapsed: Story = {
  args: {
    activity: activityLaneRuns,
    startedAt: Date.parse('2026-06-20T14:02:00Z'),
    nowMs: Date.parse('2026-06-20T14:05:00Z'),
  },
}

/** Expanded — the waterfall renders under the rows. */
export const TimelineExpanded: Story = {
  name: 'Timeline expanded',
  render: () => (
    <AutoClick>
      <MissionActivityLane
        activity={activityLaneRuns}
        startedAt={Date.parse('2026-06-20T14:02:00Z')}
        nowMs={Date.parse('2026-06-20T14:05:00Z')}
      />
    </AutoClick>
  ),
}

/** Empty lane — the component renders null; the caption stands in for it. */
export const Empty: Story = {
  render: () => (
    <div>
      <MissionActivityLane activity={[]} />
      <p className="text-xs italic text-muted-foreground">
        (the lane renders nothing for an empty activity list — this caption is the story wrapper)
      </p>
    </div>
  ),
}
