// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Chip } from '@tangle-network/ui/primitives'

import { AgentSessionControls, ChoicePicker } from './agent-session-controls'
import { PickerTrigger } from './picker-presentation'
import type { CatalogModel } from '../runtime/model-catalog'

/**
 * The harness↔model coherence WIRING. The snap policy itself is unit-tested
 * in `src/harness/index.test.ts`; what this pins is that the component
 * applies it to a pinned thread: a dropped lock check there compiles clean and
 * only surfaces as a product persisting an incoherent harness+model pair.
 */

const MODELS: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextLength: 200_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'openai/gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
    contextLength: 400_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: false,
  },
]

const LOCK_REASON = 'This thread already has messages — start a new chat to switch backend.'

describe('AgentSessionControls locked harness', () => {
  it('does not let the model→harness snap change a pinned harness', () => {
    const props = {
      models: MODELS,
      model: 'anthropic/claude-opus-4-8',
      onModelChange: vi.fn(),
      harness: 'claude-code' as const,
      onHarnessChange: vi.fn(),
      availableHarnesses: ['claude-code', 'opencode', 'codex'] as const,
      effort: 'medium',
      onEffortChange: vi.fn(),
      harnessLockReason: LOCK_REASON,
    }
    render(<AgentSessionControls {...props} />)
    const trigger = screen.getByText('Claude Opus 4.8').closest('button')
    if (!trigger) throw new Error('model trigger did not render')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Browse all models' }))
    fireEvent.click(screen.getByText('GPT-5.2'))
    expect(props.onModelChange).toHaveBeenCalledWith('openai/gpt-5.2')
    expect(props.onHarnessChange).not.toHaveBeenCalled()
  })

  it('draws model, harness and effort as the md outline Chip', () => {
    render(<Chip size="md" emphasis="outline">Budget</Chip>)
    const chip = screen.getByRole('button', { name: 'Budget' }).className.split(/\s+/)
    render(<AgentSessionControls models={MODELS} model="anthropic/claude-opus-4-8" onModelChange={vi.fn()} harness="claude-code"
      onHarnessChange={vi.fn()} availableHarnesses={['claude-code', 'codex']} effort="medium" onEffortChange={vi.fn()} />)
    const triggers = screen.getAllByRole('button', { expanded: false })
    expect(triggers.map((t) => t.title)).toContain('Harness')
    for (const t of triggers) expect(t.className.split(/\s+/)).toEqual(expect.arrayContaining(chip))
  })

  it('a host trigger keeps its caret on the label line; a choice row ellipsizes its description', () => {
    render(<PickerTrigger aria-expanded={false}>Budget</PickerTrigger>)
    const line = screen.getByRole('button', { name: 'Budget' }).lastElementChild as HTMLElement
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(['truncate']))
    expect([line.textContent, line.querySelector('svg') !== null]).toEqual(['Budget', true])
    const long = 'Draft a weekly research digest from every source the workspace watches'
    render(<ChoicePicker aria-label="Template" value="" onChange={vi.fn()} placeholder="Templates" options={[{ value: 'digest', label: 'Digest', description: long }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Template' }))
    const row = screen.getByRole('menuitemradio', { name: /Digest/ })
    expect(row.title).toBe(`Digest — ${long}`)
    expect(screen.getByText(long).className.split(/\s+/)).toEqual(expect.arrayContaining(['block', 'truncate']))
  })
})
