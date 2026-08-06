import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { ModelPicker } from '../../web-react'
import { AutoClick, catalogModels, DEFAULT_MODEL_ID } from './fixtures'

/**
 * The searchable model pill — THE canonical ecosystem model picker
 * (`agent-app/web-react`; see "UI chrome ownership (picker canon)" in
 * AGENTS.md). sandbox-ui's `dashboard/ModelPicker` and the model menu inside
 * its `chat/AgentSessionControls` are legacy and frozen; every product surface
 * should render this one.
 *
 * The popover opens UPWARD from the trigger, so the open-state stories pad the
 * wrapper's top to keep the popover inside the canvas. `AutoClick` presses the
 * trigger on mount — the only way to hold the popover open for a static shot.
 */

const meta: Meta<typeof ModelPicker> = {
  title: 'ChatControls/ModelPicker',
  component: ModelPicker,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof ModelPicker>

/** Closed pill, interactive — click to search and pick. */
export const Interactive: Story = {
  render: () => {
    const [model, setModel] = useState(DEFAULT_MODEL_ID)
    return <ModelPicker value={model} onChange={setModel} models={catalogModels} />
  },
}

/** Open popover: Recommended section, then per-provider groups. */
export const Open: Story = {
  parameters: { layout: 'padded' },
  render: () => {
    const [model, setModel] = useState(DEFAULT_MODEL_ID)
    return (
      <div className="pt-[470px]">
        <AutoClick>
          <ModelPicker value={model} onChange={setModel} models={catalogModels} />
        </AutoClick>
      </div>
    )
  },
}

/** Catalogue still loading — the popover shows its loading line. */
export const Loading: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="pt-[470px]">
      <AutoClick>
        <ModelPicker value="anthropic/claude-opus-4" onChange={() => {}} models={[]} loading />
      </AutoClick>
    </div>
  ),
}

/** A product's own fine-tuned models pinned above Recommended. */
export const PriorityGroup: Story = {
  name: 'Priority group',
  parameters: { layout: 'padded' },
  render: () => {
    const [model, setModel] = useState('deepseek/deepseek-chat')
    return (
      <div className="pt-[470px]">
        <AutoClick>
          <ModelPicker
            value={model}
            onChange={setModel}
            models={catalogModels}
            priorityGroup={{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'deepseek' }}
          />
        </AutoClick>
      </div>
    )
  },
}

/** Value with no catalogue match — the pill falls back to the raw id. */
export const UnknownValue: Story = {
  name: 'Unknown value',
  args: {
    value: 'acme/unreleased-model',
    onChange: () => {},
    models: catalogModels,
  },
}

/** Every closed-pill reading side by side: featured, plain, no-tools, unknown. */
export const AllStates: Story = {
  name: 'All states',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <ModelPicker value="anthropic/claude-opus-4" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="google/gemini-2.5-pro" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="deepseek/deepseek-chat" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="acme/unreleased-model" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="anthropic/claude-opus-4" onChange={() => {}} models={[]} loading />
    </div>
  ),
}
