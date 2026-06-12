import { describe, it, expect } from 'vitest'
import {
  CHANNEL_PRESETS,
  requireChannelPreset,
  scalePageForChannelPreset,
  bleedAwareExportRect,
  type ChannelPreset,
} from '../../src/design-canvas/export-presets'
import type { ScenePage } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// CHANNEL_PRESETS catalogue
// ---------------------------------------------------------------------------

describe('CHANNEL_PRESETS', () => {
  it('contains the seven required presets by id', () => {
    const ids = CHANNEL_PRESETS.map((p) => p.id)
    expect(ids).toContain('square_1080')
    expect(ids).toContain('portrait_1080x1350')
    expect(ids).toContain('story_1080x1920')
    expect(ids).toContain('landscape_1200x628')
    expect(ids).toContain('wide_1920x1080')
    expect(ids).toContain('og_1200x630')
    expect(ids).toContain('a4_print_2480x3508')
  })

  it('has correct dimensions for each preset', () => {
    const byId = Object.fromEntries(CHANNEL_PRESETS.map((p) => [p.id, p]))
    expect(byId['square_1080']).toMatchObject({ width: 1080, height: 1080 })
    expect(byId['portrait_1080x1350']).toMatchObject({ width: 1080, height: 1350 })
    expect(byId['story_1080x1920']).toMatchObject({ width: 1080, height: 1920 })
    expect(byId['landscape_1200x628']).toMatchObject({ width: 1200, height: 628 })
    expect(byId['wide_1920x1080']).toMatchObject({ width: 1920, height: 1080 })
    expect(byId['og_1200x630']).toMatchObject({ width: 1200, height: 630 })
    expect(byId['a4_print_2480x3508']).toMatchObject({ width: 2480, height: 3508 })
  })
})

describe('requireChannelPreset', () => {
  it('returns the preset for a valid id', () => {
    const preset = requireChannelPreset('square_1080')
    expect(preset.width).toBe(1080)
    expect(preset.height).toBe(1080)
  })

  it('throws for an unknown id', () => {
    expect(() => requireChannelPreset('not_a_preset')).toThrow(/unknown channel preset/)
  })
})

// ---------------------------------------------------------------------------
// scalePageForChannelPreset
// ---------------------------------------------------------------------------

function page(width: number, height: number): Pick<ScenePage, 'width' | 'height'> {
  return { width, height }
}

function preset(width: number, height: number): ChannelPreset {
  return { id: 'test', label: 'Test', width, height }
}

describe('scalePageForChannelPreset', () => {
  it('exact match — pixelRatio=1, offsets=0', () => {
    // 1080×1080 page into square_1080 (1080×1080) preset
    const result = scalePageForChannelPreset(page(1080, 1080), requireChannelPreset('square_1080'))
    expect(result.pixelRatio).toBeCloseTo(1)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(0)
    expect(result.fit).toBe('contain')
  })

  it('1080×1080 page → 1920×1080 wide preset: letterbox on X axis', () => {
    // scaleX = 1920/1080 ≈ 1.7778, scaleY = 1
    // pixelRatio = 1.0 (limited by height)
    // renderedW = 1080, renderedH = 1080
    // offsetX = (1920 - 1080) / 2 / 1.0 = 420
    // offsetY = 0
    const result = scalePageForChannelPreset(page(1080, 1080), requireChannelPreset('wide_1920x1080'))
    expect(result.pixelRatio).toBeCloseTo(1)
    expect(result.offsetX).toBeCloseTo(420)
    expect(result.offsetY).toBeCloseTo(0)
    expect(result.fit).toBe('contain')
  })

  it('1920×1080 page → 1080×1080 square preset: letterbox on Y axis', () => {
    // scaleX = 1080/1920 = 0.5625, scaleY = 1080/1080 = 1.0
    // pixelRatio = 0.5625  (width is the bottleneck)
    // renderedW = 1920 × 0.5625 = 1080,  renderedH = 1080 × 0.5625 = 607.5
    // offsetX = 0  (fills full width)
    // offsetY = (1080 − 607.5) / 2 / 0.5625 = 236.25 / 0.5625 = 420 page-px
    const result = scalePageForChannelPreset(page(1920, 1080), requireChannelPreset('square_1080'))
    expect(result.pixelRatio).toBeCloseTo(0.5625)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(420)
  })

  it('1080×1920 page → 1080×1080 square preset: letterbox on X axis', () => {
    // scaleX = 1080/1080 = 1.0, scaleY = 1080/1920 ≈ 0.5625
    // pixelRatio = 0.5625  (height is the bottleneck)
    // renderedW = 1080 × 0.5625 = 607.5,  renderedH = 1920 × 0.5625 = 1080
    // offsetX = (1080 − 607.5) / 2 / 0.5625 = 236.25 / 0.5625 = 420 page-px
    // offsetY = 0  (fills full height)
    const result = scalePageForChannelPreset(page(1080, 1920), requireChannelPreset('square_1080'))
    expect(result.pixelRatio).toBeCloseTo(1080 / 1920)
    expect(result.offsetX).toBeCloseTo(420)
    expect(result.offsetY).toBeCloseTo(0)
  })

  it('1080×1080 page → story 1080×1920 preset: letterbox on Y axis', () => {
    // scaleX = 1, scaleY = 1920/1080 ≈ 1.7778
    // pixelRatio = 1.0
    // renderedH = 1080
    // offsetY = (1920 - 1080) / 2 / 1.0 = 420
    const result = scalePageForChannelPreset(page(1080, 1080), requireChannelPreset('story_1080x1920'))
    expect(result.pixelRatio).toBeCloseTo(1)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(420)
  })

  it('scale-up: 540×540 page → 1080×1080 square — pixelRatio=2, offsets=0', () => {
    const result = scalePageForChannelPreset(page(540, 540), requireChannelPreset('square_1080'))
    expect(result.pixelRatio).toBeCloseTo(2)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(0)
  })

  it('1200×628 page → landscape_1200x628 preset: exact match', () => {
    const result = scalePageForChannelPreset(page(1200, 628), requireChannelPreset('landscape_1200x628'))
    expect(result.pixelRatio).toBeCloseTo(1)
    expect(result.offsetX).toBeCloseTo(0)
    expect(result.offsetY).toBeCloseTo(0)
  })

  it('throws for zero-width page', () => {
    expect(() => scalePageForChannelPreset(page(0, 1080), preset(1080, 1080))).toThrow(/positive/)
  })

  it('throws for negative-height page', () => {
    expect(() => scalePageForChannelPreset(page(1080, -1), preset(1080, 1080))).toThrow(/positive/)
  })
})

// ---------------------------------------------------------------------------
// bleedAwareExportRect
// ---------------------------------------------------------------------------

describe('bleedAwareExportRect', () => {
  it('returns trim rect when bleed is null', () => {
    const result = bleedAwareExportRect({ width: 1080, height: 1080, bleed: null })
    expect(result).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('expands origin and size by bleed margins', () => {
    const result = bleedAwareExportRect({
      width: 1080,
      height: 1080,
      bleed: { top: 20, right: 15, bottom: 20, left: 15 },
    })
    expect(result.x).toBe(-15)
    expect(result.y).toBe(-20)
    expect(result.width).toBe(1080 + 15 + 15)   // 1110
    expect(result.height).toBe(1080 + 20 + 20)  // 1120
  })

  it('handles asymmetric bleed', () => {
    const result = bleedAwareExportRect({
      width: 800,
      height: 600,
      bleed: { top: 10, right: 30, bottom: 5, left: 20 },
    })
    expect(result.x).toBe(-20)
    expect(result.y).toBe(-10)
    expect(result.width).toBe(800 + 20 + 30)   // 850
    expect(result.height).toBe(600 + 10 + 5)   // 615
  })

  it('handles zero-value bleed sides', () => {
    const result = bleedAwareExportRect({
      width: 1080,
      height: 1080,
      bleed: { top: 0, right: 0, bottom: 0, left: 0 },
    })
    // Zero bleed is a valid (if pointless) bleed object — not null.
    // Use toBeCloseTo to avoid -0 vs +0 distinction from negating zero.
    expect(result.x).toBeCloseTo(0)
    expect(result.y).toBeCloseTo(0)
    expect(result.width).toBe(1080)
    expect(result.height).toBe(1080)
  })
})
