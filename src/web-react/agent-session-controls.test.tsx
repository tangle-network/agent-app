// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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

/**
 * The LOCKED harness contract. A thread that already has messages cannot change
 * backend, and the shape that state has to keep is a visible selector reporting
 * the harness the thread is on — hiding it (`showHarness: false`) is what drove
 * products to render their own lock label outside the panel, which is the
 * regression this replaces.
 *
 * The lock is asserted by BEHAVIOUR (no menu, no `onHarnessChange`) rather than
 * by the presence of a disabled attribute, because the native `disabled` is
 * exactly what this must not use: it drops the control out of the tab order and
 * swallows pointer events, so the one control with something to explain becomes
 * the one that cannot be asked.
 */
const LOCK_REASON = 'This thread already has messages — start a new chat to switch backend.'

describe('AgentSessionControls locked harness', () => {
  it('keeps the backend visible and reporting the current harness', () => {
    renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    expect(harnessTrigger().textContent).toContain('Claude Code (Anthropic)')
  })

  it('opens no menu and never emits a harness change', () => {
    const { onHarnessChange } = renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    fireEvent.click(harnessTrigger())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onHarnessChange).not.toHaveBeenCalled()
  })

  it('stays reachable and answerable — aria-disabled, not the native disabled', () => {
    renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    const trigger = harnessTrigger()
    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    expect(trigger.hasAttribute('disabled')).toBe(false)
    // Nothing to expand any more, so the popup contract comes off with it.
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBeNull()
  })

  it('names the reason to assistive tech whether or not the hint is up', () => {
    renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    const describedBy = harnessTrigger().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(LOCK_REASON)
  })

  it('shows the reason on POINTER hover', () => {
    renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(harnessTrigger())
    expect(screen.getByRole('tooltip').textContent).toBe(LOCK_REASON)
    fireEvent.mouseLeave(harnessTrigger())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the reason on KEYBOARD focus — the half a native disabled would lose', () => {
    renderControls({ layout: 'compact', harnessLockReason: LOCK_REASON })
    openGear()
    fireEvent.focus(harnessTrigger())
    expect(screen.getByRole('tooltip').textContent).toBe(LOCK_REASON)
    fireEvent.blur(harnessTrigger())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('locks the inline layout too — a pinned thread is a domain state, not a layout', () => {
    const { onHarnessChange } = renderControls({ harnessLockReason: LOCK_REASON })
    fireEvent.click(harnessTrigger())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onHarnessChange).not.toHaveBeenCalled()
    fireEvent.focus(harnessTrigger())
    expect(screen.getByRole('tooltip').textContent).toBe(LOCK_REASON)
  })

  it('does not let the model→harness snap change a pinned harness', () => {
    // Unlocked, this exact click snaps the harness to codex (asserted above).
    const { onModelChange, onHarnessChange } = renderControls({ harnessLockReason: LOCK_REASON })
    const trigger = screen.getByText('Claude Opus 4.8').closest('button')
    if (!trigger) throw new Error('model trigger did not render')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('GPT-5.2'))
    expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5.2')
    expect(onHarnessChange).not.toHaveBeenCalled()
  })

  it('leaves an UNLOCKED harness fully selectable', () => {
    const { onHarnessChange } = renderControls({ layout: 'compact' })
    openGear()
    const trigger = harnessTrigger()
    expect(trigger.getAttribute('aria-disabled')).toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('true')
    fireEvent.mouseEnter(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('OpenCode (any model)'))
    expect(onHarnessChange).toHaveBeenCalledWith('opencode')
  })
})

/**
 * The trigger VARIANT threads to every child. `chip` (default) keeps the
 * bordered pills every consumer renders today; `quiet` strips the border from
 * the model, harness, AND effort triggers — a variant that reached two of the
 * three would put a lone pill on a row of text buttons, the exact "pile of
 * unrelated widgets" the shared geometry exists to prevent. Pinned per trigger
 * and per layout, because the compact panel mounts its own instances.
 */
function modelTrigger(): HTMLElement {
  const trigger = screen.getByText('Claude Opus 4.8').closest('button')
  if (!trigger) throw new Error('model trigger did not render')
  return trigger
}

const classesOf = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean)
const borderClasses = (el: HTMLElement) => classesOf(el).filter((c) => /^border(-|$)/.test(c))

describe('AgentSessionControls trigger variant', () => {
  it('defaults every trigger to the bordered chip', () => {
    renderControls()
    for (const trigger of [modelTrigger(), harnessTrigger(), effortTrigger()]) {
      expect(classesOf(trigger)).toContain('border')
      expect(classesOf(trigger)).toContain('border-border')
      expect(classesOf(trigger)).toContain('rounded-full')
    }
  })

  it('quiet strips the border and pill radius from all three inline triggers', () => {
    renderControls({ variant: 'quiet' })
    for (const trigger of [modelTrigger(), harnessTrigger(), effortTrigger()]) {
      expect(borderClasses(trigger)).toEqual([])
      expect(classesOf(trigger)).not.toContain('rounded-full')
      expect(classesOf(trigger)).not.toContain('bg-card')
      expect(classesOf(trigger)).toContain('h-7')
      expect(classesOf(trigger)).toContain('font-normal')
    }
  })

  it('quiet reaches the compact panel controls and keeps them full width', () => {
    renderControls({ layout: 'compact', variant: 'quiet' })
    expect(borderClasses(modelTrigger())).toEqual([])
    openGear()
    for (const trigger of [harnessTrigger(), effortTrigger()]) {
      expect(borderClasses(trigger)).toEqual([])
      expect(classesOf(trigger)).toContain('w-full')
    }
  })

  it('a pinned quiet harness draws no hover or open fill', () => {
    renderControls({ variant: 'quiet', harnessLockReason: LOCK_REASON })
    const classes = classesOf(harnessTrigger())
    expect(classes).toContain('cursor-default')
    expect(classes).not.toContain('hover:bg-accent')
    expect(classes).not.toContain('data-[state=open]:bg-accent')
    // and the unpinned one does
    cleanup()
    renderControls({ variant: 'quiet' })
    expect(classesOf(harnessTrigger())).toContain('hover:bg-accent')
  })

  it('quiet changes the triggers only — the coherence policy still runs', () => {
    const { onModelChange, onHarnessChange } = renderControls({ variant: 'quiet' })
    fireEvent.click(harnessTrigger())
    fireEvent.click(screen.getByText('Codex (OpenAI)'))
    expect(onHarnessChange).toHaveBeenCalledWith('codex')
    expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5.2')
  })
})
