import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { AgentSessionControls, HarnessGlyph, type AgentSessionControlsProps } from '../../web-react'
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

/** A wider harness list for the glyph stories — every branded mark plus the
 *  lucide fallbacks, so the menu shows the whole vocabulary at once. */
const GLYPH_HARNESSES: Harness[] = [
  'opencode',
  'claude-code',
  'codex',
  'kimi-code',
  'amp',
  'openclaw',
  'hermes',
  'factory-droids',
  'nanoclaw',
  'cli-base',
]

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

/**
 * Compact with the gear popover held open — the plain-English settings copy,
 * and the state to eyeball for #414: Agent backend and Thinking must both
 * reach the panel's inner edge and carry the same pill radius as the model
 * selector, so the panel reads as one control stack.
 */
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

/** Harness menu held open across the branded set — every mark visible in its
 *  row, selected one checked. */
export const HarnessMenuOpen: Story = {
  name: 'Harness menu open',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="pt-[460px]">
      <AutoClick selector="button[title='Agent backend']">
        {useSessionControls({ availableHarnesses: GLYPH_HARNESSES })}
      </AutoClick>
    </div>
  ),
}

/**
 * Close-up for design review: every harness mark next to its name — the
 * vendored brand artwork (currentColor, so it tracks the theme), the lucide
 * fallbacks for harnesses with no published mark, and the neutral bot an
 * unknown id falls back to.
 */
export const Glyphs: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-col gap-8 p-4">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Brand marks</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {(['opencode', 'claude-code', 'codex', 'kimi-code', 'amp', 'openclaw', 'hermes'] as Harness[]).map((h) => (
            <span key={h} className="inline-flex items-center gap-2 text-sm text-foreground">
              <HarnessGlyph harness={h} className="h-5 w-5 text-foreground" />
              {h}
            </span>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Fallbacks (no published mark) + unknown id
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {(['factory-droids', 'nanoclaw', 'cli-base'] as Harness[]).map((h) => (
            <span key={h} className="inline-flex items-center gap-2 text-sm text-foreground">
              <HarnessGlyph harness={h} className="h-5 w-5 text-foreground" />
              {h}
            </span>
          ))}
          <span className="inline-flex items-center gap-2 text-sm text-foreground">
            <HarnessGlyph harness={'made-up-harness' as Harness} className="h-5 w-5 text-foreground" />
            made-up-harness (unknown)
          </span>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">In the trigger pill</p>
        <div className="flex flex-wrap items-center gap-3">
          {(['opencode', 'claude-code', 'codex'] as Harness[]).map((h) => (
            <AgentSessionControls
              key={h}
              models={catalogModels}
              model={DEFAULT_MODEL_ID}
              onModelChange={() => {}}
              harness={h}
              onHarnessChange={() => {}}
              availableHarnesses={GLYPH_HARNESSES}
              effort="medium"
              onEffortChange={() => {}}
            />
          ))}
        </div>
      </div>
    </div>
  ),
}
