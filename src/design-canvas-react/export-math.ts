/**
 * Pure export math for the design-canvas surface — no Konva, no DOM, no React.
 *
 * All stage-interaction code (save/restore, node visibility, toDataURL) lives
 * in export.ts and delegates the decision math here so it can be tested
 * without a canvas environment.
 */

import type { ScenePage } from '../design-canvas/model'
import {
  bleedAwareExportBounds,
  scaleForPreset,
  type ExportCropRect,
  type ExportPreset,
} from '../design-canvas/export-presets'

// ---------------------------------------------------------------------------
// Re-exports so callers only import from one place
// ---------------------------------------------------------------------------

export type { ExportCropRect, ExportPreset }
export { bleedAwareExportBounds, scaleForPreset }

// ---------------------------------------------------------------------------
// Overlay / transformer node name predicates
// ---------------------------------------------------------------------------

/** Returns true for any Konva node that must be hidden during export. Nodes
 *  whose names start with 'overlay:' are editor-only chrome (snap lines,
 *  selection indicators, rulers, bleed guides). The transformer node is
 *  identified by its canonical name 'Transformer'. */
export function isExportHiddenNodeName(name: string): boolean {
  return name.startsWith('overlay:') || name === 'Transformer'
}

// ---------------------------------------------------------------------------
// Crop rect + pixel ratio resolution
// ---------------------------------------------------------------------------

/** Define parameters required to resolve export settings including crop, pixel ratio, type, and quality */
export interface ResolvedExportParams {
  cropRect: ExportCropRect
  pixelRatio: number
  mimeType: 'image/png' | 'image/jpeg'
  quality: number | undefined
}

/**
 * Resolve the full set of toDataURL params from a page, format, pixel ratio,
 * bleed flag, and optional preset. When a preset is supplied it overrides
 * `pixelRatio` and `includeBleed` — the explicit args are ignored for those
 * two values so the preset is the single source of truth.
 *
 * `quality` is set to 0.92 for jpeg, undefined for png (Konva ignores it).
 */
export function resolveExportParams(
  page: ScenePage,
  opts: {
    format: 'png' | 'jpeg'
    pixelRatio?: number
    includeBleed?: boolean
    preset?: ExportPreset
  },
): ResolvedExportParams {
  const includeBleed = opts.preset !== undefined
    ? opts.preset.includeBleed
    : (opts.includeBleed ?? false)

  const cropRect = bleedAwareExportBounds(page, includeBleed)

  const pixelRatio = opts.preset !== undefined
    ? scaleForPreset(opts.preset, cropRect)
    : (opts.pixelRatio ?? 1)

  const format = opts.preset !== undefined ? opts.preset.format : opts.format
  const mimeType: 'image/png' | 'image/jpeg' = format === 'jpeg' ? 'image/jpeg' : 'image/png'

  return {
    cropRect,
    pixelRatio,
    mimeType,
    quality: format === 'jpeg' ? 0.92 : undefined,
  }
}

// ---------------------------------------------------------------------------
// CORS taint detection
// ---------------------------------------------------------------------------

/**
 * Walk image nodes to find the src of any that may have caused a SecurityError
 * when the stage called toDataURL. Returns the first offending src found, or
 * null if none can be identified.
 *
 * `imageSrcs` is a flat list of { name, src } records collected from all image
 * nodes on the stage before calling toDataURL — export.ts builds it before
 * attempting the export so that if the SecurityError fires we have the data.
 */
export function identifyTaintedSrc(imageSrcs: ReadonlyArray<{ name: string; src: string }>): string | null {
  // We cannot re-probe CORS from a caught SecurityError — the browser does not
  // tell us which src triggered it. Return the first src that looks like a
  // cross-origin resource the browser would taint: anything that is not a
  // same-origin relative path or a data: URL.
  for (const { src } of imageSrcs) {
    if (isCrossOriginSrc(src)) return src
  }
  return null
}

/**
 * Heuristic: a src is potentially cross-origin when it is an absolute http(s)
 * URL. Same-origin relative paths (/api/...) and data: blobs are safe.
 * This is intentionally conservative — the taint check runs only after a
 * SecurityError fires, so a false positive is "blamed" without being silently
 * ignored. NOTE: same-origin https:// assets will also match; if a
 * SecurityError fires, the cross-origin culprit may be a different image than
 * the one this function flags first.
 */
export function isCrossOriginSrc(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

// ---------------------------------------------------------------------------
// View state snapshot (used by save/restore helpers)
// ---------------------------------------------------------------------------

/** Minimal snapshot of stage view state that export.ts saves before mutating
 *  zoom/pan/visibility and restores afterward. */
export interface ExportViewSnapshot {
  /** Stage scale factor before export. */
  scaleX: number
  scaleY: number
  /** Stage translation before export. */
  x: number
  y: number
  /** node name → prior visibility, for the nodes that were hidden. */
  hiddenNodeNames: string[]
}

/**
 * Build the toDataURL crop rect translated to stage output coordinates.
 * Konva's `stage.toDataURL({ x, y, width, height })` takes STAGE OUTPUT
 * coordinates, not document coordinates. When the stage has been scaled to fit
 * (zoom × stageScale), the crop rect in document px must be multiplied by the
 * combined scale to land on the right pixels.
 *
 * `stageScale` is the stage's current uniform scale (scaleX == scaleY);
 * `pixelRatio` is separate and handed directly to toDataURL — Konva multiplies
 * it internally when rendering to the backing canvas, so we must NOT include
 * it in the stage-coordinate rect.
 */
export function documentCropToStageCoords(
  cropRect: ExportCropRect,
  stageScale: number,
  stageX: number,
  stageY: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: stageX + cropRect.x * stageScale,
    y: stageY + cropRect.y * stageScale,
    width: cropRect.width * stageScale,
    height: cropRect.height * stageScale,
  }
}
