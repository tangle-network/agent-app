/**
 * Pure geometry helpers extracted from component drag/transform logic so
 * every interactive math path is unit-testable without Konva or a DOM.
 *
 * Invariants:
 * - All inputs and outputs are in document-coordinate pixels unless noted.
 * - Rotation angles are degrees, clockwise, matching the Konva + model convention.
 * - "Baking" scale into width/height resets Konva's scaleX/scaleY to 1; that
 *   is required so the model's width/height always reflects true size, never a
 *   scaled-but-uncollapsed state.
 */

// ---------------------------------------------------------------------------
// Konva transformer end-state baking
// ---------------------------------------------------------------------------

export interface TransformerNode {
  x: number
  y: number
  width: number
  height: number
  /** Konva's scale after the transformer gesture; 1 when already baked. */
  scaleX: number
  scaleY: number
  rotation: number
}

/** Define baked node attributes including position, size, and rotation with collapsed scale */
export interface BakedNodeAttrs {
  x: number
  y: number
  /** True pixel size after scale is collapsed into dimensions. */
  width: number
  height: number
  rotation: number
}

/**
 * Collapse Konva scaleX/scaleY into width/height so the model always stores
 * true pixel dimensions. The transformer mutates scale on drag; we bake it
 * once at dragend/transformend and emit width/height — scale resets to 1
 * implicitly (the emitted attrs do not include scale, so the next render
 * starts from scaleX=1).
 *
 * Konva rotates about the top-left origin and also shifts x/y to compensate
 * for scale — the transformer gives us the post-rotation, post-scale x/y
 * directly, so no further rotation math is needed here.
 */
export function bakeRectTransform(node: TransformerNode): BakedNodeAttrs {
  return {
    x: node.x,
    y: node.y,
    width: Math.abs(node.width * node.scaleX),
    height: Math.abs(node.height * node.scaleY),
    rotation: node.rotation,
  }
}

/**
 * Lines store points as a flat [x0, y0, x1, y1, ...] array relative to the
 * line element's (x, y). When the transformer scales the group containing the
 * line, we bake scaleX into every x-component of points and scaleY into every
 * y-component, then reset scale to 1. The element x/y is the Konva group
 * origin and is taken directly from the transformer output.
 */
export function bakeLineTransform(node: TransformerNode & { points: number[] }): BakedNodeAttrs & { points: number[] } {
  const points = node.points.map((v, i) => (i % 2 === 0 ? v * node.scaleX : v * node.scaleY))
  return {
    x: node.x,
    y: node.y,
    // Width/height for a line derive from its points; baking is for points only.
    // We still return them so callers have a uniform shape.
    width: node.width * Math.abs(node.scaleX),
    height: node.height * Math.abs(node.scaleY),
    rotation: node.rotation,
    points,
  }
}

/**
 * Text nodes have a fixed wrap width; scaling that width is what the
 * transformer controls. Height is content-derived and is NOT baked here —
 * it re-derives from text content at render time via estimateTextHeight.
 * Only scaleX is baked into width; scaleY into fontSize so text scales
 * proportionally when the user resizes with keepRatio.
 */
export function bakeTextTransform(
  node: TransformerNode & { fontSize: number },
): BakedNodeAttrs & { fontSize: number } {
  return {
    x: node.x,
    y: node.y,
    width: Math.abs(node.width * node.scaleX),
    // Height is excluded — it re-derives from content.
    height: node.height,
    rotation: node.rotation,
    fontSize: Math.max(1, node.fontSize * Math.abs(node.scaleY)),
  }
}

// ---------------------------------------------------------------------------
// Ellipse center-offset math
// ---------------------------------------------------------------------------

/**
 * The model stores ellipse position as the top-left corner of the bounding
 * box (matching every other element kind). Konva.Ellipse draws from its center
 * (radiusX, radiusY). This converts model top-left to Konva center.
 *
 * INVARIANT: radiusX = width/2, radiusY = height/2; x/y offsets are exactly
 * half the dimensions because there is no separate offset field.
 */
export function ellipseCenterFromTopLeft(
  topLeft: { x: number; y: number; width: number; height: number },
): { x: number; y: number; radiusX: number; radiusY: number } {
  return {
    x: topLeft.x + topLeft.width / 2,
    y: topLeft.y + topLeft.height / 2,
    radiusX: topLeft.width / 2,
    radiusY: topLeft.height / 2,
  }
}

/**
 * Inverse: Konva center + radius → model top-left. Used when reading back
 * from a transformer node whose origin is the Konva center.
 */
export function ellipseTopLeftFromCenter(
  center: { x: number; y: number; radiusX: number; radiusY: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: center.x - center.radiusX,
    y: center.y - center.radiusY,
    width: center.radiusX * 2,
    height: center.radiusY * 2,
  }
}

// ---------------------------------------------------------------------------
// Marquee selection
// ---------------------------------------------------------------------------

export interface MarqueeRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Normalize a marquee rectangle from two arbitrary corners into a canonical
 * top-left origin with positive width/height, regardless of drag direction.
 */
export function normalizeMarquee(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): MarqueeRect {
  const x = Math.min(startX, endX)
  const y = Math.min(startY, endY)
  return {
    x,
    y,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  }
}

// ---------------------------------------------------------------------------
// Inline text editor overlay positioning
// ---------------------------------------------------------------------------

export interface OverlayPositionInput {
  /** Element top-left in document coordinates. */
  elementX: number
  elementY: number
  elementWidth: number
  elementHeight: number
  /** Current zoom and pan. */
  zoom: number
  panX: number
  panY: number
}

export interface OverlayPosition {
  /** CSS left/top for the overlay textarea relative to the canvas container. */
  left: number
  top: number
  width: number
  /** fontSize to mirror from the element, scaled by zoom. */
  fontSize: number
}

/**
 * Compute the screen-space position for an inline text editor overlay.
 *
 * V1 simplification: rotated text elements are edited in a non-rotated overlay
 * positioned at the element's AABB. This means the overlay does not visually
 * align with the rotated text, but keeps the textarea DOM element axis-aligned
 * which avoids browser textarea rotation bugs. A future v2 may apply a CSS
 * transform to the textarea to match rotation.
 */
export function computeTextOverlayPosition(
  input: OverlayPositionInput & { elementFontSize: number },
): OverlayPosition {
  // The overlay textarea is position:absolute inside the workspace's relative
  // container, so its coordinates are container-relative, not viewport-relative:
  // containerX = panX + elementX * zoom.
  const left = input.panX + input.elementX * input.zoom
  const top = input.panY + input.elementY * input.zoom
  return {
    left,
    top,
    width: input.elementWidth * input.zoom,
    fontSize: input.elementFontSize * input.zoom,
  }
}

// ---------------------------------------------------------------------------
// Rotation snapping
// ---------------------------------------------------------------------------

const SNAP_ANGLES_DEG = [0, 45, 90, 135, 180, 225, 270, 315, 360]

/**
 * Snap a rotation angle to the nearest cardinal/diagonal if within
 * `thresholdDeg` of it (default 5°). Returns the original value when no snap
 * activates. Normalizes output to [0, 360).
 */
export function snapRotation(angleDeg: number, thresholdDeg = 5): number {
  const normalized = ((angleDeg % 360) + 360) % 360
  let best = normalized
  let bestDist = Infinity
  for (const snap of SNAP_ANGLES_DEG) {
    const dist = Math.abs(normalized - snap)
    if (dist < bestDist) {
      bestDist = dist
      best = snap % 360
    }
  }
  return bestDist <= thresholdDeg ? best : normalized
}

// ---------------------------------------------------------------------------
// Nudge delta
// ---------------------------------------------------------------------------

/**
 * Convert a keyboard arrow event into a {dx, dy} nudge in document px.
 * Shift multiplies by 10 (the "big nudge" convention).
 */
export function nudgeDelta(
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  shift: boolean,
): { dx: number; dy: number } {
  const step = shift ? 10 : 1
  switch (key) {
    case 'ArrowLeft':  return { dx: -step, dy: 0 }
    case 'ArrowRight': return { dx: step,  dy: 0 }
    case 'ArrowUp':    return { dx: 0,     dy: -step }
    case 'ArrowDown':  return { dx: 0,     dy: step }
  }
}

// ---------------------------------------------------------------------------
// Marquee hit-test
// ---------------------------------------------------------------------------

/**
 * Return true when bounds B is entirely contained within marquee A.
 * Partial intersection does NOT select — the marquee must fully enclose.
 */
export function marqueeContains(marquee: MarqueeRect, bounds: MarqueeRect): boolean {
  return (
    bounds.x >= marquee.x &&
    bounds.y >= marquee.y &&
    bounds.x + bounds.width <= marquee.x + marquee.width &&
    bounds.y + bounds.height <= marquee.y + marquee.height
  )
}

// ---------------------------------------------------------------------------
// Grid ruler tick density
// ---------------------------------------------------------------------------

/**
 * Return true when grid lines at `gridSize` document px would render at least
 * `minScreenPx` apart at the current zoom. Used to skip grid drawing when
 * zoomed out far enough that lines would clutter.
 */
export function gridVisible(gridSize: number, zoom: number, minScreenPx = 4): boolean {
  return gridSize * zoom >= minScreenPx
}
