// @vitest-environment jsdom
/**
 * Grid transform consistency: the GridLayer must paint its lines under the SAME
 * (panX, panY, zoom) transform the content layer uses, or the grid drifts off
 * the page on pan/zoom. A Konva.Layer cannot live inside a Group, so the fix
 * applies the transform to an inner Group; this test asserts that Group exists
 * with matching transform values, and that the lines are its children authored
 * in document space.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Stage } from 'react-konva'
import type Konva from 'konva'
import { GridLayer } from '../../src/design-canvas-react/components/GridLayer'

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

function renderGrid(props: { panX: number; panY: number; zoom: number; gridSize: number }): Konva.Stage {
  render(
    createElement(
      Stage,
      { width: 800, height: 600, ref: stageRef },
      // GridLayer renders its OWN Konva.Layer, so it mounts as a direct child of
      // the Stage (a Layer cannot nest inside another Layer) — exactly how
      // Workspace mounts it beneath the content layer.
      createElement(GridLayer, {
        pageWidth: 400,
        pageHeight: 300,
        gridSize: props.gridSize,
        zoom: props.zoom,
        panX: props.panX,
        panY: props.panY,
      }),
    ),
  )
  const stage = stageRef.current
  if (!stage) throw new Error('stage not created')
  return stage
}

function gridTransformGroup(stage: Konva.Stage): Konva.Group {
  const layer = stage.getLayers().find((l) => l.name() === 'overlay:grid')
  if (!layer) throw new Error('grid layer not found')
  const group = layer.getChildren()[0] as Konva.Group | undefined
  if (!group) throw new Error('grid transform group not found')
  return group
}

describe('GridLayer transform consistency', () => {
  it('wraps grid lines in a Group carrying the same pan/zoom transform as content', () => {
    const stage = renderGrid({ panX: 120, panY: 80, zoom: 2, gridSize: 50 })
    const group = gridTransformGroup(stage)
    expect(group.x()).toBe(120)
    expect(group.y()).toBe(80)
    expect(group.scaleX()).toBe(2)
    expect(group.scaleY()).toBe(2)
  })

  it('keeps grid lines authored in document space (transform handles screen mapping)', () => {
    const stage = renderGrid({ panX: 33, panY: 44, zoom: 1.5, gridSize: 100 })
    const group = gridTransformGroup(stage)
    const lines = group.getChildren((n) => n.name() === 'overlay:grid-line')
    expect(lines.length).toBeGreaterThan(0)
    // First vertical line is at document x = gridSize (100), in document space —
    // its screen position comes from the parent Group transform, not the points.
    const firstVertical = lines.find((l) => {
      const pts = (l as Konva.Line).points()
      return pts[0] === 100 && pts[2] === 100
    })
    expect(firstVertical).toBeTruthy()
  })

  it('tracks pan changes: re-render moves the whole grid by the pan delta', () => {
    const stage = renderGrid({ panX: 0, panY: 0, zoom: 1, gridSize: 50 })
    const before = gridTransformGroup(stage)
    expect(before.x()).toBe(0)
    expect(before.y()).toBe(0)

    const stage2 = renderGrid({ panX: 200, panY: 150, zoom: 1, gridSize: 50 })
    const after = gridTransformGroup(stage2)
    expect(after.x()).toBe(200)
    expect(after.y()).toBe(150)
  })
})
