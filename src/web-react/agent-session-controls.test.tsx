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

/**
 * Compact-popover GEOMETRY. jsdom computes no layout, so what is pinned is the
 * class contract that produces it: a full-width control is a `w-full` trigger
 * whose ROOT also expands — a `w-full` button inside a shrink-wrapped root
 * fills a box the button itself sized, which is exactly the shipped defect
 * (#414: Agent backend stopped short of the popover edge, Thinking was
 * narrower still). The inline half is asserted in the same file because the
 * fix is only correct if it did NOT expand the composer-row pills.
 */
function harnessTrigger(): HTMLElement {
  return screen.getByTitle('Agent backend')
}

function effortTrigger(): HTMLElement {
  const el = screen.getByTitle(/^Thinking|^Reasoning effort/)
  if (!(el instanceof HTMLButtonElement)) throw new Error('effort trigger did not render')
  return el
}

/** The picker root — the box that holds the trigger. */
function rootOf(trigger: HTMLElement): HTMLElement {
  const root = trigger.parentElement
  if (!root) throw new Error('picker root did not render')
  return root
}

function openGear(): void {
  fireEvent.click(screen.getByTitle(/^Model settings/))
}

/** The one panel currently open, wherever the portal put it. */
function openMenu(): HTMLElement {
  return screen.getByRole('menu')
}

describe('AgentSessionControls compact geometry', () => {
  it('gives Agent backend and Thinking full-width roots and triggers', () => {
    renderControls({ layout: 'compact' })
    openGear()

    for (const trigger of [harnessTrigger(), effortTrigger()]) {
      expect(trigger.className).toContain('w-full')
      expect(rootOf(trigger).className).toContain('w-full')
      expect(rootOf(trigger).className).not.toContain('inline-flex')
    }
  })

  it('gives both controls the canonical pill radius', () => {
    renderControls({ layout: 'compact' })
    openGear()

    for (const trigger of [harnessTrigger(), effortTrigger()]) {
      expect(trigger.className).toContain('rounded-full')
      expect(trigger.className).not.toContain('rounded-lg')
    }
  })

  // The menus are portaled to `<body>`, so a widened trigger cannot widen them
  // by containment — `matchTriggerWidth` is the only thing that carries the
  // width across, and it lands as an inline `min-width` on the panel.
  it('carries both trigger widths across the portal to their menus', () => {
    renderControls({ layout: 'compact' })
    openGear()

    fireEvent.click(harnessTrigger())
    expect(openMenu().getAttribute('style')).toContain('min-width')
    fireEvent.click(harnessTrigger())

    fireEvent.click(effortTrigger())
    expect(openMenu().getAttribute('style')).toContain('min-width')
  })
})

describe('AgentSessionControls inline geometry', () => {
  it('keeps the composer-row pills intrinsically sized', () => {
    renderControls()

    for (const trigger of [harnessTrigger(), effortTrigger()]) {
      expect(rootOf(trigger).className).toContain('inline-flex')
      expect(rootOf(trigger).className).not.toContain('w-full')
    }
  })

  it('still matches the canonical pill radius', () => {
    renderControls()
    expect(harnessTrigger().className).toContain('rounded-full')
  })
})
