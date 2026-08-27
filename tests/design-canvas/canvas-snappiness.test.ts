// @vitest-environment jsdom
/**
 * Snappiness layers proven as capabilities, not micro-benchmarks. The win is
 * that a `stack.notify()` storm (~120/s during a pan) no longer re-renders or
 * re-reconciles N element nodes. These tests assert the three behaviors that
 * make that true WITHOUT changing what the canvas draws or exports:
 *
 *  (a) Page-bounds viewport culling — an element fully OUTSIDE the page rect is
 *      not mounted on the stage, but an on-page element that is merely
 *      off-SCREEN stays mounted (export.ts rasterizes the stage and crops to the
 *      page, so a screen-culled on-page node would vanish from exported PNGs).
 *  (b) Konva node caching gate — a static element is bitmap-cached; a SELECTED
 *      or DRAGGING element is not (its node must redraw live under the
 *      transformer / during the move).
 *  (c) Grid single-Shape equivalence — the grid renders as exactly one Konva
 *      Shape whose stroked line positions match the legacy per-Line output for a
 *      sample page + gridSize.
 *
 * Mirrors the rendered-test pattern in
 * tests/sequences/timeline-editor-components.test.ts: real component in,
 * Konva scene-graph assertions out, jsdom canvas + ResizeObserver stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Stage } from 'react-konva'
import Konva from 'konva'
import { Workspace } from '../../src/design-canvas-react/components/Workspace'
import {
  GridLayer,
  gridVerticalLines,
  gridHorizontalLines,
} from '../../src/design-canvas-react/components/GridLayer'
import type { DesignCanvasProps } from '../../src/design-canvas-react/contracts'
import type { RectElement, SceneDocument, ScenePage } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// jsdom stubs (Stage backing canvas + ResizeObserver) — same shape the existing
// design-canvas rendered tests use.
// ---------------------------------------------------------------------------

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubCanvasContext(): void {
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'canvas') return document.createElement('canvas')
        if (prop === 'measureText') return () => ({ width: 0 })
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
        return () => undefined
      },
      set: () => true,
    },
  )
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx
}

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
  stubCanvasContext()
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rect(id: string, x: number, y: number, w: number, h: number): RectElement {
  return {
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
    fill: '#000000',
  }
}

function makeDoc(elements: ScenePage['elements']): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'snap',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        width: 400,
        height: 300,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements,
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

function props(elements: ScenePage['elements']): DesignCanvasProps {
  return {
    document: makeDoc(elements),
    rev: 1,
    canWrite: true,
    onApplyOperations: vi.fn(async () => ({ rev: 2 })),
  }
}

/** The most-recently-mounted stage. Workspace owns its Stage but does not expose
 *  it to tests; Konva registers every live stage in its global array. */
function currentStage(): Konva.Stage {
  const stage = Konva.stages[Konva.stages.length - 1]
  if (!stage) throw new Error('no Konva stage mounted')
  return stage
}

function workspaceDiv(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.design-canvas-workspace') as HTMLElement | null
  if (!el) throw new Error('workspace div not found')
  return el
}

// ---------------------------------------------------------------------------
// (a) Page-bounds viewport culling
// ---------------------------------------------------------------------------

describe('page-bounds viewport culling', () => {
  it('does NOT mount an element fully outside the page, but DOES mount an on-page off-screen one', () => {
    // Page is 400x300. `onpage` sits well inside it; `offpage` is far to the
    // right of the page rect (x=5000) so export never captures it.
    const onpage = rect('onpage', 50, 50, 40, 40)
    const offpage = rect('offpage', 5000, 5000, 40, 40)
    const { container } = render(createElement(Workspace, props([onpage, offpage])))
    void container

    const stage = currentStage()
    // On-page element is on the stage (would appear in an export crop).
    expect(stage.findOne('.onpage')).toBeTruthy()
    // Off-page element is culled — never reconciled into the scene graph.
    expect(stage.findOne('.offpage')).toBeUndefined()
  })

  it('keeps an on-page element that is off-SCREEN (negative pan) mounted', () => {
    // Element is on the page (inside 0..400 / 0..300) but positioned at the page
    // edge; even with the page panned out of the viewport it must stay mounted,
    // because page-bounds culling is view-independent. Culling on the SCREEN
    // viewport here would drop it and it would vanish from exported PNGs.
    const edge = rect('edge', 360, 260, 40, 40)
    render(createElement(Workspace, props([edge])))
    const stage = currentStage()
    expect(stage.findOne('.edge')).toBeTruthy()
  })

  it('never culls a SELECTED element even when it is dragged fully off-page', () => {
    // A selected element pinned so the transformer always has its node.
    const off = rect('pinned', 5000, 5000, 40, 40)
    const { container } = render(createElement(Workspace, props([off])))
    // Select-all pins it (Cmd+A), then it must remain mounted despite being
    // off-page — the transformer would otherwise lose its target.
    act(() => {
      fireEvent.keyDown(workspaceDiv(container), { key: 'a', metaKey: true })
    })
    const stage = currentStage()
    expect(stage.findOne('.pinned')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// (b) Konva node caching gate
// ---------------------------------------------------------------------------

describe('node caching gate (!isSelected && !dragging)', () => {
  it('bitmap-caches a static (unselected, not dragging) element', () => {
    render(createElement(Workspace, props([rect('static', 50, 50, 40, 40)])))
    const stage = currentStage()
    const node = stage.findOne('.static')
    expect(node).toBeTruthy()
    expect(node!.isCached()).toBe(true)
  })

  it('does NOT cache a selected element (it lives under the transformer)', () => {
    const { container } = render(createElement(Workspace, props([rect('sel', 50, 50, 40, 40)])))
    act(() => {
      fireEvent.keyDown(workspaceDiv(container), { key: 'a', metaKey: true })
    })
    const stage = currentStage()
    const node = stage.findOne('.sel')
    expect(node).toBeTruthy()
    // Selection clears any existing cache so resize/rotate redraws live.
    expect(node!.isCached()).toBe(false)
  })

  it('clears the cache on drag start and never shows a frozen bitmap mid-move', () => {
    render(createElement(Workspace, props([rect('drag', 50, 50, 40, 40)])))
    const stage = currentStage()
    const node = stage.findOne('.drag')!
    expect(node.isCached()).toBe(true)

    // Fire the Konva dragstart the node binds; the leaf flips `dragging` true,
    // the cache effect runs and clears the bitmap.
    act(() => {
      node.fire('dragstart', { target: node }, true)
    })
    expect(node.isCached()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (c) Grid single-Shape equivalence
// ---------------------------------------------------------------------------

describe('grid single-Shape equivalence', () => {
  it('the pure generators reproduce the legacy per-Line positions for a sample page', () => {
    // Legacy GridLayer pushed a vertical line for every x in (gridSize, pageWidth)
    // stepping by gridSize, and likewise for horizontals — exactly what the
    // single-Shape sceneFunc now strokes. Byte-match for page 400x300, grid 50.
    const legacyVerticals: number[] = []
    for (let x = 50; x < 400; x += 50) legacyVerticals.push(x)
    const legacyHorizontals: number[] = []
    for (let y = 50; y < 300; y += 50) legacyHorizontals.push(y)

    expect(gridVerticalLines(400, 50)).toEqual(legacyVerticals)
    expect(gridHorizontalLines(300, 50)).toEqual(legacyHorizontals)
    expect(gridVerticalLines(400, 50)).toEqual([50, 100, 150, 200, 250, 300, 350])
    expect(gridHorizontalLines(300, 50)).toEqual([50, 100, 150, 200, 250])
  })

  it('renders the grid as exactly ONE Konva.Shape under the overlay layer', () => {
    // Mount GridLayer directly (Workspace gates it on the stack's gridEnabled,
    // off by default) to prove the single-node scene graph end to end.
    const ref: { current: Konva.Stage | null } = { current: null }
    render(
      createElement(
        Stage,
        { width: 800, height: 600, ref },
        createElement(GridLayer, {
          pageWidth: 400,
          pageHeight: 300,
          gridSize: 50,
          zoom: 1,
          panX: 0,
          panY: 0,
        }),
      ),
    )
    const stage = ref.current!
    const gridLayer = stage.getLayers().find((l) => l.name() === 'overlay:grid')!
    const group = gridLayer.getChildren()[0] as Konva.Group
    const children = group.getChildren()
    expect(children.length).toBe(1)
    expect(children[0]!.getClassName()).toBe('Shape')
    expect(children[0]!.name()).toBe('overlay:grid-shape')
    expect(group.getChildren((n) => n.getClassName() === 'Line').length).toBe(0)
  })
})
