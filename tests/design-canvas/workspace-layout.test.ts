// @vitest-environment jsdom
/**
 * Workspace root sizing + marquee palette contract.
 *
 * (a) The WorkspaceView root div must FILL the chrome's definite-height slot
 *     (h-full w-full). Without those classes the div sizes to the Konva
 *     stage's current pixel height and the ResizeObserver measures that
 *     content-sized box — a feedback loop stuck at the initial 600px: dead
 *     strip + mis-centered empty state on tall viewports, canvas overflowing
 *     over the bottom chrome (pointer-blocking zoom controls) on short ones.
 *
 * (b) The marquee selection rect must stroke with the render palette's
 *     `selectionStroke` (the same token the transformer uses), not a hardcoded
 *     Tailwind blue that ignores theming.
 *
 * Mirrors the rendered-test pattern in canvas-snappiness.test.ts: real
 * component in, DOM assertions out, jsdom canvas + ResizeObserver stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Workspace } from '../../src/design-canvas-react/components/Workspace'
import type { DesignCanvasProps } from '../../src/design-canvas-react/contracts'
import type { RectElement, SceneDocument } from '../../src/design-canvas/model'
import { lightTheme } from '../../src/theme/theme'

// ---------------------------------------------------------------------------
// jsdom stubs — same shape the existing design-canvas rendered tests use,
// plus pointer capture (jsdom has no PointerEvent capture implementation).
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
  ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
  ;(HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {}
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

function props(): DesignCanvasProps {
  const doc: SceneDocument = {
    schemaVersion: 1,
    title: 'layout',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        width: 400,
        height: 300,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements: [rect('a', 50, 50, 40, 40)],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
  return {
    document: doc,
    rev: 1,
    canWrite: true,
    onApplyOperations: vi.fn(async () => ({ rev: 2 })),
  }
}

function workspaceDiv(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.design-canvas-workspace') as HTMLElement | null
  if (!el) throw new Error('workspace div not found')
  return el
}

// ---------------------------------------------------------------------------
// (a) Root sizing classes
// ---------------------------------------------------------------------------

describe('workspace root sizing', () => {
  it('root div fills its slot (h-full w-full) so the ResizeObserver measures the real container', () => {
    const { container } = render(createElement(Workspace, props()))
    const root = workspaceDiv(container)
    expect(root.classList.contains('h-full')).toBe(true)
    expect(root.classList.contains('w-full')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (b) Marquee palette token
// ---------------------------------------------------------------------------

describe('marquee selection rect palette', () => {
  it('strokes with render.selectionStroke instead of a hardcoded blue', () => {
    const renderPalette = { ...lightTheme.canvasRender, selectionStroke: '#123456' }
    const { container } = render(createElement(Workspace, { ...props(), render: renderPalette }))
    const root = workspaceDiv(container)

    // Empty-space primary drag → marquee. (200,200) is outside the 50..90
    // fixture rect; jsdom's zeroed getBoundingClientRect keeps screen == doc.
    fireEvent.pointerDown(root, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(root, { clientX: 260, clientY: 240 })

    const marquee = root.querySelector('div.pointer-events-none.absolute.border') as HTMLElement | null
    expect(marquee).toBeTruthy()
    // jsdom's CSSOM may serialize the hex as rgb(); accept either form.
    expect(marquee!.style.borderColor).toMatch(/#123456|rgb\(18, ?52, ?86\)/)
  })
})
