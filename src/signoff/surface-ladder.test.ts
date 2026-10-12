import { describe, expect, it } from 'vitest'
import {
  composite, contrastRatio, judgeSurfaceLadder, oklchL, summarizeSurfacePage,
  type CopyBlock, type Rgb, type Rgba, type SurfaceBox, type SurfaceSample,
} from './surface-ladder'
import { parseSurfaceLadderArgs, SurfaceLadderUsageError } from './surface-ladder-cli'

const hex = (value: string): Rgb => [0, 2, 4].map((i) => Number.parseInt(value.slice(1 + i, 3 + i), 16)) as unknown as Rgb
const fill = (value: string, alpha = 1): Rgba => [...hex(value), alpha] as unknown as Rgba
const box = (kind: SurfaceBox['kind'], label: string, own: Rgba, parent: string, border: Rgba | null = null): SurfaceBox => ({
  kind, label, top: 0, left: 0, width: 400, height: kind === 'card' ? 200 : 40, fill: own, parent: hex(parent), parentLabel: 'parent', border,
})
const sample = (boxes: SurfaceBox[], copy: CopyBlock[] = []): SurfaceSample => ({ route: '/w/connections', width: 1440, theme: 'light', boxes, copy })
const words = (n: number): CopyBlock => ({ label: 'p', card: 'section.ha-section', words: n, text: 'x' })

describe('color math', () => {
  it('reads OKLCH lightness on the brand scale', () => {
    expect(oklchL([255, 255, 255])).toBeCloseTo(100, 1)
    expect(oklchL([0, 0, 0])).toBeCloseTo(0, 5)
    // ROOT-SPEC section (a): light page #eceef3 is L 94.9, dark page #0a0a14 is L 15.0.
    expect(oklchL(hex('#eceef3'))).toBeCloseTo(94.9, 0)
    expect(oklchL(hex('#0a0a14'))).toBeCloseTo(15, 0)
  })

  it('composites a translucent fill over its parent', () => {
    expect(composite([0, 0, 0, 0.5], [255, 255, 255])).toEqual([127.5, 127.5, 127.5])
    expect(composite([10, 20, 30, 0], [255, 255, 255])).toEqual([255, 255, 255])
  })

  it('computes the WCAG contrast ratio', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio(hex('#777a82'), [255, 255, 255])).toBeGreaterThan(4.2)
  })
})

describe('judgeSurfaceLadder', () => {
  it('passes a white card on the light page and a dark card stepped off the dark page', () => {
    expect(judgeSurfaceLadder(sample([box('card', 'white card', fill('#ffffff'), '#eceef3')]))).toEqual([])
    expect(judgeSurfaceLadder(sample([box('card', 'dark card', fill('#21202d'), '#0a0a14')]))).toEqual([])
  })

  it("fails Hospitality's card painted the color of the card it sits in", () => {
    const [finding] = judgeSurfaceLadder(sample([box('card', 'section.ha-section', fill('#ffffff'), '#ffffff')]))
    expect(finding).toMatchObject({ rule: 'card-step', target: 'section.ha-section', value: 0, limit: 3 })
  })

  it('fails the light search well 1.7 under a white card, and a transparent field on the page', () => {
    const well = box('field', 'input.search', fill('#f5f6f9'), '#ffffff')
    const bare = box('field', 'textarea', fill('#000000', 0), '#eceef3')
    const findings = judgeSurfaceLadder(sample([well, bare]))
    expect(findings.map((f) => [f.rule, f.target])).toEqual([['field-step', 'input.search'], ['field-step', 'textarea']])
    expect(findings[1]?.value).toBe(0)
  })

  it('counts a translucent fill by what it composites to', () => {
    // 50% black over white is a large step; 2% black is not.
    expect(judgeSurfaceLadder(sample([box('card', 'scrim', fill('#000000', 0.5), '#ffffff')]))).toEqual([])
    expect(judgeSurfaceLadder(sample([box('card', 'wash', fill('#000000', 0.02), '#ffffff')]))).toHaveLength(1)
  })

  it('fails a field border under 3:1 against the parent and passes the spec border', () => {
    const faint = box('field', 'faint', fill('#eceef4'), '#ffffff', fill('#e5e7eb'))
    const spec = box('field', 'spec', fill('#eceef4'), '#ffffff', fill('#777a82'))
    const findings = judgeSurfaceLadder(sample([faint, spec]))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'field-border', target: 'faint' })
    expect(findings[0]?.value).toBeLessThan(3)
  })

  it('fails card body copy over 12 words, element by element', () => {
    const findings = judgeSurfaceLadder(sample([], [words(12), words(20)]))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'card-copy', value: 20, limit: 12 })
  })

  it('honors custom limits', () => {
    const subtle = box('card', 'subtle', fill('#ffffff'), '#eceef3')
    expect(judgeSurfaceLadder(sample([subtle]))).toEqual([])
    expect(judgeSurfaceLadder(sample([subtle]), { minDeltaL: 6 })).toHaveLength(1)
    expect(judgeSurfaceLadder(sample([], [words(20)]), { maxWords: 25 })).toEqual([])
  })

  it('summarizes a page by rule', () => {
    const s = sample([box('card', 'flat', fill('#ffffff'), '#ffffff'), box('card', 'ok', fill('#ffffff'), '#eceef3')], [words(19)])
    expect(summarizeSurfacePage(s, judgeSurfaceLadder(s))).toMatchObject({ cards: 2, flatCards: 1, minCardDeltaL: 0, fields: 0, longCopy: 1, maxCopyWords: 19 })
  })
})

describe('parseSurfaceLadderArgs', () => {
  it('needs a base URL and a route, and reads the limits', () => {
    expect(() => parseSurfaceLadderArgs(['--route', '/a'])).toThrow(SurfaceLadderUsageError)
    expect(() => parseSurfaceLadderArgs(['--base-url', 'http://x'])).toThrow(SurfaceLadderUsageError)
    expect(() => parseSurfaceLadderArgs(['--base-url', 'http://x', '--route', '/a', '--max-words', '0'])).toThrow(SurfaceLadderUsageError)
    expect(parseSurfaceLadderArgs(['--base-url', 'http://x', '--route', '/a', '--widths', '1440', '--themes', 'dark', '--tolerance', '4', '--max-words', '15']))
      .toMatchObject({ baseUrl: 'http://x', routes: ['/a'], widths: [1440], themes: ['dark'], minDeltaL: 4, maxWords: 15 })
  })
})
