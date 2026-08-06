// @vitest-environment jsdom
/**
 * Auto-fit contract for the WorkspaceView container sizing effect.
 *
 * The initial fit must be DETERMINISTIC across layout settling: the first
 * ResizeObserver measurement can be a transient (composite grids and mounting
 * chrome settle over several frames — the composite mini-editor story measured
 * a real-but-chrome-squeezed 694×135 slot on mount), so auto-fit stays live
 * and re-fits on every size CHANGE until the user takes control of the view
 * (wheel zoom, pan, zoom controls, explicit fit). Two invariants bound this:
 *  - once the user owns the view, resizes NEVER re-fit;
 *  - a page switch (which re-subscribes the effect and re-fires the observer
 *    with the same size) NEVER re-fits — the user's zoom+pan is preserved.
 *
 * Driven through a controllable ResizeObserver stub; mirrors the rendered-test
 * pattern in canvas-snappiness.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { WorkspaceView } from '../../src/design-canvas-react/components/Workspace'
import { createSceneCommandStack } from '../../src/design-canvas-react/engine/command-stack'
import type { SceneDocument, ScenePage } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// jsdom stubs — canvas context + a FIRE-ON-DEMAND ResizeObserver
// ---------------------------------------------------------------------------

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    ResizeObserverStub.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(width: number, height: number): void {
    this.cb(
      [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

function latestObserver(): ResizeObserverStub {
  const ro = ResizeObserverStub.instances[ResizeObserverStub.instances.length - 1]
  if (!ro) throw new Error('no ResizeObserver created')
  return ro
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
  ResizeObserverStub.instances = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
  stubCanvasContext()
})

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function page(id: string, width: number, height: number): ScenePage {
  return {
    id,
    name: id,
    width,
    height,
    background: '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
  }
}

function doc(pages: ScenePage[]): SceneDocument {
  return { schemaVersion: 1, title: 'fit', pages, settings: { dpi: 96 }, metadata: {} }
}

function renderView(stack: ReturnType<typeof createSceneCommandStack>, activePage: ScenePage) {
  return render(
    createElement(WorkspaceView, {
      stack,
      activePage,
      canWrite: true,
      onApplyOperations: vi.fn(async () => ({ rev: 2 })),
    }),
  )
}

// 1080² page in an 800×600 viewport: padding min(48, 600*0.2=120) = 48 →
// avail 504 → zoom 504/1080.
const FIT_800x600 = 504 / 1080

// ---------------------------------------------------------------------------
// Auto-fit lifecycle
// ---------------------------------------------------------------------------

describe('auto-fit across layout settling', () => {
  it('re-fits when the container settles after a transient small measure', () => {
    const stack = createSceneCommandStack(doc([page('p1', 1080, 1080)]), 'p1')
    renderView(stack, stack.getState().document.pages[0]!)

    // Transient measure: the composite cell's chrome-squeezed 694×135 slot.
    // Capped padding (135*0.2 = 27) → avail 81 → 81/1080, NOT the 5% clamp.
    act(() => latestObserver().fire(694, 135))
    expect(stack.getState().zoom).toBeCloseTo(81 / 1080, 5)

    // The slot settles to its real size → the fit recomputes.
    act(() => latestObserver().fire(800, 600))
    expect(stack.getState().zoom).toBeCloseTo(FIT_800x600, 5)
  })

  it('never re-fits once the user owns the view', () => {
    const stack = createSceneCommandStack(doc([page('p1', 1080, 1080)]), 'p1')
    renderView(stack, stack.getState().document.pages[0]!)
    act(() => latestObserver().fire(800, 600))
    expect(stack.getState().zoom).toBeCloseTo(FIT_800x600, 5)

    // User zoom (wheel / zoom controls both commit through stack.setView).
    act(() => stack.setView({ zoom: 1 }))
    act(() => latestObserver().fire(900, 700))
    expect(stack.getState().zoom).toBe(1)
  })

  it('does not re-fit on a page switch with an unchanged container size', () => {
    const stack = createSceneCommandStack(doc([page('p1', 1080, 1080), page('p2', 400, 200)]), 'p1')
    const { rerender } = renderView(stack, stack.getState().document.pages[0]!)
    act(() => latestObserver().fire(800, 600))
    expect(stack.getState().zoom).toBeCloseTo(FIT_800x600, 5)

    // Switch pages the way the chrome does; the effect re-subscribes and the
    // fresh observer re-fires with the SAME size.
    act(() => stack.setView({ activePageId: 'p2' }))
    rerender(
      createElement(WorkspaceView, {
        stack,
        activePage: stack.getState().document.pages[1]!,
        canWrite: true,
        onApplyOperations: vi.fn(async () => ({ rev: 2 })),
      }),
    )
    act(() => latestObserver().fire(800, 600))

    // p2 would fit at ~2 (400px in 800px); the user's p1 view must survive.
    expect(stack.getState().zoom).toBeCloseTo(FIT_800x600, 5)
  })
})
