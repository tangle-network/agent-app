/**
 * Client-side export for design-canvas pages: raster (PNG/JPEG via Konva
 * stage.toDataURL) and JSON (document serialisation).
 *
 * The heavy lifting — crop math, pixel ratio resolution, CORS taint detection
 * — lives in export-math.ts where it can be unit-tested without a canvas
 * context. This file is the thin Konva-wiring layer: hide overlays, call
 * toDataURL, restore, handle the SecurityError.
 *
 * Konva is an OPTIONAL peer. Import this file only from browser-context code
 * that has konva wired in. The types are written against a minimal structural
 * interface so the file compiles even when konva's types are absent.
 */

import type { SceneDocument, ScenePage } from '../design-canvas/model'
import { SCENE_SCHEMA_VERSION } from '../design-canvas/model'
import type { ExportPreset } from '../design-canvas/export-presets'
import {
  documentCropToStageCoords,
  identifyTaintedSrc,
  isExportHiddenNodeName,
  resolveExportParams,
} from './export-math'

// ---------------------------------------------------------------------------
// Minimal structural interfaces for Konva stage / node
// (avoids a hard konva import; the real Konva types satisfy these)
// ---------------------------------------------------------------------------

interface KonvaNodeLike {
  name(): string
  visible(): boolean
  visible(v: boolean): void
  getAttr(key: string): unknown
}

interface KonvaLayerLike {
  getChildren(): KonvaNodeLike[]
}

interface KonvaStageLike {
  scaleX(): number
  scaleY(): number
  x(): number
  y(): number
  getLayers(): KonvaLayerLike[]
  toDataURL(params: {
    mimeType: string
    quality?: number
    pixelRatio: number
    x: number
    y: number
    width: number
    height: number
  }): string
}

// ---------------------------------------------------------------------------
// Raster export
// ---------------------------------------------------------------------------

export interface ExportPageDataUrlOptions {
  format: 'png' | 'jpeg'
  pixelRatio?: number
  includeBleed?: boolean
  preset?: ExportPreset
}

/**
 * Render a single page to a data URL.
 *
 * The function temporarily hides every node whose name starts with 'overlay:'
 * plus any Transformer node, computes the crop rect and pixel ratio from the
 * page model and options, calls stage.toDataURL, then restores all prior view
 * state exactly — zoom, pan, and node visibility.
 *
 * Rejects with a descriptive error when a CORS-tainted image source causes
 * the SecurityError, naming the offending src so the caller can surface it.
 *
 * The `stage` argument must be the Konva stage with the page content already
 * rendered. The caller is responsible for ensuring all async image loads have
 * settled before calling this function.
 */
export async function exportPageDataUrl(
  stage: KonvaStageLike,
  page: ScenePage,
  opts: ExportPageDataUrlOptions,
): Promise<string> {
  const { cropRect, pixelRatio, mimeType, quality } = resolveExportParams(page, opts)

  // Collect all image node srcs BEFORE hiding anything, so the taint detector
  // has data even if the SecurityError fires mid-render.
  const imageSrcs = collectImageSrcs(stage)

  // Save state: which nodes we are hiding (visibility that was true → set false).
  const hiddenNodes: KonvaNodeLike[] = []

  for (const layer of stage.getLayers()) {
    for (const node of layer.getChildren()) {
      const name = node.name()
      if (isExportHiddenNodeName(name) && node.visible()) {
        node.visible(false)
        hiddenNodes.push(node)
      }
    }
  }

  // Compute the stage-coordinate crop rect for toDataURL.
  const stageScale = stage.scaleX()
  const stageCrop = documentCropToStageCoords(cropRect, stageScale, stage.x(), stage.y())

  let dataUrl: string
  try {
    dataUrl = stage.toDataURL({
      mimeType,
      ...(quality !== undefined ? { quality } : {}),
      pixelRatio,
      x: stageCrop.x,
      y: stageCrop.y,
      width: stageCrop.width,
      height: stageCrop.height,
    })
  } catch (err) {
    // Restore visibility before rethrowing so the editor is not left in a
    // broken state.
    for (const node of hiddenNodes) {
      node.visible(true)
    }

    if (err instanceof Error && err.name === 'SecurityError') {
      const taintedSrc = identifyTaintedSrc(imageSrcs)
      if (taintedSrc !== null) {
        throw new Error(
          `Export failed: image source is CORS-tainted and cannot be read by the canvas. ` +
          `Offending src: "${taintedSrc}". ` +
          `Ensure the image is served with Access-Control-Allow-Origin or use a proxied /api/ path.`,
        )
      }
      throw new Error(
        `Export failed: a canvas SecurityError occurred but no cross-origin image src could be identified. ` +
        `The stage may contain a tainted video or image loaded without CORS headers.`,
      )
    }
    throw err
  }

  // Restore visibility.
  for (const node of hiddenNodes) {
    node.visible(true)
  }

  return dataUrl
}

/** Collect all image-like nodes from the stage for taint identification. */
function collectImageSrcs(stage: KonvaStageLike): Array<{ name: string; src: string }> {
  const result: Array<{ name: string; src: string }> = []
  for (const layer of stage.getLayers()) {
    for (const node of layer.getChildren()) {
      const src = node.getAttr('src')
      if (typeof src === 'string' && src.length > 0) {
        result.push({ name: node.name(), src })
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

/**
 * Serialize a scene document to pretty-printed JSON with schemaVersion
 * asserted. Throws when the document's schemaVersion does not match
 * SCENE_SCHEMA_VERSION — the caller must not smuggle stale documents through.
 */
export function exportDocumentJson(document: SceneDocument): string {
  if (document.schemaVersion !== SCENE_SCHEMA_VERSION) {
    throw new Error(
      `exportDocumentJson: document schemaVersion is ${document.schemaVersion}, ` +
      `expected ${SCENE_SCHEMA_VERSION} — upgrade the document before exporting`,
    )
  }
  return JSON.stringify(document, null, 2)
}

// ---------------------------------------------------------------------------
// Browser download helper
// ---------------------------------------------------------------------------

/**
 * Trigger a browser download for a data URL. Safe to import in SSR — the
 * function is a no-op when `document` is not defined (e.g. server-side render
 * or test environment without a DOM). The integrator must not rely on the
 * download executing in those contexts.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  if (typeof globalThis.document === 'undefined') return

  const a = globalThis.document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.style.display = 'none'
  globalThis.document.body.appendChild(a)
  a.click()
  globalThis.document.body.removeChild(a)
}
