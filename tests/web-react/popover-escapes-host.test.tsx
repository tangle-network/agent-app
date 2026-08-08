// @vitest-environment jsdom
/**
 * The canonical pickers must survive the container a HOST mounts them in.
 *
 * The defect this pins shipped to production: the composer docks the model and
 * thinking pills inside a horizontally scrolling control rail
 * (`overflow-x-auto`), a scroll container clips every positioned descendant
 * whose containing block sits inside it, and an in-place `absolute` menu was
 * therefore erased — right roles, right items, right `getBoundingClientRect()`,
 * zero pixels painted, no click able to land. Every existing popover test was
 * green through all of it, because presence in the DOM is not visibility.
 *
 * Visibility itself is a cascade question no static test can answer — the
 * ground truth is `playground/scripts/popover-hit-test.mjs`, which drives real
 * Chromium and asserts `document.elementFromPoint` at the panel's own centre
 * returns the panel. What IS checkable here is the structural invariant that
 * makes the cascade question moot, and it is the invariant that was violated:
 *
 *   a canonical picker panel is never a descendant of its host.
 *
 * Portaled to `document.body`, no ancestor `overflow`, `transform`, `filter`,
 * `contain` or stacking context can reach it. Leave the panel inside the
 * trigger's subtree and this file goes red — which is what the browser audit
 * measured 10 popovers failing on before the portal landed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { AgentSessionControls } from '../../src/web-react/agent-session-controls'
import { POPOVER_SURFACE_ATTR } from '../../src/web-react/controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

afterEach(cleanup)

const MODELS: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    contextLength: 1_000_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextLength: 2_000_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: false,
  },
]

const HOST_ID = 'host-scroll-rail'

/**
 * The host container that broke the pickers, reproduced by MECHANISM rather
 * than by class name: jsdom compiles no Tailwind, so `overflow-x-auto` would
 * be an inert string here. The inline style is what `overflow-x-auto` computes
 * to in the shipped `@tangle-network/sandbox-ui` composer rail.
 */
function ScrollRailHost({ children }: { children: ReactNode }) {
  return createElement('div', { id: HOST_ID, style: { overflowX: 'auto', display: 'flex' } }, children)
}

function renderInHost(props: Partial<Parameters<typeof AgentSessionControls>[0]> = {}) {
  const onModelChange = vi.fn()
  const onHarnessChange = vi.fn()
  const onEffortChange = vi.fn()
  render(
    createElement(
      ScrollRailHost,
      null,
      createElement(AgentSessionControls, {
        models: MODELS,
        model: MODELS[0]!.id,
        onModelChange,
        harness: 'claude-code',
        onHarnessChange,
        effort: 'medium',
        onEffortChange,
        ...props,
      }),
    ),
  )
  return { onModelChange, onHarnessChange, onEffortChange }
}

function host(): HTMLElement {
  const el = document.getElementById(HOST_ID)
  if (!el) throw new Error('host rail did not render')
  return el
}

function openPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${POPOVER_SURFACE_ATTR}]`))
}

/** Every assertion that makes a host container unable to hide the panel. */
function expectEscapesHost(panel: HTMLElement) {
  expect(host().contains(panel), 'panel is inside the clipping host — a scroll container erases it').toBe(false)
  expect(panel.parentElement, 'panel must portal to document.body').toBe(document.body)
  expect(panel.style.position, 'viewport-anchored placement').toBe('fixed')
}

describe('canonical picker popovers escape their host container', () => {
  it('the model panel portals out of a scrolling host', () => {
    renderInHost()
    fireEvent.click(screen.getByRole('button', { name: /Claude Opus 4/ }))
    const panel = openPanels()
    expect(panel).toHaveLength(1)
    expectEscapesHost(panel[0]!)
    // Content is the real menu, not an empty shell that would satisfy the
    // structural assertions on their own.
    expect(within(panel[0]!).getByPlaceholderText('Search models...')).toBeTruthy()
    expect(within(panel[0]!).getByRole('button', { name: /Gemini 2\.5 Pro/ })).toBeTruthy()
  })

  it('the thinking panel portals out of a scrolling host', () => {
    renderInHost()
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }))
    const panel = openPanels()
    expect(panel).toHaveLength(1)
    expectEscapesHost(panel[0]!)
    expect(within(panel[0]!).getAllByRole('menuitemradio').map((o) => o.textContent?.trim())).toEqual([
      'Off',
      'Quick',
      'Standard',
      'Extended',
    ])
  })

  it('the harness panel portals out of a scrolling host', () => {
    renderInHost()
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    const panel = openPanels()
    expect(panel).toHaveLength(1)
    expectEscapesHost(panel[0]!)
  })

  it('the compact settings panel portals out of a scrolling host', () => {
    renderInHost({ layout: 'compact' })
    const triggers = screen.getAllByRole('button', { expanded: false })
    fireEvent.click(triggers[triggers.length - 1]!)
    const panel = openPanels()
    expect(panel).toHaveLength(1)
    expectEscapesHost(panel[0]!)
    expect(panel[0]!.textContent).toContain('Agent backend')
  })

  it('a click on a portaled row still reaches its handler', () => {
    // The outside-mousedown test used to be "is the target inside the trigger's
    // container". A portaled panel is not, so without the panel-aware test the
    // popover closes on mousedown and the row's click never fires — the picker
    // would look fixed and still select nothing.
    const { onModelChange } = renderInHost()
    fireEvent.click(screen.getByRole('button', { name: /Claude Opus 4/ }))
    const row = within(openPanels()[0]!).getByRole('button', { name: /Gemini 2\.5 Pro/ })
    fireEvent.mouseDown(row)
    fireEvent.click(row)
    expect(onModelChange).toHaveBeenCalledWith('google/gemini-2.5-pro')
  })

  it('a popover opened from inside another popover does not close its owner', () => {
    // Both panels portal to body, so they are SIBLINGS: `contains` cannot see
    // the nesting and the outer popover would read a click on the inner one as
    // outside. The surfaces carry their ancestor path so descendancy survives.
    renderInHost({ layout: 'compact' })
    const gear = screen.getAllByRole('button', { expanded: false }).at(-1)!
    fireEvent.click(gear)
    const gearPanel = openPanels()[0]!
    const innerTrigger = within(gearPanel).getByRole('button', { name: /Claude Code/ })

    fireEvent.mouseDown(innerTrigger)
    fireEvent.click(innerTrigger)

    expect(gear.getAttribute('aria-expanded')).toBe('true')
    const panels = openPanels()
    expect(panels).toHaveLength(2)
    const paths = panels.map((p) => p.getAttribute(POPOVER_SURFACE_ATTR)!)
    expect(paths.some((p) => p !== paths[0] && p.startsWith(`${paths[0]}/`))).toBe(true)
  })

  it('an outside click still closes the popover', () => {
    renderInHost()
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }))
    expect(openPanels()).toHaveLength(1)
    fireEvent.mouseDown(document.body)
    expect(openPanels()).toHaveLength(0)
  })
})
