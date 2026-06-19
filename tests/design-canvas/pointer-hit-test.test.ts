/**
 * Pointer-down gesture routing: the drag fix.
 *
 * `Workspace.handlePointerDown` decides element-drag-vs-marquee by testing the
 * press point against the scene MODEL in document space (`hitTestPoint`) rather
 * than Konva's hit-graph canvas. The old hit-graph probe misclassified presses
 * over elements (clip group, listening:false background, redraw lag right after
 * a pan/zoom), routing an element press into the marquee branch — so the element
 * drag never started ("I can hardly drag things").
 *
 * These tests prove the routing decision directly: pure model math + the same
 * screenToDocument transform the handler uses, at multiple zoom/pan states.
 */

import { describe, expect, it } from 'vitest'
import { hitTestPoint } from '../../src/design-canvas-react/engine/selection'
import { createZoomPanMath } from '../../src/design-canvas-react/engine/zoom-pan'
import type { ScenePage, RectElement, GroupElement } from '../../src/design-canvas/model'

const rect = (id: string, x: number, y: number, w: number, h: number): RectElement => ({
  id,
  name: id,
  kind: 'rect',
  x,
  y,
  width: w,
  height: h,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#000',
})

function page(elements: ScenePage['elements']): ScenePage {
  return {
    id: 'p',
    name: 'P',
    width: 1000,
    height: 1000,
    background: '#fff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements,
  }
}

const zoomPan = createZoomPanMath({ minZoom: 0.05, maxZoom: 32 })

/** Reproduce the handler decision: true → Konva drags the element (early
 *  return); false → empty space, start a marquee. */
function pressStartsDrag(
  pg: ScenePage,
  view: { zoom: number; panX: number; panY: number },
  screenX: number,
  screenY: number,
): boolean {
  const doc = zoomPan.screenToDocument(view, screenX, screenY)
  return hitTestPoint(pg, doc.x, doc.y) !== null
}

describe('hitTestPoint — model-space point hit test', () => {
  it('returns the element id when the point is inside its AABB', () => {
    const pg = page([rect('r1', 100, 100, 50, 50)])
    expect(hitTestPoint(pg, 120, 120)).toBe('r1')
    expect(hitTestPoint(pg, 100, 100)).toBe('r1') // top-left corner
    expect(hitTestPoint(pg, 150, 150)).toBe('r1') // bottom-right corner
  })

  it('returns null for empty space', () => {
    const pg = page([rect('r1', 100, 100, 50, 50)])
    expect(hitTestPoint(pg, 10, 10)).toBeNull()
    expect(hitTestPoint(pg, 200, 200)).toBeNull()
  })

  it('returns the TOP-MOST element when two overlap (last in z-order wins)', () => {
    const pg = page([rect('under', 0, 0, 100, 100), rect('over', 50, 50, 100, 100)])
    expect(hitTestPoint(pg, 75, 75)).toBe('over') // overlap region
    expect(hitTestPoint(pg, 10, 10)).toBe('under') // only under covers here
  })

  it('never hits locked or invisible elements', () => {
    const pg = page([
      { ...rect('locked', 0, 0, 100, 100), locked: true },
      { ...rect('hidden', 200, 0, 100, 100), visible: false },
    ])
    expect(hitTestPoint(pg, 50, 50)).toBeNull()
    expect(hitTestPoint(pg, 250, 50)).toBeNull()
  })

  it('a press over a group child resolves to the group (drag unit)', () => {
    const grp: GroupElement = {
      id: 'g',
      name: 'g',
      kind: 'group',
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      children: [rect('c1', 10, 10, 30, 30)],
    }
    const pg = page([grp])
    expect(hitTestPoint(pg, 20, 20)).toBe('g')
  })
})

describe('drag routing is correct at any zoom / pan (the fix)', () => {
  const pg = page([rect('r1', 400, 300, 200, 150)])

  // The element occupies document rect [400..600] x [300..450].
  const cases: Array<{ name: string; view: { zoom: number; panX: number; panY: number } }> = [
    { name: 'identity (zoom 1, no pan)', view: { zoom: 1, panX: 0, panY: 0 } },
    { name: 'zoomed in 3x with pan', view: { zoom: 3, panX: -200, panY: -150 } },
    { name: 'zoomed out 0.4x with pan', view: { zoom: 0.4, panX: 120, panY: 80 } },
    { name: 'panned far right', view: { zoom: 1.5, panX: 600, panY: 220 } },
  ]

  for (const { name, view } of cases) {
    it(`press on the element center starts a drag — ${name}`, () => {
      // Element document center = (500, 375); map to screen via doc→screen.
      const screen = zoomPan.documentToScreen(view, 500, 375)
      expect(pressStartsDrag(pg, view, screen.x, screen.y)).toBe(true)
    })

    it(`press in empty space starts a marquee (not a drag) — ${name}`, () => {
      // A document point well outside the element.
      const screen = zoomPan.documentToScreen(view, 50, 50)
      expect(pressStartsDrag(pg, view, screen.x, screen.y)).toBe(false)
    })
  }

  it('press just inside the element edge still starts a drag at high zoom', () => {
    const view = { zoom: 8, panX: -3000, panY: -2200 }
    const screen = zoomPan.documentToScreen(view, 401, 301) // 1px inside top-left
    expect(pressStartsDrag(pg, view, screen.x, screen.y)).toBe(true)
  })

  it('press just outside the element edge does not start a drag', () => {
    const view = { zoom: 8, panX: -3000, panY: -2200 }
    const screen = zoomPan.documentToScreen(view, 399, 299) // 1px outside top-left
    expect(pressStartsDrag(pg, view, screen.x, screen.y)).toBe(false)
  })
})
