import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { EffortPicker, EffortMeter, effortMeterFill, DEFAULT_EFFORT_LEVELS } from '../../web-react'
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

/**
 * `fullWidth` — the opt-in the compact `AgentSessionControls` popover uses. The
 * default pill (top) shrink-wraps so a composer row's neighbours stay put; the
 * `fullWidth` pill (bottom) fills the stack and parks its chevron on the
 * trailing edge. Both are shown against the same box so the difference is the
 * point of the story.
 */
export const FullWidth: Story = {
  name: 'Full width (stacked panel)',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="w-72 space-y-3 rounded-xl border border-border bg-card p-3">
      <EffortPicker value="medium" onChange={() => {}} label="" />
      <EffortPicker value="medium" onChange={() => {}} label="" fullWidth />
    </div>
  ),
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

/**
 * Close-up for design review: the thinking glyph + strength meter ladder at
 * every level. Top row is the real trigger per level; below, the bare meter
 * at 2× so the fill count and the translucent→heavy opacity ramp can be
 * compared side by side.
 */
export const Glyphs: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-col gap-8 p-4">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Trigger per level
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {DEFAULT_EFFORT_LEVELS.map((l) => (
            <EffortPicker key={l.id} value={l.id} onChange={() => {}} />
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Meter ladder (2×)
        </p>
        <div className="flex items-end gap-8">
          {DEFAULT_EFFORT_LEVELS.map((l) => (
            <div key={l.id} className="flex flex-col items-start gap-1.5">
              <EffortMeter
                fill={effortMeterFill(l.id)}
                className="origin-left scale-[2] text-foreground"
              />
              <span className="text-xs text-muted-foreground">
                {l.label} · {effortMeterFill(l.id)}/4
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
}
