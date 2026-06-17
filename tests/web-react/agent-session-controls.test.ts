// @vitest-environment jsdom
/**
 * AgentSessionControls: layout switching (inline default vs compact gear) and
 * the harness↔model coherence policy applied on every change. The coherence
 * rules themselves live in `src/harness`; here we prove the component wires them
 * through and that the additive `layout` prop defaults to the prior behavior.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentSessionControls } from '../../src/web-react/agent-session-controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

afterEach(cleanup)

const MODELS: CatalogModel[] = [
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus', provider: 'anthropic', supportsTools: true, supportsReasoning: true, featured: true },
  { id: 'openai/gpt-5', name: 'GPT-5', provider: 'openai', supportsTools: true, supportsReasoning: true, featured: true },
]

function setup(overrides: Partial<Parameters<typeof AgentSessionControls>[0]> = {}) {
  const onModelChange = vi.fn()
  const onHarnessChange = vi.fn()
  const onEffortChange = vi.fn()
  render(
    createElement(AgentSessionControls, {
      models: MODELS,
      model: 'anthropic/claude-opus-4-6',
      onModelChange,
      harness: 'claude-code',
      onHarnessChange,
      effort: 'medium',
      onEffortChange,
      ...overrides,
    }),
  )
  return { onModelChange, onHarnessChange, onEffortChange }
}

describe('layout', () => {
  it('default (inline) renders the harness pill directly (no gear)', () => {
    setup()
    // The harness label is visible inline, not hidden behind a gear.
    expect(screen.getByText('Claude Code (Anthropic)')).toBeTruthy()
    expect(screen.queryByTitle(/Model settings/)).toBeNull()
  })

  it('compact renders a gear and hides advanced controls until opened', () => {
    setup({ layout: 'compact' })
    const gear = screen.getByTitle(/Model settings/)
    expect(gear).toBeTruthy()
    // harness label not in the DOM until the popover opens
    expect(screen.queryByText('Claude Code (Anthropic)')).toBeNull()
    fireEvent.click(gear)
    expect(screen.getByText('Claude Code (Anthropic)')).toBeTruthy()
    expect(screen.getByText('Agent backend')).toBeTruthy()
    expect(screen.getByText('Reasoning effort')).toBeTruthy()
  })
})

describe('harness↔model coherence', () => {
  it('selecting an incompatible harness snaps the model to that backend', () => {
    const { onHarnessChange, onModelChange } = setup()
    // open the harness picker and pick codex (OpenAI-only)
    fireEvent.click(screen.getByText('Claude Code (Anthropic)'))
    fireEvent.click(screen.getByText('Codex (OpenAI)'))
    expect(onHarnessChange).toHaveBeenCalledWith('codex')
    // current model (anthropic) is incompatible with codex → snapped to gpt-5
    expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5')
  })

  it('compatible harness change does not force a model change', () => {
    const { onHarnessChange, onModelChange } = setup({ harness: 'opencode' })
    fireEvent.click(screen.getByText('OpenCode (any model)'))
    fireEvent.click(screen.getByText('Claude Code (Anthropic)'))
    expect(onHarnessChange).toHaveBeenCalledWith('claude-code')
    // claude-code can run the anthropic model → no model snap
    expect(onModelChange).not.toHaveBeenCalled()
  })
})

describe('effort visibility', () => {
  it('hides the effort picker when the selected model lacks reasoning support', () => {
    const noReason: CatalogModel[] = [{ ...MODELS[0]!, supportsReasoning: false }]
    setup({ models: noReason, model: noReason[0]!.id })
    // "Medium" is the effort pill's default label; absent when effort is hidden
    expect(screen.queryByText('Medium')).toBeNull()
  })
})
