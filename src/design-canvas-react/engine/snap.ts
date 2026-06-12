/**
 * 2-axis snap engine for the design-canvas editor. Targets come from element
 * AABBs (edges + centers), page edges + center, saved guides, and grid lines
 * near the moving bounds. Grid lines are generated lazily in the neighborhood
 * of the moving element, not the full page — avoids allocating thousands of
 * targets on large pages with fine grids.
 *
 * Threshold is a SCREEN distance (pixels), divided by zoom to convert to
 * document units — what "feels close" is a screen distance.
 *
 * Tie-breaking: non-grid kinds beat grid on equal distance; among equals of
 * the same priority the first in iteration order wins.
 */

import { elementAabb } from '../../design-canvas/model'
import type { Bounds, SceneElement, ScenePage } from '../../design-canvas/model'
import type { EditorSceneState, SnapEngine, SnapResult, SnapTarget, SnapTargetKind, SnapTargets } from '../contracts'

/** Priority rank for tie-breaking: lower = higher priority (wins the tie). */
const KIND_PRIORITY: Record<SnapTargetKind, number> = {
  'guide':          0,
  'page-edge':      1,
  'page-center':    2,
  'element-edge':   3,
  'element-center': 4,
  'grid':           5,
}

export function createSnapEngine(): SnapEngine {
  return {
    collectTargets(state: EditorSceneState, excludeIds: string[]): SnapTargets {
      const page = state.document.pages.find((p) => p.id === state.activePageId)
      if (!page) throw new Error(`collectTargets: active page ${state.activePageId} not found`)

      const vertical: SnapTarget[] = []
      const horizontal: SnapTarget[] = []
      const excludeSet = new Set(excludeIds)

      // Page edges + center
      vertical.push({ position: 0, kind: 'page-edge' })
      vertical.push({ position: page.width, kind: 'page-edge' })
      vertical.push({ position: page.width / 2, kind: 'page-center' })
      horizontal.push({ position: 0, kind: 'page-edge' })
      horizontal.push({ position: page.height, kind: 'page-edge' })
      horizontal.push({ position: page.height / 2, kind: 'page-center' })

      // Saved ruler guides
      for (const pos of page.guides.vertical) {
        vertical.push({ position: pos, kind: 'guide' })
      }
      for (const pos of page.guides.horizontal) {
        horizontal.push({ position: pos, kind: 'guide' })
      }

      // Element edges + centers (visible, unlocked, not excluded)
      collectElementTargets(page.elements, excludeSet, vertical, horizontal)

      // Grid lines (deferred to apply() with the moving bounds neighborhood)
      // Grid targets are injected by collectGridTargets() when gridEnabled.

      return { vertical, horizontal }
    },

    apply(bounds: Bounds, targets: SnapTargets, thresholdPx: number, zoom: number): SnapResult {
      if (!Number.isFinite(zoom) || zoom <= 0) {
        throw new Error(`snap.apply: zoom must be a positive finite number, got ${zoom}`)
      }
      if (!Number.isFinite(thresholdPx) || thresholdPx < 0) {
        throw new Error(`snap.apply: thresholdPx must be a non-negative finite number, got ${thresholdPx}`)
      }
      const threshold = thresholdPx / zoom

      const snappedX = snapAxis(bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width, targets.vertical, threshold)
      const snappedY = snapAxis(bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height, targets.horizontal, threshold)

      return {
        x: snappedX !== null ? snappedX.docPosition - snappedX.elementOffset : bounds.x,
        y: snappedY !== null ? snappedY.docPosition - snappedY.elementOffset : bounds.y,
        activeVertical: snappedX !== null ? snappedX.target : null,
        activeHorizontal: snappedY !== null ? snappedY.target : null,
      }
    },
  }
}

/** Generate grid line targets within a neighborhood around the moving bounds.
 *  Call this and append to `SnapTargets.vertical`/`horizontal` before
 *  passing to `apply()` when `state.gridEnabled`. */
export function collectGridTargets(
  bounds: Bounds,
  gridSize: number,
  page: ScenePage,
  thresholdDocPx: number,
): { vertical: SnapTarget[]; horizontal: SnapTarget[] } {
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    throw new Error(`collectGridTargets: gridSize must be positive finite, got ${gridSize}`)
  }
  const vertical: SnapTarget[] = []
  const horizontal: SnapTarget[] = []

  // Generate lines that fall within the bounds + threshold neighborhood
  const xMin = Math.floor((bounds.x - thresholdDocPx) / gridSize) * gridSize
  const xMax = Math.ceil((bounds.x + bounds.width + thresholdDocPx) / gridSize) * gridSize
  for (let x = xMin; x <= xMax; x += gridSize) {
    if (x >= 0 && x <= page.width) vertical.push({ position: x, kind: 'grid' })
  }

  const yMin = Math.floor((bounds.y - thresholdDocPx) / gridSize) * gridSize
  const yMax = Math.ceil((bounds.y + bounds.height + thresholdDocPx) / gridSize) * gridSize
  for (let y = yMin; y <= yMax; y += gridSize) {
    if (y >= 0 && y <= page.height) horizontal.push({ position: y, kind: 'grid' })
  }

  return { vertical, horizontal }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SnapHit {
  /** The snap target that won. */
  target: SnapTarget
  /** The document-coordinate position of the snap line. */
  docPosition: number
  /** How far the element's reference point (left/center/right or top/mid/bottom)
   *  is from the element's x/y origin — used to reconstruct the new origin. */
  elementOffset: number
}

/** Try snapping each of the three reference points (start/center/end) to the
 *  nearest target. Returns the best hit across all three, or null. */
function snapAxis(start: number, center: number, end: number, targets: SnapTarget[], threshold: number): SnapHit | null {
  const candidates: Array<{ value: number; offset: number }> = [
    { value: start, offset: 0 },
    { value: center, offset: center - start },
    { value: end, offset: end - start },
  ]

  let best: SnapHit | null = null
  let bestDistance = Infinity
  let bestPriority = Infinity

  for (const { value, offset } of candidates) {
    for (const target of targets) {
      const distance = Math.abs(target.position - value)
      if (distance > threshold) continue
      const priority = KIND_PRIORITY[target.kind]
      if (
        distance < bestDistance ||
        (distance === bestDistance && priority < bestPriority)
      ) {
        bestDistance = distance
        bestPriority = priority
        best = { target, docPosition: target.position, elementOffset: offset }
      }
    }
  }

  return best
}

function collectElementTargets(
  elements: SceneElement[],
  excludeIds: Set<string>,
  vertical: SnapTarget[],
  horizontal: SnapTarget[],
): void {
  for (const el of elements) {
    if (!el.visible || el.locked) continue
    if (excludeIds.has(el.id)) continue

    const aabb = elementAabb(el)
    // Left, center, right
    vertical.push({ position: aabb.x, kind: 'element-edge' })
    vertical.push({ position: aabb.x + aabb.width / 2, kind: 'element-center' })
    vertical.push({ position: aabb.x + aabb.width, kind: 'element-edge' })
    // Top, middle, bottom
    horizontal.push({ position: aabb.y, kind: 'element-edge' })
    horizontal.push({ position: aabb.y + aabb.height / 2, kind: 'element-center' })
    horizontal.push({ position: aabb.y + aabb.height, kind: 'element-edge' })

    if (el.kind === 'group') {
      collectElementTargets(el.children, excludeIds, vertical, horizontal)
    }
  }
}
