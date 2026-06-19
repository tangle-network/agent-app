/**
 * Selection math for the design-canvas editor: marquee hit-tests, keyboard
 * nudge deltas, and the duplicate offset constant. Pure functions — no DOM, no
 * Konva, no React.
 *
 * Marquee inclusion: by default any element whose AABB intersects the marquee
 * rect is included (the "touch" model). Pass `requireFullContainment: true` for
 * the "surround" model where the marquee must fully contain the element. Locked
 * and invisible elements are never selected regardless.
 */

import { boundsIntersect, elementAabb } from '../../design-canvas/model'
import type { Bounds, SceneElement, ScenePage } from '../../design-canvas/model'

// ---------------------------------------------------------------------------
// Point hit-test (model-space)
// ---------------------------------------------------------------------------

/**
 * Top-most selectable element whose AABB contains the document-space point, or
 * null when the point is over empty space.
 *
 * This is the authoritative "is the pointer over an element?" test for the
 * pointer-down gesture router. It runs against the scene model in document
 * coordinates rather than Konva's hit-graph canvas, so it is independent of
 * clip groups, listening flags, and hit-canvas redraw timing — all of which
 * could make `stage.getIntersection` misclassify a press as empty space and
 * silently start a marquee instead of an element drag.
 *
 * Z-order: later elements paint on top, so we scan the array in reverse and
 * return the first hit. Groups descend into children (top child wins); a hit on
 * a group child resolves to the group itself, matching drag/selection which
 * operate on the group as a unit. Locked and invisible elements never hit.
 */
export function hitTestPoint(page: ScenePage, x: number, y: number): string | null {
  return hitTestIn(page.elements, x, y, null)
}

function hitTestIn(
  elements: SceneElement[],
  x: number,
  y: number,
  resolveTo: string | null,
): string | null {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i]!
    if (!el.visible || el.locked) continue
    const aabb = elementAabb(el)
    if (!pointInBounds(aabb, x, y)) continue
    if (el.kind === 'group') {
      // A press anywhere inside the group AABB selects the group as a unit,
      // even over the gaps between children — the group is the draggable node.
      const child = hitTestIn(el.children, x, y, el.id)
      return child ?? el.id
    }
    return resolveTo ?? el.id
  }
  return null
}

function pointInBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
}

export interface MarqueeSelectOptions {
  /** When true, the element's AABB must be fully inside the marquee; default is
   *  intersection (any overlap selects). */
  requireFullContainment?: boolean
}

/** Returns the ids of selectable elements on `page` whose AABB intersects (or
 *  is contained by) `rect`. Locked and invisible elements are excluded. */
export function marqueeSelect(page: ScenePage, rect: Bounds, opts: MarqueeSelectOptions = {}): string[] {
  assertValidBounds(rect, 'marqueeSelect rect')
  const result: string[] = []
  collectMarqueeIds(page.elements, rect, opts.requireFullContainment ?? false, result)
  return result
}

function collectMarqueeIds(
  elements: SceneElement[],
  rect: Bounds,
  requireContainment: boolean,
  result: string[],
): void {
  for (const el of elements) {
    if (!el.visible || el.locked) continue
    const aabb = elementAabb(el)

    if (el.kind === 'group') {
      // Groups are transparent to marquee: descend when the group AABB intersects
      // the rect, collecting children individually. The group entity itself is
      // never added — marquee selects leaf elements, not the group wrapper.
      if (boundsIntersect(rect, aabb)) {
        collectMarqueeIds(el.children, rect, requireContainment, result)
      }
      continue
    }

    const hit = requireContainment ? boundsContain(rect, aabb) : boundsIntersect(rect, aabb)
    if (hit) result.push(el.id)
  }
}

/** Returns true when `outer` fully contains `inner` (edges may touch). */
function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

// ---------------------------------------------------------------------------
// Keyboard nudge
// ---------------------------------------------------------------------------

/** Pixels to move per nudge step at normal and shifted speed. */
const NUDGE_NORMAL_PX = 1
const NUDGE_SHIFT_PX = 10

export interface NudgeDelta {
  dx: number
  dy: number
}

/** Map an arrow key to a document-px delta. `shift` engages the 10× step.
 *  Throws on unknown keys so callers handle only real nudge keys. */
export function nudgeDelta(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', shift: boolean): NudgeDelta {
  const step = shift ? NUDGE_SHIFT_PX : NUDGE_NORMAL_PX
  switch (key) {
    case 'ArrowLeft':  return { dx: -step, dy: 0 }
    case 'ArrowRight': return { dx: step,  dy: 0 }
    case 'ArrowUp':    return { dx: 0,     dy: -step }
    case 'ArrowDown':  return { dx: 0,     dy: step }
  }
}

// ---------------------------------------------------------------------------
// Duplicate offset
// ---------------------------------------------------------------------------

/** Document-px offset applied to duplicated elements so the copy is visually
 *  separated from the original (matching common design-tool convention). */
export const DUPLICATE_OFFSET: NudgeDelta = { dx: 10, dy: 10 }

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function assertValidBounds(bounds: Bounds, label: string): void {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    throw new Error(`${label}: all fields must be finite numbers`)
  }
}
