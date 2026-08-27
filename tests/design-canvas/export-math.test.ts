import { describe, expect, it } from 'vitest'
import type { ScenePage } from '../../src/design-canvas/model'
import {
  bleedAwareExportBounds,
  scaleForPreset,
  EXPORT_PRESETS,
  type ExportPreset,
  type ExportCropRect,
} from '../../src/design-canvas/export-presets'
import {
  resolveExportParams,
  isExportHiddenNodeName,
  identifyTaintedSrc,
  isCrossOriginSrc,
  documentCropToStageCoords,
} from '../../src/design-canvas-react/export-math'
import {
  exportDocumentJson,
} from '../../src/design-canvas-react/export'
import { createEmptyDocument } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function page(overrides: Partial<ScenePage> = {}): ScenePage {
  return {
    id: 'p1',
    name: 'Page',
    width: 1080,
    height: 1080,
    background: '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
    ...overrides,
  }
}

function bleedPage(): ScenePage {
  return page({ bleed: { top: 9, right: 9, bottom: 9, left: 9 } })
}

function preset(overrides: Partial<ExportPreset> = {}): ExportPreset {
  return {
    name: 'Test',
    pixelRatio: 2,
    outputWidth: null,
    outputHeight: null,
    includeBleed: false,
    format: 'png',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// bleedAwareExportBounds
// ---------------------------------------------------------------------------

describe('bleedAwareExportBounds', () => {
  it('returns page rect when includeBleed is false', () => {
    const result = bleedAwareExportBounds(page(), false)
    expect(result).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('returns page rect when includeBleed is true but bleed is null', () => {
    const result = bleedAwareExportBounds(page({ bleed: null }), true)
    expect(result).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('expands by bleed margins when includeBleed is true', () => {
    const result = bleedAwareExportBounds(bleedPage(), true)
    // Origin shifts left/up by bleed.left and bleed.top
    expect(result.x).toBe(-9)
    expect(result.y).toBe(-9)
    expect(result.width).toBe(1080 + 9 + 9)
    expect(result.height).toBe(1080 + 9 + 9)
  })

  it('handles asymmetric bleed', () => {
    const p = page({ bleed: { top: 5, right: 10, bottom: 15, left: 20 } })
    const result = bleedAwareExportBounds(p, true)
    expect(result).toEqual({ x: -20, y: -5, width: 1080 + 20 + 10, height: 1080 + 5 + 15 })
  })

  it('ignores bleed when includeBleed is false even if bleed is set', () => {
    const result = bleedAwareExportBounds(bleedPage(), false)
    expect(result).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })
})

// ---------------------------------------------------------------------------
// scaleForPreset
// ---------------------------------------------------------------------------

describe('scaleForPreset', () => {
  it('returns pixelRatio directly when outputWidth is null', () => {
    const p = preset({ pixelRatio: 2, outputWidth: null })
    const crop: ExportCropRect = { x: 0, y: 0, width: 1080, height: 1080 }
    expect(scaleForPreset(p, crop)).toBe(2)
  })

  it('derives ratio from outputWidth / crop.width when pinned', () => {
    const p = preset({ outputWidth: 540, outputHeight: 540 })
    const crop: ExportCropRect = { x: 0, y: 0, width: 1080, height: 1080 }
    // 540 / 1080 = 0.5
    expect(scaleForPreset(p, crop)).toBeCloseTo(0.5)
  })

  it('handles non-square ratio correctly (width-dominant)', () => {
    const p = preset({ outputWidth: 1200 })
    const crop: ExportCropRect = { x: 0, y: 0, width: 800, height: 600 }
    expect(scaleForPreset(p, crop)).toBeCloseTo(1.5)
  })

  it('throws when crop width is zero', () => {
    const p = preset({ outputWidth: 1080 })
    expect(() => scaleForPreset(p, { x: 0, y: 0, width: 0, height: 0 })).toThrow('export crop width must be positive')
  })

  it('throws when crop width is negative', () => {
    const p = preset({ outputWidth: 1080 })
    expect(() => scaleForPreset(p, { x: 0, y: 0, width: -10, height: 100 })).toThrow('export crop width must be positive')
  })

  it('instagram-square preset resolves to ratio 1 on a 1080-wide page', () => {
    const p = EXPORT_PRESETS['instagram-square']!
    const crop = bleedAwareExportBounds(page(), false)
    expect(scaleForPreset(p, crop)).toBe(1)
  })

  it('screen-2x preset returns pixelRatio 2 directly', () => {
    const p = EXPORT_PRESETS['screen-2x']!
    const crop = bleedAwareExportBounds(page(), false)
    expect(scaleForPreset(p, crop)).toBe(2)
  })

  it('print-a4 preset returns declared pixelRatio when no output pin', () => {
    const p = EXPORT_PRESETS['print-a4']!
    // print-a4 has no outputWidth, so pixelRatio is returned directly
    expect(p.outputWidth).toBeNull()
    const crop = bleedAwareExportBounds(page(), p.includeBleed)
    expect(scaleForPreset(p, crop)).toBe(p.pixelRatio)
  })
})

// ---------------------------------------------------------------------------
// resolveExportParams
// ---------------------------------------------------------------------------

describe('resolveExportParams', () => {
  it('plain png with pixelRatio=1.5', () => {
    const result = resolveExportParams(page(), { format: 'png', pixelRatio: 1.5 })
    expect(result.mimeType).toBe('image/png')
    expect(result.quality).toBeUndefined()
    expect(result.pixelRatio).toBe(1.5)
    expect(result.cropRect).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('plain jpeg sets quality to 0.92', () => {
    const result = resolveExportParams(page(), { format: 'jpeg' })
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.quality).toBe(0.92)
  })

  it('defaults pixelRatio to 1 when not supplied and no preset', () => {
    const result = resolveExportParams(page(), { format: 'png' })
    expect(result.pixelRatio).toBe(1)
  })

  it('preset overrides pixelRatio and includeBleed', () => {
    const p = preset({ pixelRatio: 3, includeBleed: true, outputWidth: null })
    const result = resolveExportParams(bleedPage(), { format: 'png', pixelRatio: 1, includeBleed: false, preset: p })
    // preset.includeBleed=true wins over opts.includeBleed=false
    expect(result.cropRect.x).toBe(-9)
    expect(result.pixelRatio).toBe(3)
  })

  it('preset with outputWidth derives ratio from crop width', () => {
    const p = preset({ outputWidth: 2160, outputHeight: 2160, includeBleed: false })
    const result = resolveExportParams(page({ width: 1080, height: 1080 }), { format: 'png', preset: p })
    expect(result.pixelRatio).toBeCloseTo(2)
    expect(result.cropRect).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('preset format overrides explicit format arg', () => {
    const p = preset({ format: 'jpeg', includeBleed: false })
    const result = resolveExportParams(page(), { format: 'png', preset: p })
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.quality).toBe(0.92)
  })

  it('bleed is included when preset.includeBleed is true and page has bleed', () => {
    const p = preset({ includeBleed: true })
    const result = resolveExportParams(bleedPage(), { format: 'png', preset: p })
    expect(result.cropRect).toEqual({ x: -9, y: -9, width: 1098, height: 1098 })
  })
})

// ---------------------------------------------------------------------------
// isExportHiddenNodeName
// ---------------------------------------------------------------------------

describe('isExportHiddenNodeName', () => {
  it('hides nodes starting with overlay:', () => {
    expect(isExportHiddenNodeName('overlay:snap-line')).toBe(true)
    expect(isExportHiddenNodeName('overlay:ruler')).toBe(true)
    expect(isExportHiddenNodeName('overlay:')).toBe(true)
  })

  it('hides the Transformer node by exact name', () => {
    expect(isExportHiddenNodeName('Transformer')).toBe(true)
  })

  it('does not hide content nodes', () => {
    expect(isExportHiddenNodeName('rect-abc')).toBe(false)
    expect(isExportHiddenNodeName('image-123')).toBe(false)
    expect(isExportHiddenNodeName('transformer')).toBe(false) // lowercase — not the Konva Transformer
    expect(isExportHiddenNodeName('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isCrossOriginSrc + identifyTaintedSrc
// ---------------------------------------------------------------------------

describe('isCrossOriginSrc', () => {
  it('treats absolute https URLs as cross-origin', () => {
    expect(isCrossOriginSrc('https://cdn.example.com/img.png')).toBe(true)
    expect(isCrossOriginSrc('http://other.site/img.jpg')).toBe(true)
  })

  it('treats rooted /api/ paths as same-origin', () => {
    expect(isCrossOriginSrc('/api/assets/image.png')).toBe(false)
  })

  it('treats relative paths as same-origin', () => {
    expect(isCrossOriginSrc('/assets/logo.svg')).toBe(false)
  })

  it('treats data: URLs as safe', () => {
    expect(isCrossOriginSrc('data:image/png;base64,abc')).toBe(false)
  })
})

describe('identifyTaintedSrc', () => {
  it('returns the first cross-origin src', () => {
    const srcs = [
      { name: 'image-1', src: '/api/assets/safe.png' },
      { name: 'image-2', src: 'https://cdn.example.com/risky.jpg' },
      { name: 'image-3', src: 'https://other.cdn.com/also-risky.png' },
    ]
    expect(identifyTaintedSrc(srcs)).toBe('https://cdn.example.com/risky.jpg')
  })

  it('returns null when all srcs are same-origin', () => {
    const srcs = [
      { name: 'a', src: '/api/img.png' },
      { name: 'b', src: '/assets/logo.svg' },
    ]
    expect(identifyTaintedSrc(srcs)).toBeNull()
  })

  it('returns null for empty list', () => {
    expect(identifyTaintedSrc([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// documentCropToStageCoords
// ---------------------------------------------------------------------------

describe('documentCropToStageCoords', () => {
  it('scales and offsets by stage transform', () => {
    // stageScale=2, stageX=100, stageY=50 — page at (0,0) in stage view
    const result = documentCropToStageCoords(
      { x: 0, y: 0, width: 1080, height: 1080 },
      2, 100, 50,
    )
    expect(result).toEqual({ x: 100, y: 50, width: 2160, height: 2160 })
  })

  it('handles bleed offset (negative crop origin)', () => {
    // bleed extends 9px; crop rect origin at (-9, -9)
    const result = documentCropToStageCoords(
      { x: -9, y: -9, width: 1098, height: 1098 },
      1, 0, 0,
    )
    expect(result).toEqual({ x: -9, y: -9, width: 1098, height: 1098 })
  })

  it('stageScale of 0.5 halves the crop dimensions', () => {
    const result = documentCropToStageCoords(
      { x: 0, y: 0, width: 1080, height: 540 },
      0.5, 0, 0,
    )
    expect(result).toEqual({ x: 0, y: 0, width: 540, height: 270 })
  })

  it('pan offset is added, not multiplied', () => {
    const result = documentCropToStageCoords(
      { x: 10, y: 20, width: 100, height: 200 },
      2, 50, 30,
    )
    // x = 50 + 10*2 = 70; y = 30 + 20*2 = 70; w = 200; h = 400
    expect(result).toEqual({ x: 70, y: 70, width: 200, height: 400 })
  })
})

// ---------------------------------------------------------------------------
// exportDocumentJson — JSON round-trip
// ---------------------------------------------------------------------------

describe('exportDocumentJson', () => {
  it('serializes a document to pretty JSON and back', () => {
    const doc = createEmptyDocument('Test Doc')
    const json = exportDocumentJson(doc)
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.title).toBe('Test Doc')
    expect(Array.isArray(parsed.pages)).toBe(true)
    expect(parsed.pages).toHaveLength(1)
  })

  it('output is pretty-printed (indented)', () => {
    const doc = createEmptyDocument('Test')
    const json = exportDocumentJson(doc)
    expect(json).toContain('\n  ')
  })

  it('throws when schemaVersion does not match', () => {
    const doc = createEmptyDocument('Test')
    const badDoc = { ...doc, schemaVersion: 99 as typeof doc.schemaVersion }
    expect(() => exportDocumentJson(badDoc)).toThrow('schemaVersion is 99')
  })

  it('round-trip preserves page background and elements', () => {
    const doc = createEmptyDocument('Round-trip', { background: '#ff0000', width: 800, height: 600 })
    const json = exportDocumentJson(doc)
    const parsed = JSON.parse(json) as typeof doc
    expect(parsed.pages[0]!.background).toBe('#ff0000')
    expect(parsed.pages[0]!.width).toBe(800)
    expect(parsed.pages[0]!.height).toBe(600)
  })
})
