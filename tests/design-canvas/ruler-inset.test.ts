// @vitest-environment jsdom
/**
 * Ruler ↔ stage coordinate alignment at the composition seam (DesignCanvas).
 *
 * The Konva stage maps doc→screen as `panX + doc·zoom` from the workspace
 * div's origin, while the ruler tracks (and their guide-line overlay) share a
 * coordinate space that starts 20px (RULER_SIZE_PX) into the slot. Unless the
 * STAGE is inset beneath the rulers, every tick/marker/guide sits uniformly
 * 20px right of (and below) the true canvas position, and snap math (true doc
 * coords) disagrees with the drawn line. The composition insets the workspace
 * slot by 20px when rulers are shown so the origins coincide; the bleed
 * overlay, positioned in stage coordinates, takes the same inset.
 *
 * The workspace is stubbed out (no Konva needed) — this tests the chrome's
 * composition, not the canvas.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DesignCanvas } from '../../src/design-canvas-react/components/DesignCanvas'
import type { SceneDocument, ScenePage } from '../../src/design-canvas/model'

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function page(overrides: Partial<ScenePage> = {}): ScenePage {
  return {
    id: 'p1',
    name: 'Page 1',
    width: 1080,
    height: 1080,
    background: '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
    ...overrides,
  }
}

function props(p: ScenePage): React.ComponentProps<typeof DesignCanvas> {
  const document: SceneDocument = {
    schemaVersion: 1,
    title: 'rulers',
    pages: [p],
    settings: { dpi: 96 },
    metadata: {},
  }
  return {
    document,
    rev: 1,
    canWrite: true,
    onApplyOperations: vi.fn(async () => ({ rev: 2 })),
    renderWorkspace: () => createElement('div', { 'data-testid': 'workspace-stub' }),
    renderThumbnail: async () => null,
  }
}

/** The rulers+workspace slot: the only relative+hidden+min-h-0 flex child. */
function slotDiv(container: HTMLElement): HTMLElement {
  const el = container.querySelector('div.relative.hidden.min-h-0.flex-1') as HTMLElement | null
  if (!el) throw new Error('workspace slot not found')
  return el
}

// ---------------------------------------------------------------------------
// Slot inset
// ---------------------------------------------------------------------------

describe('workspace slot ruler inset', () => {
  it('insets the slot by RULER_SIZE_PX (20px) when rulers are shown (default)', () => {
    const { container } = render(createElement(DesignCanvas, props(page())))
    const slot = slotDiv(container)
    expect(slot.classList.contains('pl-[20px]')).toBe(true)
    expect(slot.classList.contains('pt-[20px]')).toBe(true)
  })

  it('drops the inset when rulers are hidden, returning the stage to the slot origin', () => {
    const { container, getByLabelText } = render(createElement(DesignCanvas, props(page())))
    fireEvent.click(getByLabelText('Toggle rulers'))
    const slot = slotDiv(container)
    expect(slot.classList.contains('pl-[20px]')).toBe(false)
    expect(slot.classList.contains('pt-[20px]')).toBe(false)
  })

  it('offsets the bleed overlay by the same inset so it tracks the stage origin', () => {
    const bleed = { top: 36, right: 36, bottom: 36, left: 36 }
    const { container, getByLabelText } = render(createElement(DesignCanvas, props(page({ bleed }))))
    fireEvent.click(getByLabelText('Toggle bleed overlay'))
    const wrapper = container.querySelector('div.pointer-events-none.absolute.inset-0.z-10') as HTMLElement | null
    if (!wrapper || !wrapper.firstElementChild) throw new Error('bleed overlay not found')
    const inner = wrapper.firstElementChild as HTMLElement
    // Initial pan is 0,0 → the overlay origin is exactly the ruler inset.
    expect(inner.style.left).toBe('20px')
    expect(inner.style.top).toBe('20px')
  })
})
