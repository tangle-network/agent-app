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
  const view = render(
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
  return { onModelChange, onHarnessChange, onEffortChange, unmount: view.unmount }
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
    expect(screen.getByText('Thinking')).toBeTruthy()
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
    const reasoning = setup({ effort: 'medium' })
    // The default vocabulary is Off/Quick/Standard/Extended — assert against a
    // label the picker actually renders, or the check passes on any tree.
    expect(screen.getByText('Standard')).toBeTruthy()
    reasoning.unmount()

    const noReason: CatalogModel[] = [{ ...MODELS[0]!, supportsReasoning: false }]
    setup({ models: noReason, model: noReason[0]!.id, effort: 'medium' })
    expect(screen.queryByText('Standard')).toBeNull()
  })
})

describe('effort levels', () => {
  // A product whose backend applies only a subset of the levels for the
  // selected harness/model must be able to say so. Without this the strip
  // offers every level and the backend silently ignores the ones it does not
  // apply — a control reporting a choice the system never made.
  it('offers only the levels the product declares, in both layouts', () => {
    const levels = [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ] as const

    setup({ effort: 'low', effortLevels: levels })
    fireEvent.click(screen.getByText('Low'))

    expect(screen.getByText('High')).toBeTruthy()
    expect(screen.queryByText('Standard')).toBeNull()

    cleanup()

    setup({ effort: 'low', effortLevels: levels, layout: 'compact' })
    fireEvent.click(screen.getByTitle(/Model settings/))
    fireEvent.click(screen.getByText('Low'))
    expect(screen.queryByText('Standard')).toBeNull()
  })

  it('falls back to the default vocabulary when the product declares none', () => {
    setup({ effort: 'medium' })
    expect(screen.getByText('Standard')).toBeTruthy()
  })
})
