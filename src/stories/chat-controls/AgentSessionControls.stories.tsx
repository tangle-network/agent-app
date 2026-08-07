import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { AgentSessionControls, type AgentSessionControlsProps } from '../../web-react'
import type { Harness } from '../../harness'
import { AutoClick, catalogModels, DEFAULT_MODEL_ID, NON_REASONING_MODEL_ID, withPopoverHeadroom } from './fixtures'

/**
 * The model + harness + effort cluster a composer docks — the CANONICAL
 * session-controls surface: its model menu is the canonical `ModelPicker` and
 * its thinking pill is `EffortPicker` (see "UI chrome ownership (picker
 * canon)" in AGENTS.md). Both layouts are
 * interactive: switching the harness snaps an incompatible model to that
 * harness's catalog option, and switching the model snaps the harness — the
 * coherence policy runs in the component, so these stories exercise it live.
 */

const HARNESSES: Harness[] = ['opencode', 'claude-code', 'codex']

function useSessionControls(options: Partial<AgentSessionControlsProps> & { initialModel?: string } = {}) {
  const { initialModel, ...overrides } = options
  const [model, setModel] = useState(initialModel ?? DEFAULT_MODEL_ID)
  const [harness, setHarness] = useState<Harness>('opencode')
  const [effort, setEffort] = useState('medium')
  return (
    <AgentSessionControls
      models={catalogModels}
      model={model}
      onModelChange={setModel}
      harness={harness}
      onHarnessChange={setHarness}
      availableHarnesses={HARNESSES}
      effort={effort}
      onEffortChange={setEffort}
      {...overrides}
    />
  )
}

const meta: Meta<typeof AgentSessionControls> = {
  title: 'ChatControls/AgentSessionControls',
  component: AgentSessionControls,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof AgentSessionControls>

/** Inline (default): model, harness, and effort pills side by side. */
export const Inline: Story = {
  decorators: [withPopoverHeadroom],
  render: () => useSessionControls(),
}

/** Compact: the model stays inline; harness + effort tuck behind the gear. */
export const Compact: Story = {
  decorators: [withPopoverHeadroom],
  render: () => useSessionControls({ layout: 'compact' }),
}

/** Compact with the gear popover held open — the plain-English settings copy. */
export const CompactOpen: Story = {
  name: 'Compact — gear open',
  decorators: [withPopoverHeadroom],
  render: () => (
    <AutoClick selector="button[title^='Model settings']">
      {useSessionControls({ layout: 'compact' })}
    </AutoClick>
  ),
}

/** Single-harness product — the harness pill is hidden entirely. */
export const HarnessHidden: Story = {
  name: 'Harness hidden',
  decorators: [withPopoverHeadroom],
  render: () => useSessionControls({ showHarness: false }),
}

/** A non-reasoning model selected — the effort pill drops out. */
export const NonReasoningModel: Story = {
  name: 'Non-reasoning model',
  decorators: [withPopoverHeadroom],
  render: () => useSessionControls({ initialModel: NON_REASONING_MODEL_ID }),
}

/** Catalogue still loading — the model pill renders its loading state. */
export const ModelsLoading: Story = {
  name: 'Models loading',
  decorators: [withPopoverHeadroom],
  render: () => useSessionControls({ models: [], modelsLoading: true }),
}

/** Both layouts stacked so the pill rhythm can be compared at a glance. */
export const AllStates: Story = {
  name: 'All states',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Inline</p>
        {useSessionControls()}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Compact</p>
        {useSessionControls({ layout: 'compact' })}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Harness hidden</p>
        {useSessionControls({ showHarness: false })}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Non-reasoning model</p>
        {useSessionControls({ initialModel: NON_REASONING_MODEL_ID })}
      </div>
    </div>
  ),
}
