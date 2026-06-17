// @vitest-environment jsdom
/**
 * SelectionLayer hit-graph contract: the Transformer's resize/rotate anchors
 * only receive pointer events if their parent Layer participates in the hit
 * graph. The layer was previously listening={false}, which disabled the
 * transformer entirely (dead handles). It must listen WHEN writable and stay
 * non-listening when read-only, so a locked canvas remains fully click-through.
 *
 * Export exclusion is independent of this (export.ts hides by the 'overlay:'
 * name prefix, not by `listening`) and is asserted in export-math.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Stage } from 'react-konva'
import type Konva from 'konva'
import { SelectionLayer } from '../../src/design-canvas-react/components/SelectionLayer'

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

let stageRef: { current: Konva.Stage | null }

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
  stubCanvasContext()
  stageRef = { current: null }
})

afterEach(() => cleanup())

function renderSelectionLayer(canWrite: boolean): Konva.Layer {
  render(
    createElement(
      Stage,
      { width: 800, height: 600, ref: stageRef },
      createElement(SelectionLayer, {
        stageRef,
        selectedIds: [],
        selectedElements: [],
        canWrite,
        onTransformEnd: vi.fn(),
        pageId: 'page-1',
      }),
    ),
  )
  const stage = stageRef.current
  if (!stage) throw new Error('stage not created')
  const layer = stage.getLayers().find((l) => l.name() === 'overlay:selection')
  if (!layer) throw new Error('selection layer not found')
  return layer
}

describe('SelectionLayer hit-graph', () => {
  it('listens when writable so transform anchors receive pointer events', () => {
    const layer = renderSelectionLayer(true)
    expect(layer.listening()).toBe(true)
  })

  it('does not listen when read-only so a locked canvas stays click-through', () => {
    const layer = renderSelectionLayer(false)
    expect(layer.listening()).toBe(false)
  })

  it('keeps the overlay: name prefix so export still excludes it', () => {
    const layer = renderSelectionLayer(true)
    expect(layer.name().startsWith('overlay:')).toBe(true)
  })
})
