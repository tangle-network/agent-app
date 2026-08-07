import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { EffortPicker } from '../../web-react'
import { AutoClick, withPopoverHeadroom } from './fixtures'

/**
 * The thinking-budget pill. Only ever shown for `supportsReasoning` models —
 * that gating lives in the parent (see AgentSessionControls), not here.
 */

const meta: Meta<typeof EffortPicker> = {
  title: 'ChatControls/EffortPicker',
  component: EffortPicker,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof EffortPicker>

/** Closed pill, interactive — click to switch the reasoning budget. */
export const Interactive: Story = {
  decorators: [withPopoverHeadroom],
  render: () => {
    const [effort, setEffort] = useState('medium')
    return <EffortPicker value={effort} onChange={setEffort} />
  },
}

/** Open menu: Off / Quick / Standard / Extended. */
export const Open: Story = {
  decorators: [withPopoverHeadroom],
  render: () => {
    const [effort, setEffort] = useState('high')
    return (
      <AutoClick>
        <EffortPicker value={effort} onChange={setEffort} />
      </AutoClick>
    )
  },
}

/** Relabelled levels — ids stay stable, only the copy changes. */
export const CustomLabels: Story = {
  name: 'Custom labels',
  decorators: [withPopoverHeadroom],
  render: () => {
    const [effort, setEffort] = useState('fast')
    return (
      <EffortPicker
        value={effort}
        onChange={setEffort}
        label="Reasoning"
        levels={[
          { id: 'fast', label: 'Fast' },
          { id: 'careful', label: 'Careful' },
        ]}
      />
    )
  },
}

/** No prefix label — just the level name on the pill. */
export const NoLabel: Story = {
  name: 'No label',
  decorators: [withPopoverHeadroom],
  args: { value: 'low', onChange: () => {}, label: '' },
}

/** All four default levels side by side. */
export const AllStates: Story = {
  name: 'All states',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <EffortPicker value="off" onChange={() => {}} />
      <EffortPicker value="low" onChange={() => {}} />
      <EffortPicker value="medium" onChange={() => {}} />
      <EffortPicker value="high" onChange={() => {}} />
    </div>
  ),
}
