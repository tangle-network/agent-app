/**
 * Design-canvas lint engine — static analysis of a SceneDocument for visual
 * defects the model must fix before a design is production-ready.
 *
 * Six rule families, two severities:
 *   ERROR  — text-overlap, element-overflow, contrast
 *   WARNING — hierarchy, alignment, spacing, palette
 *
 * Scoring: start 100 per page, -15 per error finding, -5 per warning finding,
 * floor 0. Document score = average across pages (or 0 for empty documents).
 */

import type { SceneDocument, ScenePage, SceneElement, TextElement, Bounds } from './model'
import { elementAabb, estimateTextHeight, requirePage } from './model'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LintSeverity = 'error' | 'warning'

export type LintRule =
  | 'text-overlap'
  | 'element-overflow'
  | 'text-overflow-band'
  | 'contrast'
  | 'hierarchy'
  | 'alignment'
  | 'spacing'
  | 'palette'

export interface LintFinding {
  rule: LintRule
  severity: LintSeverity
  /** All element ids implicated; may be empty for page-level findings. */
  elementIds: string[]
  /** Concrete message: names, numbers, and a fix suggestion. */
  message: string
}

export interface PageLintResult {
  pageId: string
  pageName: string
  findings: LintFinding[]
  /** 0–100 score for this page. */
  score: number
}

export interface LintReport {
  pages: PageLintResult[]
  /** Average page score; 0 for a document with no pages. */
  documentScore: number
  /** Total finding counts by severity across all pages. */
  errorCount: number
  warningCount: number
}

// ---------------------------------------------------------------------------
// Score arithmetic
// ---------------------------------------------------------------------------

export function computeLintScore(findings: LintFinding[]): number {
  let score = 100
  for (const f of findings) {
    score -= f.severity === 'error' ? 15 : 5
  }
  return Math.max(0, score)
}

// ---------------------------------------------------------------------------
// Color parsing — hex and rgb(a) only; 'transparent' yields null
// ---------------------------------------------------------------------------

interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(color: string): Rgb | null {
  const s = color.trim().toLowerCase()
  if (s === 'transparent') return null

  // #rgb / #rrggbb / #rrggbbaa
  const hex = s.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const h = hex[1]!
    if (h.length === 3) {
      return {
        r: parseInt(h[0]! + h[0]!, 16),
        g: parseInt(h[1]! + h[1]!, 16),
        b: parseInt(h[2]! + h[2]!, 16),
        a: 1,
      }
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      }
    }
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
      }
    }
    return null
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgb) {
    return {
      r: parseInt(rgb[1]!, 10),
      g: parseInt(rgb[2]!, 10),
      b: parseInt(rgb[3]!, 10),
      a: rgb[4] !== undefined ? parseFloat(rgb[4]) : 1,
    }
  }

  return null
}

/** WCAG relative luminance of an sRGB channel value 0–255. */
function channelLuminance(c: number): number {
  const linear = c / 255
  return linear <= 0.03928 ? linear / 12.92 : Math.pow((linear + 0.055) / 1.055, 2.4)
}

/** WCAG relative luminance of an Rgb value (0..1). */
function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  )
}

/** WCAG contrast ratio between two colors (1..21). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const lA = relativeLuminance(a)
  const lB = relativeLuminance(b)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** True when max(r,g,b) - min(r,g,b) < 24 — considered neutral/achromatic. */
function isNeutralColor(rgb: Rgb): boolean {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 24
}

// ---------------------------------------------------------------------------
// Element traversal helpers
// ---------------------------------------------------------------------------

/** Flat list of all elements (including group children) with page-space AABBs
 *  and their effective cumulative opacity. Groups themselves are not included. */
interface FlatElement {
  element: SceneElement
  aabb: Bounds
  /** Product of all ancestor opacities × the element's own opacity. */
  effectiveOpacity: number
  /** Z-order index in the flat list (lower = further back). */
  zIndex: number
}

function flattenElements(elements: SceneElement[], parentOpacity = 1, zBase = { n: 0 }): FlatElement[] {
  const result: FlatElement[] = []
  for (const el of elements) {
    const effective = parentOpacity * el.opacity
    if (el.kind === 'group') {
      result.push(...flattenElements(el.children, effective, zBase))
    } else {
      result.push({
        element: el,
        aabb: elementAabb(el),
        effectiveOpacity: effective,
        zIndex: zBase.n++,
      })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Intersection geometry
// ---------------------------------------------------------------------------

function intersectionArea(a: Bounds, b: Bounds): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return ix * iy
}

function area(b: Bounds): number {
  return b.width * b.height
}

// ---------------------------------------------------------------------------
// Rule: text-overlap (ERROR)
// ---------------------------------------------------------------------------

function lintTextOverlap(flat: FlatElement[], page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  const visibleTexts = flat.filter(
    (fe) => fe.element.visible && fe.element.kind === 'text' && fe.effectiveOpacity > 0,
  )

  // Pair-wise text vs text: flag when overlap area > 15% of the smaller element.
  for (let i = 0; i < visibleTexts.length; i++) {
    for (let j = i + 1; j < visibleTexts.length; j++) {
      const a = visibleTexts[i]!
      const b = visibleTexts[j]!
      const overlap = intersectionArea(a.aabb, b.aabb)
      if (overlap === 0) continue
      const smaller = Math.min(area(a.aabb), area(b.aabb))
      if (smaller > 0 && overlap / smaller > 0.15) {
        const aName = a.element.name
        const bName = b.element.name
        const pct = Math.round((overlap / smaller) * 100)
        findings.push({
          rule: 'text-overlap',
          severity: 'error',
          elementIds: [a.element.id, b.element.id],
          message:
            `"${aName}" and "${bName}" overlap by ${pct}% of the smaller element's area (threshold 15%). ` +
            `Move one element or reduce its width to eliminate the collision.`,
        })
      }
    }
  }

  // Text vs opaque non-background shape above it in z-order: flag when the
  // shape covers > 30% of the text's area.
  const opaqueShapes = flat.filter((fe) => {
    if (!fe.element.visible) return false
    if (fe.element.kind === 'text' || fe.element.kind === 'line') return false
    if (fe.effectiveOpacity <= 0.9) return false
    const hasFill =
      fe.element.kind === 'rect' ||
      fe.element.kind === 'ellipse' ||
      fe.element.kind === 'image' ||
      fe.element.kind === 'video'
    if (!hasFill) return false
    // Exclude shapes that parse as transparent
    if (fe.element.kind === 'rect' || fe.element.kind === 'ellipse') {
      const fill = parseColor((fe.element as { fill: string }).fill)
      if (fill === null) return false
    }
    return true
  })

  for (const textFe of visibleTexts) {
    const textArea = area(textFe.aabb)
    if (textArea === 0) continue
    for (const shapeFe of opaqueShapes) {
      // Shape must be higher in z-order than the text to occlude it.
      if (shapeFe.zIndex <= textFe.zIndex) continue
      const covered = intersectionArea(textFe.aabb, shapeFe.aabb)
      if (covered / textArea > 0.3) {
        const pct = Math.round((covered / textArea) * 100)
        findings.push({
          rule: 'text-overlap',
          severity: 'error',
          elementIds: [textFe.element.id, shapeFe.element.id],
          message:
            `Shape "${shapeFe.element.name}" (opaque, z-above) covers ${pct}% of text "${textFe.element.name}" (threshold 30%). ` +
            `Lower the shape's z-order, reduce its size, or make it semi-transparent.`,
        })
      }
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: element-overflow (ERROR)
// ---------------------------------------------------------------------------

const OVERFLOW_TOLERANCE = 2 // px

function lintElementOverflow(flat: FlatElement[], page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []
  const bleed = page.bleed

  for (const fe of flat) {
    if (!fe.element.visible) continue
    const { aabb, element } = fe

    let minX: number, minY: number, maxX: number, maxY: number

    if (bleed) {
      // Bleed-aware: elements may extend into the bleed zone but not beyond it.
      minX = -bleed.left
      minY = -bleed.top
      maxX = page.width + bleed.right
      maxY = page.height + bleed.bottom
    } else {
      minX = 0
      minY = 0
      maxX = page.width
      maxY = page.height
    }

    const left = minX - aabb.x
    const top = minY - aabb.y
    const right = (aabb.x + aabb.width) - maxX
    const bottom = (aabb.y + aabb.height) - maxY

    const offenders: string[] = []
    if (left > OVERFLOW_TOLERANCE) offenders.push(`left by ${Math.round(left)}px`)
    if (top > OVERFLOW_TOLERANCE) offenders.push(`top by ${Math.round(top)}px`)
    if (right > OVERFLOW_TOLERANCE) offenders.push(`right by ${Math.round(right)}px`)
    if (bottom > OVERFLOW_TOLERANCE) offenders.push(`bottom by ${Math.round(bottom)}px`)

    if (offenders.length > 0) {
      const bound = bleed ? 'bleed boundary' : 'page bounds'
      findings.push({
        rule: 'element-overflow',
        severity: 'error',
        elementIds: [element.id],
        message:
          `"${element.name}" exceeds ${bound}: ${offenders.join(', ')}. ` +
          `Move or resize the element to fit within the ${bound} (tolerance ${OVERFLOW_TOLERANCE}px).`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: text-overflow-band (ERROR)
// ---------------------------------------------------------------------------

/**
 * Flags text elements whose AABB bottom extends past the bottom of the nearest
 * opaque rect below them in z-order that acts as a visual band. A "band" here
 * is any opaque rect with a lower z-index whose horizontal span overlaps the
 * text by ≥50% of the text's width — a structural container, not a decorative
 * element that happens to share an x range.
 *
 * Without the wrap-aware estimateTextHeight fix (Gap 1) this rule fires only
 * when the overflow is detectable via explicit-newline line counts. With the
 * fix, it also catches wrap-induced overflows.
 */
function lintTextOverflowBand(flat: FlatElement[], _page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  const visibleTexts = flat.filter(
    (fe) => fe.element.visible && fe.element.kind === 'text' && fe.effectiveOpacity > 0,
  )

  const opaqueRects = flat.filter((fe) => {
    if (!fe.element.visible) return false
    if (fe.element.kind !== 'rect') return false
    if (fe.effectiveOpacity <= 0.9) return false
    const fill = parseColor((fe.element as { fill: string }).fill)
    return fill !== null
  })

  for (const textFe of visibleTexts) {
    const textEl = textFe.element as TextElement
    const textBottom = textFe.aabb.y + textFe.aabb.height
    const textLeft = textFe.aabb.x
    const textRight = textFe.aabb.x + textFe.aabb.width
    // Minimum band height: must be at least 1× the text's fontSize to qualify
    // as a structural container. Thin rules (height < fontSize) are decorative
    // and cannot meaningfully "contain" text.
    const minBandHeight = textEl.fontSize

    // Find the tightest qualifying band: an opaque rect below the text in
    // z-order whose span overlaps ≥50% of the text width, is at least
    // minBandHeight tall, starts at or above the text top, and whose bottom
    // is less than the text AABB bottom. Only the tightest (smallest height
    // that still contains the text start) is flagged to avoid duplicate
    // findings from nested bands.
    let tightestBand: FlatElement | null = null

    for (const rectFe of opaqueRects) {
      if (rectFe.zIndex >= textFe.zIndex) continue

      const rectH = rectFe.aabb.height
      if (rectH < minBandHeight) continue

      const rectBottom = rectFe.aabb.y + rectFe.aabb.height
      const rectLeft = rectFe.aabb.x
      const rectRight = rectFe.aabb.x + rectFe.aabb.width

      // Horizontal overlap between text and rect
      const overlapLeft = Math.max(textLeft, rectLeft)
      const overlapRight = Math.min(textRight, rectRight)
      const horizOverlap = Math.max(0, overlapRight - overlapLeft)
      const textWidth = textFe.aabb.width
      if (textWidth <= 0) continue
      if (horizOverlap / textWidth < 0.5) continue

      // The rect must bracket the text's starting position: rect starts above
      // (or at) text top AND rect bottom is at or below text top. A rect that
      // ends before the text begins is a sibling/separator, not a container.
      if (rectFe.aabb.y > textFe.aabb.y) continue
      if (rectBottom < textFe.aabb.y - OVERFLOW_TOLERANCE) continue

      // The text bottom must exceed the band bottom — overflow candidate.
      const overflow = textBottom - rectBottom
      if (overflow <= OVERFLOW_TOLERANCE) continue

      // Track the tightest (smallest) qualifying band so we report the most
      // specific containment relationship, not every enclosing rect.
      if (
        tightestBand === null ||
        rectFe.aabb.height < tightestBand.aabb.height
      ) {
        tightestBand = rectFe
      }
    }

    if (tightestBand !== null) {
      const tightBottom = tightestBand.aabb.y + tightestBand.aabb.height
      const overflow = textBottom - tightBottom
      findings.push({
        rule: 'text-overflow-band',
        severity: 'error',
        elementIds: [textFe.element.id, tightestBand.element.id],
        message:
          `"${textFe.element.name}" AABB bottom (${Math.round(textBottom)}px) exceeds its containing band ` +
          `"${tightestBand.element.name}" bottom (${Math.round(tightBottom)}px) by ${Math.round(overflow)}px. ` +
          `Reduce font size, increase the band height, or shorten the text to fit.`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: contrast (ERROR)
// ---------------------------------------------------------------------------

/** Find the effective background color behind a text element:
 *  - The largest-area opaque (opacity>0.9) non-text shape whose AABB contains
 *    the text's center point, at a lower z-index.
 *  - Falls back to the page background color. */
function resolveTextBackground(textFe: FlatElement, flat: FlatElement[], pageBackground: string): Rgb | null {
  const cx = textFe.aabb.x + textFe.aabb.width / 2
  const cy = textFe.aabb.y + textFe.aabb.height / 2

  let bestArea = -1
  let bestColor: Rgb | null = null

  for (const fe of flat) {
    if (fe.zIndex >= textFe.zIndex) continue
    if (!fe.element.visible) continue
    if (fe.effectiveOpacity <= 0.9) continue
    if (fe.element.kind === 'text' || fe.element.kind === 'line') continue

    // Must contain the text center
    if (
      cx < fe.aabb.x || cx > fe.aabb.x + fe.aabb.width ||
      cy < fe.aabb.y || cy > fe.aabb.y + fe.aabb.height
    ) continue

    const el = fe.element
    let fillColor: Rgb | null = null
    if (el.kind === 'rect' || el.kind === 'ellipse') {
      fillColor = parseColor((el as { fill: string }).fill)
    } else if (el.kind === 'image' || el.kind === 'video') {
      // Images/videos are opaque rectangles; treat as mid-gray for contrast
      // since we can't sample pixel data statically.
      fillColor = { r: 128, g: 128, b: 128, a: 1 }
    }

    if (fillColor === null) continue
    const shapeArea = area(fe.aabb)
    if (shapeArea > bestArea) {
      bestArea = shapeArea
      bestColor = fillColor
    }
  }

  return bestColor ?? parseColor(pageBackground)
}

function lintContrast(flat: FlatElement[], page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  const visibleTexts = flat.filter(
    (fe) => fe.element.visible && fe.element.kind === 'text' && fe.effectiveOpacity > 0,
  )

  for (const textFe of visibleTexts) {
    const el = textFe.element as TextElement
    const textColor = parseColor(el.fill)
    if (textColor === null) continue // transparent text — no contrast check

    const bgColor = resolveTextBackground(textFe, flat, page.background)
    if (bgColor === null) continue // fully transparent bg — skip

    const ratio = contrastRatio(textColor, bgColor)
    // WCAG AA: 4.5:1 for small text (fontSize < 24), 3:1 for large text
    const threshold = el.fontSize < 24 ? 4.5 : 3.0
    if (ratio < threshold) {
      findings.push({
        rule: 'contrast',
        severity: 'error',
        elementIds: [el.id],
        message:
          `"${el.name}" (${el.fontSize}px) has contrast ratio ${ratio.toFixed(2)}:1 against its background — ` +
          `below WCAG AA ${threshold}:1 requirement. Darken the text or lighten the background to reach ≥${threshold}:1.`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: hierarchy (WARNING)
// ---------------------------------------------------------------------------

function lintHierarchy(flat: FlatElement[], _page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  const texts = flat.filter(
    (fe) => fe.element.visible && fe.element.kind === 'text',
  ).map((fe) => fe.element as TextElement)

  if (texts.length === 0) return findings

  const sizes = texts.map((t) => t.fontSize)
  const uniqueSizes = [...new Set(sizes)].sort((a, b) => a - b)

  // More than 3 distinct font sizes = typographic noise
  if (uniqueSizes.length > 3) {
    findings.push({
      rule: 'hierarchy',
      severity: 'warning',
      elementIds: texts.map((t) => t.id),
      message:
        `${uniqueSizes.length} distinct font sizes on this page (${uniqueSizes.join(', ')}px) — ` +
        `exceeds the 3-size limit. Consolidate to a clear headline / subhead / body trio.`,
    })
  }

  // Flat hierarchy: max/min ratio < 1.4 when there are ≥ 2 sizes
  if (uniqueSizes.length >= 2) {
    const minSize = uniqueSizes[0]!
    const maxSize = uniqueSizes[uniqueSizes.length - 1]!
    const ratio = maxSize / minSize
    if (ratio < 1.4) {
      findings.push({
        rule: 'hierarchy',
        severity: 'warning',
        elementIds: texts.map((t) => t.id),
        message:
          `Headline/body size ratio is ${ratio.toFixed(2)} (${maxSize}px / ${minSize}px) — ` +
          `below the 1.4 minimum for a readable hierarchy. Increase headline size or reduce body size.`,
      })
    }
  }

  // Two text elements within 1px of each other in fontSize but different fontFamily
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!
      const b = texts[j]!
      if (Math.abs(a.fontSize - b.fontSize) <= 1 && a.fontFamily !== b.fontFamily) {
        findings.push({
          rule: 'hierarchy',
          severity: 'warning',
          elementIds: [a.id, b.id],
          message:
            `"${a.name}" (${a.fontSize}px, ${a.fontFamily}) and "${b.name}" (${b.fontSize}px, ${b.fontFamily}) ` +
            `are the same size but different fonts — ambiguous visual weight. ` +
            `Use the same font family or separate sizes by more than 1px.`,
        })
      }
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: alignment (WARNING)
// ---------------------------------------------------------------------------

const ALIGN_CLUSTER_TOLERANCE = 4 // px
const MAX_DISTINCT_LEFT_EDGES = 4
const CROWDING_MARGIN = 12 // px

/** Cluster x-values within ±tolerance and return the count of distinct clusters. */
function countDistinctClusters(values: number[], tolerance: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  let clusters = 1
  let clusterCenter = sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - clusterCenter > tolerance) {
      clusters++
      clusterCenter = sorted[i]!
    }
  }
  return clusters
}

function lintAlignment(flat: FlatElement[], page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  const visibleTexts = flat.filter(
    (fe) => fe.element.visible && fe.element.kind === 'text',
  )

  if (visibleTexts.length >= 2) {
    const leftEdges = visibleTexts.map((fe) => fe.aabb.x)
    const distinctClusters = countDistinctClusters(leftEdges, ALIGN_CLUSTER_TOLERANCE)
    if (distinctClusters > MAX_DISTINCT_LEFT_EDGES) {
      const elementIds = visibleTexts.map((fe) => fe.element.id)
      findings.push({
        rule: 'alignment',
        severity: 'warning',
        elementIds,
        message:
          `${distinctClusters} distinct left-edge x positions among text elements (threshold ${MAX_DISTINCT_LEFT_EDGES}, ±${ALIGN_CLUSTER_TOLERANCE}px clustering). ` +
          `Align text to ≤${MAX_DISTINCT_LEFT_EDGES} left-edge columns for visual order.`,
      })
    }
  }

  // Elements within 12px of any page edge = crowding margin violation
  const visible = flat.filter((fe) => fe.element.visible)
  for (const fe of visible) {
    const { aabb, element } = fe
    const edges: string[] = []
    if (aabb.x < CROWDING_MARGIN) edges.push(`left edge (${Math.round(aabb.x)}px from edge)`)
    if (aabb.y < CROWDING_MARGIN) edges.push(`top edge (${Math.round(aabb.y)}px from edge)`)
    if (page.width - (aabb.x + aabb.width) < CROWDING_MARGIN && page.width - (aabb.x + aabb.width) >= 0) {
      edges.push(`right edge (${Math.round(page.width - (aabb.x + aabb.width))}px from edge)`)
    }
    if (page.height - (aabb.y + aabb.height) < CROWDING_MARGIN && page.height - (aabb.y + aabb.height) >= 0) {
      edges.push(`bottom edge (${Math.round(page.height - (aabb.y + aabb.height))}px from edge)`)
    }
    if (edges.length > 0) {
      findings.push({
        rule: 'alignment',
        severity: 'warning',
        elementIds: [element.id],
        message:
          `"${element.name}" is within ${CROWDING_MARGIN}px of the ${edges.join(' and ')}. ` +
          `Add at least ${CROWDING_MARGIN}px of margin on all sides to avoid crowding.`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: spacing (WARNING)
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

function lintSpacing(flat: FlatElement[], _page: ScenePage): LintFinding[] {
  const findings: LintFinding[] = []

  // Consider only visible text elements, sorted by vertical position
  const textFes = flat
    .filter((fe) => fe.element.visible && fe.element.kind === 'text')
    .sort((a, b) => a.aabb.y - b.aabb.y)

  if (textFes.length < 3) return findings

  // Compute vertical gaps between consecutive text blocks (by top edge of next
  // minus bottom edge of current). Only positive gaps between non-overlapping
  // blocks are meaningful for spacing rhythm.
  const gaps: number[] = []
  const gapPairs: Array<[FlatElement, FlatElement]> = []
  for (let i = 0; i < textFes.length - 1; i++) {
    const curr = textFes[i]!
    const next = textFes[i + 1]!
    const gap = next.aabb.y - (curr.aabb.y + curr.aabb.height)
    if (gap > 0) {
      gaps.push(gap)
      gapPairs.push([curr, next])
    }
  }

  if (gaps.length < 2) return findings

  const med = median(gaps)
  if (med === 0) return findings

  const outliers: string[] = []
  const outlierIds = new Set<string>()
  for (let i = 0; i < gaps.length; i++) {
    const deviation = Math.abs(gaps[i]! - med) / med
    if (deviation > 0.4) {
      const [a, b] = gapPairs[i]!
      outliers.push(`gap between "${a.element.name}" and "${b.element.name}" is ${Math.round(gaps[i]!)}px (median ${Math.round(med)}px)`)
      outlierIds.add(a.element.id)
      outlierIds.add(b.element.id)
    }
  }

  if (outliers.length > 0) {
    findings.push({
      rule: 'spacing',
      severity: 'warning',
      elementIds: [...outlierIds],
      message:
        `Inconsistent vertical spacing between text blocks (>40% deviation from median ${Math.round(med)}px): ` +
        `${outliers.join('; ')}. Normalize gaps to a consistent rhythm.`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Rule: palette (WARNING)
// ---------------------------------------------------------------------------

/** Canonicalize a fill color to a bucketed string for palette counting. */
function canonicalFillColor(color: string): Rgb | null {
  return parseColor(color)
}

/** Round to the nearest 16 for palette bucketing (coarse dedup). */
function bucketRgb(rgb: Rgb): string {
  const r = Math.round(rgb.r / 16) * 16
  const g = Math.round(rgb.g / 16) * 16
  const b = Math.round(rgb.b / 16) * 16
  return `${r},${g},${b}`
}

function lintPalette(document: SceneDocument): LintFinding[] {
  const seen = new Map<string, string>() // bucket → representative hex

  for (const page of document.pages) {
    const flat = flattenElements(page.elements)
    for (const fe of flat) {
      const el = fe.element
      let fill: string | undefined
      if (el.kind === 'rect' || el.kind === 'ellipse') fill = (el as { fill: string }).fill
      else if (el.kind === 'text') fill = (el as TextElement).fill

      if (!fill) continue
      const rgb = canonicalFillColor(fill)
      if (rgb === null) continue
      if (isNeutralColor(rgb)) continue
      const bucket = bucketRgb(rgb)
      if (!seen.has(bucket)) seen.set(bucket, fill)
    }
  }

  if (seen.size > 5) {
    const colors = [...seen.values()].slice(0, 10)
    return [
      {
        rule: 'palette',
        severity: 'warning',
        elementIds: [],
        message:
          `${seen.size} distinct non-neutral fill colors document-wide (threshold 5): ${colors.join(', ')}${seen.size > 10 ? ', …' : ''}. ` +
          `Reduce to ≤5 brand colors; treat the rest as neutrals.`,
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Page and document linters
// ---------------------------------------------------------------------------

export function lintScenePage(document: SceneDocument, pageId: string): LintReport {
  const page = requirePage(document, pageId)
  const { n: _ } = { n: 0 }
  const flat = flattenElements(page.elements)

  const findings: LintFinding[] = [
    ...lintTextOverlap(flat, page),
    ...lintElementOverflow(flat, page),
    ...lintTextOverflowBand(flat, page),
    ...lintContrast(flat, page),
    ...lintHierarchy(flat, page),
    ...lintAlignment(flat, page),
    ...lintSpacing(flat, page),
    // palette is document-wide; run it scoped to this page's document
    ...lintPalette(document),
  ]

  const score = computeLintScore(findings)
  const pageResult: PageLintResult = { pageId: page.id, pageName: page.name, findings, score }

  return {
    pages: [pageResult],
    documentScore: score,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
  }
}

export function lintSceneDocument(document: SceneDocument): LintReport {
  const paletteFindings = lintPalette(document)

  const pages: PageLintResult[] = document.pages.map((page) => {
    const flat = flattenElements(page.elements)

    const findings: LintFinding[] = [
      ...lintTextOverlap(flat, page),
      ...lintElementOverflow(flat, page),
      ...lintTextOverflowBand(flat, page),
      ...lintContrast(flat, page),
      ...lintHierarchy(flat, page),
      ...lintAlignment(flat, page),
      ...lintSpacing(flat, page),
      // palette findings are shared across pages — attach to each page so the
      // model knows which page context they appear in
      ...paletteFindings,
    ]

    const score = computeLintScore(findings)
    return { pageId: page.id, pageName: page.name, findings, score }
  })

  const totalScore = pages.length === 0 ? 0 : pages.reduce((s, p) => s + p.score, 0) / pages.length
  const allFindings = pages.flatMap((p) => p.findings)

  return {
    pages,
    documentScore: Math.round(totalScore * 10) / 10,
    errorCount: allFindings.filter((f) => f.severity === 'error').length,
    warningCount: allFindings.filter((f) => f.severity === 'warning').length,
  }
}
