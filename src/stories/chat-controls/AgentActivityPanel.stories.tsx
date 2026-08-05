import type { Meta, StoryObj } from '@storybook/react'

import { AgentActivityPanel } from '../../web-react'
import {
  fetchActivityEmpty,
  fetchActivityError,
  fetchActivityHangs,
  fetchActivityPopulated,
} from './fixtures'

/**
 * The standalone cross-context delegation surface. Rows expand on click (drill
 * into waterfall, task/started/trace ids, mission link); "Older runs" pages
 * through the fake cursor port.
 */

const meta: Meta<typeof AgentActivityPanel> = {
  title: 'ChatControls/AgentActivityPanel',
  component: AgentActivityPanel,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof AgentActivityPanel>

/** Populated — four rows across statuses, paged; one carries a mission link. */
export const Populated: Story = {
  args: {
    fetchActivity: fetchActivityPopulated,
    renderMissionRef: (ref) => (
      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
        {ref.label ?? ref.missionId}
      </span>
    ),
  },
}

/** First page resolves empty — the empty label renders. */
export const Empty: Story = {
  args: { fetchActivity: fetchActivityEmpty },
}

/** The data port rejects — the inline error row replaces the list. */
export const LoadError: Story = {
  name: 'Load error',
  args: { fetchActivity: fetchActivityError },
}

/** The port never settles — refresh spinner holds, no empty flash. */
export const Loading: Story = {
  args: { fetchActivity: fetchActivityHangs },
}

/** Populated vs empty vs error stacked — the panel's three bodies. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Populated</p>
        <AgentActivityPanel
          fetchActivity={fetchActivityPopulated}
          renderMissionRef={(ref) => (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {ref.label ?? ref.missionId}
            </span>
          )}
        />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Empty</p>
        <AgentActivityPanel fetchActivity={fetchActivityEmpty} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Load error</p>
        <AgentActivityPanel fetchActivity={fetchActivityError} />
      </div>
    </div>
  ),
}
