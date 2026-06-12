/**
 * Tests for transform-math.ts — all pure functions, no DOM/Konva required.
 */

import { describe, expect, it } from 'vitest'

import {
  bakeRectTransform,
  bakeLineTransform,
  bakeTextTransform,
  ellipseCenterFromTopLeft,
  ellipseTopLeftFromCenter,
  normalizeMarquee,
  computeTextOverlayPosition,
  snapRotation,
  nudgeDelta,
  marqueeContains,
  gridVisible,
} from '../../src/design-canvas-react/components/transform-math'

// ---------------------------------------------------------------------------
// bakeRectTransform
// ---------------------------------------------------------------------------

describe('bakeRectTransform', () => {
  it('collapses scaleX/scaleY into width/height', () => {
    const result = bakeRectTransform({ x: 10, y: 20, width: 100, height: 50, scaleX: 2, scaleY: 3, rotation: 0 })
    expect(result).toEqual({ x: 10, y: 20, width: 200, height: 150, rotation: 0 })
  })

  it('preserves rotation', () => {
    const result = bakeRectTransform({ x: 0, y: 0, width: 80, height: 40, scaleX: 1, scaleY: 1, rotation: 45 })
    expect(result.rotation).toBe(45)
  })

  it('handles negative scale (flip) by taking absolute value', () => {
    const result = bakeRectTransform({ x: 5, y: 5, width: 60, height: 30, scaleX: -1.5, scaleY: 1, rotation: 0 })
    expect(result.width).toBe(90)
    expect(result.height).toBe(30)
  })

  it('identity scale returns original dimensions', () => {
    const result = bakeRectTransform({ x: 0, y: 0, width: 200, height: 100, scaleX: 1, scaleY: 1, rotation: 0 })
    expect(result).toEqual({ x: 0, y: 0, width: 200, height: 100, rotation: 0 })
  })
})

// ---------------------------------------------------------------------------
// bakeLineTransform
// ---------------------------------------------------------------------------

describe('bakeLineTransform', () => {
  it('bakes scaleX into x-components and scaleY into y-components', () => {
    const result = bakeLineTransform({
      x: 0, y: 0, width: 100, height: 50, scaleX: 2, scaleY: 0.5, rotation: 0,
      points: [0, 0, 100, 50, 50, 25],
    })
    // x-components (indices 0, 2, 4) × scaleX=2; y-components (indices 1, 3, 5) × scaleY=0.5
    expect(result.points).toEqual([0, 0, 200, 25, 100, 12.5])
  })

  it('preserves x/y position', () => {
    const result = bakeLineTransform({
      x: 30, y: 40, width: 100, height: 100, scaleX: 1, scaleY: 1, rotation: 90,
      points: [0, 0, 100, 0],
    })
    expect(result.x).toBe(30)
    expect(result.y).toBe(40)
  })

  it('identity scale leaves points unchanged', () => {
    const pts = [0, 0, 80, 60]
    const result = bakeLineTransform({ x: 0, y: 0, width: 80, height: 60, scaleX: 1, scaleY: 1, rotation: 0, points: pts })
    expect(result.points).toEqual(pts)
  })
})

// ---------------------------------------------------------------------------
// bakeTextTransform
// ---------------------------------------------------------------------------

describe('bakeTextTransform', () => {
  it('bakes scaleX into width and scaleY into fontSize', () => {
    const result = bakeTextTransform({
      x: 0, y: 0, width: 200, height: 100, scaleX: 1.5, scaleY: 2, rotation: 0,
      fontSize: 16,
    })
    expect(result.width).toBe(300)
    expect(result.fontSize).toBe(32)
  })

  it('clamps fontSize to minimum 1', () => {
    const result = bakeTextTransform({
      x: 0, y: 0, width: 100, height: 50, scaleX: 0.001, scaleY: 0.001, rotation: 0,
      fontSize: 16,
    })
    expect(result.fontSize).toBeGreaterThanOrEqual(1)
  })

  it('does not include height in baked attrs (height re-derives from content)', () => {
    const result = bakeTextTransform({
      x: 0, y: 0, width: 100, height: 999, scaleX: 1, scaleY: 1, rotation: 0,
      fontSize: 14,
    })
    // Height is NOT baked — it equals the original node height, unchanged.
    expect(result.height).toBe(999)
    expect(result.fontSize).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// ellipseCenterFromTopLeft / ellipseTopLeftFromCenter
// ---------------------------------------------------------------------------

describe('ellipse coordinate conversion', () => {
  it('converts top-left bounding box to center + radii', () => {
    const result = ellipseCenterFromTopLeft({ x: 10, y: 20, width: 100, height: 60 })
    expect(result).toEqual({ x: 60, y: 50, radiusX: 50, radiusY: 30 })
  })

  it('round-trips: topLeft → center → topLeft', () => {
    const original = { x: 15, y: 25, width: 80, height: 40 }
    const center = ellipseCenterFromTopLeft(original)
    const backToTopLeft = ellipseTopLeftFromCenter(center)
    expect(backToTopLeft.x).toBeCloseTo(original.x)
    expect(backToTopLeft.y).toBeCloseTo(original.y)
    expect(backToTopLeft.width).toBeCloseTo(original.width)
    expect(backToTopLeft.height).toBeCloseTo(original.height)
  })

  it('converts center + radii back to top-left bounding box', () => {
    const result = ellipseTopLeftFromCenter({ x: 60, y: 50, radiusX: 50, radiusY: 30 })
    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 60 })
  })

  it('handles zero-origin ellipse', () => {
    const result = ellipseCenterFromTopLeft({ x: 0, y: 0, width: 200, height: 100 })
    expect(result).toEqual({ x: 100, y: 50, radiusX: 100, radiusY: 50 })
  })
})

// ---------------------------------------------------------------------------
// normalizeMarquee
// ---------------------------------------------------------------------------

describe('normalizeMarquee', () => {
  it('returns positive width/height when dragging top-left to bottom-right', () => {
    const r = normalizeMarquee(10, 20, 110, 70)
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('normalizes when dragging bottom-right to top-left', () => {
    const r = normalizeMarquee(110, 70, 10, 20)
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('handles same start and end point (zero area)', () => {
    const r = normalizeMarquee(50, 50, 50, 50)
    expect(r).toEqual({ x: 50, y: 50, width: 0, height: 0 })
  })

  it('normalizes upward drag (startY > endY)', () => {
    const r = normalizeMarquee(0, 100, 80, 30)
    expect(r).toEqual({ x: 0, y: 30, width: 80, height: 70 })
  })

  it('normalizes leftward drag (startX > endX)', () => {
    const r = normalizeMarquee(200, 50, 50, 150)
    expect(r).toEqual({ x: 50, y: 50, width: 150, height: 100 })
  })
})

// ---------------------------------------------------------------------------
// computeTextOverlayPosition
// ---------------------------------------------------------------------------

describe('computeTextOverlayPosition', () => {
  it('maps document coords to screen coords via zoom + pan', () => {
    const result = computeTextOverlayPosition({
      elementX: 100,
      elementY: 50,
      elementWidth: 200,
      elementHeight: 80,
      zoom: 2,
      panX: 10,
      panY: 20,
      stageLeft: 0,
      stageTop: 0,
      elementFontSize: 16,
    })
    // screenX = panX + elementX * zoom = 10 + 100*2 = 210
    expect(result.left).toBe(210)
    // screenY = panY + elementY * zoom = 20 + 50*2 = 120
    expect(result.top).toBe(120)
    expect(result.width).toBe(400) // 200 * 2
    expect(result.fontSize).toBe(32) // 16 * 2
  })

  it('includes stageLeft/stageTop offset', () => {
    const result = computeTextOverlayPosition({
      elementX: 0,
      elementY: 0,
      elementWidth: 100,
      elementHeight: 50,
      zoom: 1,
      panX: 0,
      panY: 0,
      stageLeft: 40,
      stageTop: 60,
      elementFontSize: 14,
    })
    expect(result.left).toBe(40)
    expect(result.top).toBe(60)
  })

  it('handles zoom < 1 correctly', () => {
    const result = computeTextOverlayPosition({
      elementX: 200,
      elementY: 100,
      elementWidth: 400,
      elementHeight: 200,
      zoom: 0.5,
      panX: 0,
      panY: 0,
      stageLeft: 0,
      stageTop: 0,
      elementFontSize: 24,
    })
    expect(result.left).toBe(100)
    expect(result.top).toBe(50)
    expect(result.width).toBe(200)
    expect(result.fontSize).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// snapRotation
// ---------------------------------------------------------------------------

describe('snapRotation', () => {
  it('snaps to 0 when within threshold', () => {
    expect(snapRotation(3)).toBe(0)
    expect(snapRotation(-3)).toBe(0)
  })

  it('snaps to 90 when within threshold', () => {
    expect(snapRotation(87)).toBe(90)
    expect(snapRotation(93)).toBe(90)
  })

  it('snaps to 180 when within threshold', () => {
    expect(snapRotation(177)).toBe(180)
  })

  it('does NOT snap when outside threshold', () => {
    expect(snapRotation(10)).toBe(10)
    expect(snapRotation(80)).toBe(80)
  })

  it('respects custom threshold', () => {
    // threshold = 2: 3° away from 0 should NOT snap
    expect(snapRotation(3, 2)).toBe(3)
    // but 1° away should snap
    expect(snapRotation(1, 2)).toBe(0)
  })

  it('normalizes 360° to 0°', () => {
    expect(snapRotation(360)).toBe(0)
  })

  it('normalizes 362° to 2° (within threshold → 0)', () => {
    expect(snapRotation(362)).toBe(0)
  })

  it('snaps 45° correctly', () => {
    expect(snapRotation(43)).toBe(45)
  })
})

// ---------------------------------------------------------------------------
// nudgeDelta
// ---------------------------------------------------------------------------

describe('nudgeDelta', () => {
  it('ArrowLeft gives dx=-1 without shift', () => {
    expect(nudgeDelta('ArrowLeft', false)).toEqual({ dx: -1, dy: 0 })
  })

  it('ArrowRight gives dx=1 without shift', () => {
    expect(nudgeDelta('ArrowRight', false)).toEqual({ dx: 1, dy: 0 })
  })

  it('ArrowUp gives dy=-1 without shift', () => {
    expect(nudgeDelta('ArrowUp', false)).toEqual({ dx: 0, dy: -1 })
  })

  it('ArrowDown gives dy=1 without shift', () => {
    expect(nudgeDelta('ArrowDown', false)).toEqual({ dx: 0, dy: 1 })
  })

  it('shift multiplies step by 10', () => {
    expect(nudgeDelta('ArrowLeft', true)).toEqual({ dx: -10, dy: 0 })
    expect(nudgeDelta('ArrowDown', true)).toEqual({ dx: 0, dy: 10 })
  })
})

// ---------------------------------------------------------------------------
// marqueeContains
// ---------------------------------------------------------------------------

describe('marqueeContains', () => {
  const marquee = { x: 0, y: 0, width: 200, height: 200 }

  it('returns true when bounds is fully inside marquee', () => {
    expect(marqueeContains(marquee, { x: 10, y: 10, width: 80, height: 80 })).toBe(true)
  })

  it('returns true when bounds exactly matches marquee', () => {
    expect(marqueeContains(marquee, { x: 0, y: 0, width: 200, height: 200 })).toBe(true)
  })

  it('returns false when bounds extends outside marquee', () => {
    expect(marqueeContains(marquee, { x: 10, y: 10, width: 300, height: 80 })).toBe(false)
  })

  it('returns false when bounds is only partially inside', () => {
    expect(marqueeContains(marquee, { x: 150, y: 150, width: 100, height: 100 })).toBe(false)
  })

  it('returns false when bounds is entirely outside', () => {
    expect(marqueeContains(marquee, { x: 300, y: 300, width: 50, height: 50 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// gridVisible
// ---------------------------------------------------------------------------

describe('gridVisible', () => {
  it('returns true when grid lines are >= minScreenPx apart', () => {
    // gridSize=20 doc px, zoom=1: 20 screen px apart — well above 4
    expect(gridVisible(20, 1)).toBe(true)
  })

  it('returns false when grid lines are too close', () => {
    // gridSize=10 doc px, zoom=0.2: 2 screen px apart — below 4
    expect(gridVisible(10, 0.2)).toBe(false)
  })

  it('returns true at exactly the threshold', () => {
    // gridSize=4 doc px, zoom=1: exactly 4 screen px — at threshold
    expect(gridVisible(4, 1)).toBe(true)
  })

  it('respects custom minScreenPx', () => {
    // gridSize=10, zoom=1: 10 screen px apart; minScreenPx=12 → false
    expect(gridVisible(10, 1, 12)).toBe(false)
    // minScreenPx=8 → true
    expect(gridVisible(10, 1, 8)).toBe(true)
  })
})
