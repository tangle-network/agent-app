// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { AgentSessionControls } from './agent-session-controls'
import type { CatalogModel } from '../runtime/model-catalog'

/**
 * The harness↔model coherence WIRING. The snap policy itself is unit-tested
 * in `src/harness/index.test.ts`; what this pins is that the component
 * actually applies it on every change — a swapped argument or a dropped
 * `onModelChange` call there compiles clean and only surfaces as a product
 * persisting an incoherent harness+model pair. `EntryComposer`'s `agent` prop
 * is this exact seam, so the assembly above it inherits the guarantee.
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

function renderControls(
  overrides: Partial<Parameters<typeof AgentSessionControls>[0]> = {},
) {
  const props = {
    models: MODELS,
    model: 'anthropic/claude-opus-4-8',
    onModelChange: vi.fn(),
    harness: 'claude-code' as const,
    onHarnessChange: vi.fn(),
    availableHarnesses: ['claude-code', 'opencode', 'codex'] as const,
    effort: 'medium',
    onEffortChange: vi.fn(),
    ...overrides,
  }
  render(<AgentSessionControls {...props} />)
  return props
}

describe('AgentSessionControls coherence', () => {
  it('snaps the model when the new harness cannot run it', () => {
    const { onModelChange, onHarnessChange } = renderControls()
    fireEvent.click(screen.getByTitle('Agent backend'))
    fireEvent.click(screen.getByText('Codex (OpenAI)'))
    expect(onHarnessChange).toHaveBeenCalledWith('codex')
    expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5.2')
  })

  it('keeps the model when the new harness can run it', () => {
    const { onModelChange, onHarnessChange } = renderControls()
    fireEvent.click(screen.getByTitle('Agent backend'))
    fireEvent.click(screen.getByText('OpenCode (any model)'))
    expect(onHarnessChange).toHaveBeenCalledWith('opencode')
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it("snaps the harness to the picked model's native backend", () => {
    const { onModelChange, onHarnessChange } = renderControls()
    const trigger = screen.getByText('Claude Opus 4.8').closest('button')
    if (!trigger) throw new Error('model trigger did not render')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('GPT-5.2'))
    expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5.2')
    expect(onHarnessChange).toHaveBeenCalledWith('codex')
  })
})
