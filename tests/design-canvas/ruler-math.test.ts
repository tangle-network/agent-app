import { describe, expect, it } from 'vitest'
import {
  buildRulerTicks,
  clampIndex,
  formatRulerLabel,
  indexBackward,
  indexForward,
  screenToDocumentPosition,
  selectTickStep,
  snapGuideToTick,
  topIndex,
} from '../../src/design-canvas-react/components/ruler-math'

describe('selectTickStep', () => {
  it('returns a step whose screen spacing meets the minimum at the given zoom', () => {
    const step = selectTickStep({ zoom: 1, minMajorSpacingPx: 40 })
    expect(step.major * 1).toBeGreaterThanOrEqual(40)
  })

  it('draws minor ticks when they clear the minimum minor spacing', () => {
    // At zoom 2, major=50 → 100px spacing; minor=10 → 20px ≥ 8px default.
    const step = selectTickStep({ zoom: 2, minMajorSpacingPx: 40, minMinorSpacingPx: 8 })
    expect(step.drawMinor).toBe(true)
    expect(step.minor).toBe(step.major / 5)
  })

  it('suppresses minor ticks when they would be too close', () => {
    // At zoom=0.001: major step selected is 5000 (5000×0.001=5 — actually
    // the loop doubles until ≥40, so major≥40000). minor=major/5; at extreme
    // zoom-out minor×zoom is tiny, well below minMinorSpacingPx=8.
    // Use a case we can calculate exactly: zoom=0.1, minMajor=80, minMinor=50.
    // best major = 1000 (1000×0.1=100≥80), minor = 200 (200×0.1=20 < 50) → false.
    const step = selectTickStep({ zoom: 0.1, minMajorSpacingPx: 80, minMinorSpacingPx: 50 })
    expect(step.drawMinor).toBe(false)
  })

  it('selects 1px step at high zoom (zoom=100)', () => {
    const step = selectTickStep({ zoom: 100, minMajorSpacingPx: 40 })
    expect(step.major).toBe(1)
  })

  it('selects a large step at very low zoom (zoom=0.01)', () => {
    const step = selectTickStep({ zoom: 0.01, minMajorSpacingPx: 40 })
    expect(step.major * 0.01).toBeGreaterThanOrEqual(40)
  })

  it('throws on non-positive zoom', () => {
    expect(() => selectTickStep({ zoom: 0 })).toThrow('positive finite')
    expect(() => selectTickStep({ zoom: -1 })).toThrow('positive finite')
  })
})

describe('buildRulerTicks', () => {
  it('produces ticks covering the full document length', () => {
    const step = selectTickStep({ zoom: 1, minMajorSpacingPx: 40 })
    const ticks = buildRulerTicks({ documentLength: 1080, step })
    const majorTicks = ticks.filter((t) => t.label !== null)
    // First major tick is at 0, last is at or before 1080.
    expect(majorTicks[0]?.position).toBe(0)
    expect(majorTicks[majorTicks.length - 1]!.position).toBeLessThanOrEqual(1080)
  })

  it('returns empty array for zero-length document', () => {
    const step = selectTickStep({ zoom: 1 })
    expect(buildRulerTicks({ documentLength: 0, step })).toEqual([])
  })

  it('includes minor ticks when drawMinor is true', () => {
    const step: import('../../src/design-canvas-react/components/ruler-math').TickStep = {
      major: 100,
      minor: 20,
      drawMinor: true,
    }
    const ticks = buildRulerTicks({ documentLength: 200, step })
    const minor = ticks.filter((t) => t.label === null)
    // Expect 4 minor ticks between 0→100 and 4 between 100→200.
    expect(minor.length).toBe(8)
  })

  it('omits minor ticks when drawMinor is false', () => {
    const step: import('../../src/design-canvas-react/components/ruler-math').TickStep = {
      major: 100,
      minor: 20,
      drawMinor: false,
    }
    const ticks = buildRulerTicks({ documentLength: 300, step })
    const minor = ticks.filter((t) => t.label === null)
    expect(minor.length).toBe(0)
  })
})

describe('formatRulerLabel', () => {
  it('formats zero as "0"', () => {
    expect(formatRulerLabel(0)).toBe('0')
  })
  it('formats integers without decimals', () => {
    expect(formatRulerLabel(100)).toBe('100')
  })
  it('compacts thousands to k notation', () => {
    expect(formatRulerLabel(1000)).toBe('1k')
    expect(formatRulerLabel(1500)).toBe('1.5k')
    expect(formatRulerLabel(2000)).toBe('2k')
  })
  it('rounds fractional values to 1 decimal', () => {
    expect(formatRulerLabel(10.25)).toBe('10.3')
  })
  it('returns empty string for non-finite', () => {
    expect(formatRulerLabel(Infinity)).toBe('')
    expect(formatRulerLabel(NaN)).toBe('')
  })
})

describe('screenToDocumentPosition', () => {
  it('converts screen px to document coordinates', () => {
    // pointer at 200px screen, scrolled 50 doc-px, zoom=2 → (200/2)+50=150
    expect(screenToDocumentPosition({ pointerScreenPx: 200, scrollOffset: 50, zoom: 2 })).toBe(150)
  })
  it('works with zero scroll offset', () => {
    expect(screenToDocumentPosition({ pointerScreenPx: 80, scrollOffset: 0, zoom: 1 })).toBe(80)
  })
  it('throws on non-positive zoom', () => {
    expect(() => screenToDocumentPosition({ pointerScreenPx: 0, scrollOffset: 0, zoom: 0 })).toThrow()
  })
})

describe('snapGuideToTick', () => {
  const step: import('../../src/design-canvas-react/components/ruler-math').TickStep = {
    major: 100,
    minor: 20,
    drawMinor: true,
  }
  it('snaps to nearest major tick within threshold', () => {
    expect(snapGuideToTick(98, step, 5)).toBe(100)
  })
  it('does not snap when outside threshold', () => {
    expect(snapGuideToTick(94, step, 5)).toBe(94)
  })
  it('snaps exactly on tick', () => {
    expect(snapGuideToTick(200, step, 5)).toBe(200)
  })
})

describe('z-order index math', () => {
  it('topIndex returns the last index', () => {
    expect(topIndex(5)).toBe(4)
    expect(topIndex(1)).toBe(0)
  })
  it('indexForward does not exceed owner length - 1', () => {
    expect(indexForward(4, 5)).toBe(4)
    expect(indexForward(3, 5)).toBe(4)
  })
  it('indexBackward does not go below 0', () => {
    expect(indexBackward(0)).toBe(0)
    expect(indexBackward(2)).toBe(1)
  })
  it('clampIndex clamps to valid range', () => {
    expect(clampIndex(-1, 5)).toBe(0)
    expect(clampIndex(10, 5)).toBe(4)
    expect(clampIndex(3, 5)).toBe(3)
  })
})
