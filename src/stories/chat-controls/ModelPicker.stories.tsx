import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { ModelPicker, type CatalogModel } from '../../web-react'
import { AutoClick, catalogModels, DEFAULT_MODEL_ID, withPopoverHeadroom } from './fixtures'

/**
 * The searchable model pill — THE canonical ecosystem model picker
 * (`agent-app/web-react`; see "UI chrome ownership (picker canon)" in
 * AGENTS.md). sandbox-ui's `dashboard/ModelPicker` and the model menu inside
 * its `chat/AgentSessionControls` are legacy and frozen; every product surface
 * should render this one.
 *
 * The popover opens UPWARD from the trigger, so popover stories wrap in
 * `withPopoverHeadroom` — it anchors the trigger at the bottom of a tall
 * canvas block so the popover opens into real positive-Y space (negative-Y
 * overflow is unscrollable). `AutoClick` presses the trigger on mount — the
 * only way to hold the popover open for a static shot.
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
  decorators: [withPopoverHeadroom],
  render: () => {
    const [model, setModel] = useState(DEFAULT_MODEL_ID)
    return <ModelPicker value={model} onChange={setModel} models={catalogModels} />
  },
}

/** Open popover: Recommended section, then per-provider groups. */
export const Open: Story = {
  decorators: [withPopoverHeadroom],
  render: () => {
    const [model, setModel] = useState(DEFAULT_MODEL_ID)
    return (
      <AutoClick>
        <ModelPicker value={model} onChange={setModel} models={catalogModels} />
      </AutoClick>
    )
  },
}

const currentModels: CatalogModel[] = [
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: false },
  { id: 'gpt-4.1-mini', name: 'GPT 4.1 Mini', provider: 'openai', supportsTools: true, supportsReasoning: false, featured: false },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', supportsTools: true, supportsReasoning: true, featured: false },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', provider: 'google', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna', provider: 'openai', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: true },
]

/** Current launches render first; old models remain available lower down. */
export const FreshnessOrdering: Story = {
  name: 'Current launch ordering',
  decorators: [withPopoverHeadroom],
  render: () => (
    <AutoClick>
      <ModelPicker
        value="claude-fable-5-1"
        onChange={() => {}}
        models={currentModels}
      />
    </AutoClick>
  ),
}

/** Catalogue still loading — the popover shows its loading line. */
export const Loading: Story = {
  decorators: [withPopoverHeadroom],
  render: () => (
    <AutoClick>
      <ModelPicker value="claude-fable-5-1" onChange={() => {}} models={[]} loading />
    </AutoClick>
  ),
}

/** A product's own fine-tuned models pinned above Recommended. */
export const PriorityGroup: Story = {
  name: 'Priority group',
  decorators: [withPopoverHeadroom],
  render: () => {
    const [model, setModel] = useState('deepseek/deepseek-chat')
    return (
      <AutoClick>
        <ModelPicker
          value={model}
          onChange={setModel}
          models={catalogModels}
          priorityGroup={{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'deepseek' }}
        />
      </AutoClick>
    )
  },
}

/** `variant="quiet"`: the borderless text-button trigger, beside the default
 *  chip for comparison. Same menu behind both. */
export const Quiet: Story = {
  decorators: [withPopoverHeadroom],
  render: () => {
    const [model, setModel] = useState(DEFAULT_MODEL_ID)
    return (
      <div className="flex items-center gap-4">
        <ModelPicker value={model} onChange={setModel} models={catalogModels} />
        <ModelPicker value={model} onChange={setModel} models={catalogModels} variant="quiet" />
      </div>
    )
  },
}

/** Value with no catalogue match — the pill falls back to the raw id. */
export const UnknownValue: Story = {
  name: 'Unknown value',
  decorators: [withPopoverHeadroom],
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
      <ModelPicker value="claude-fable-5-1" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="gpt-5.6-luna" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="deepseek/deepseek-chat" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="acme/unreleased-model" onChange={() => {}} models={catalogModels} />
      <ModelPicker value="claude-fable-5-1" onChange={() => {}} models={[]} loading />
    </div>
  ),
}
