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
export interface TransformerNode {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Konva's scale after the transformer gesture; 1 when already baked. */
    scaleX: number;
    scaleY: number;
    rotation: number;
}
/** Define baked node attributes including position, size, and rotation with collapsed scale */
export interface BakedNodeAttrs {
    x: number;
    y: number;
    /** True pixel size after scale is collapsed into dimensions. */
    width: number;
    height: number;
    rotation: number;
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
export declare function bakeRectTransform(node: TransformerNode): BakedNodeAttrs;
/**
 * Lines store points as a flat [x0, y0, x1, y1, ...] array relative to the
 * line element's (x, y). When the transformer scales the group containing the
 * line, we bake scaleX into every x-component of points and scaleY into every
 * y-component, then reset scale to 1. The element x/y is the Konva group
 * origin and is taken directly from the transformer output.
 */
export declare function bakeLineTransform(node: TransformerNode & {
    points: number[];
}): BakedNodeAttrs & {
    points: number[];
};
/**
 * Text nodes have a fixed wrap width; scaling that width is what the
 * transformer controls. Height is content-derived and is NOT baked here —
 * it re-derives from text content at render time via estimateTextHeight.
 * Only scaleX is baked into width; scaleY into fontSize so text scales
 * proportionally when the user resizes with keepRatio.
 */
export declare function bakeTextTransform(node: TransformerNode & {
    fontSize: number;
}): BakedNodeAttrs & {
    fontSize: number;
};
/**
 * The model stores ellipse position as the top-left corner of the bounding
 * box (matching every other element kind). Konva.Ellipse draws from its center
 * (radiusX, radiusY). This converts model top-left to Konva center.
 *
 * INVARIANT: radiusX = width/2, radiusY = height/2; x/y offsets are exactly
 * half the dimensions because there is no separate offset field.
 */
export declare function ellipseCenterFromTopLeft(topLeft: {
    x: number;
    y: number;
    width: number;
    height: number;
}): {
    x: number;
    y: number;
    radiusX: number;
    radiusY: number;
};
/**
 * Inverse: Konva center + radius → model top-left. Used when reading back
 * from a transformer node whose origin is the Konva center.
 */
export declare function ellipseTopLeftFromCenter(center: {
    x: number;
    y: number;
    radiusX: number;
    radiusY: number;
}): {
    x: number;
    y: number;
    width: number;
    height: number;
};
interface MarqueeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * Normalize a marquee rectangle from two arbitrary corners into a canonical
 * top-left origin with positive width/height, regardless of drag direction.
 */
export declare function normalizeMarquee(startX: number, startY: number, endX: number, endY: number): MarqueeRect;
interface OverlayPositionInput {
    /** Element top-left in document coordinates. */
    elementX: number;
    elementY: number;
    elementWidth: number;
    elementHeight: number;
    /** Current zoom and pan. */
    zoom: number;
    panX: number;
    panY: number;
}
interface OverlayPosition {
    /** CSS left/top for the overlay textarea relative to the canvas container. */
    left: number;
    top: number;
    width: number;
    /** fontSize to mirror from the element, scaled by zoom. */
    fontSize: number;
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
export declare function computeTextOverlayPosition(input: OverlayPositionInput & {
    elementFontSize: number;
}): OverlayPosition;
/**
 * Snap a rotation angle to the nearest cardinal/diagonal if within
 * `thresholdDeg` of it (default 5°). Returns the original value when no snap
 * activates. Normalizes output to [0, 360).
 */
export declare function snapRotation(angleDeg: number, thresholdDeg?: number): number;
/**
 * Convert a keyboard arrow event into a {dx, dy} nudge in document px.
 * Shift multiplies by 10 (the "big nudge" convention).
 */
export declare function nudgeDelta(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', shift: boolean): {
    dx: number;
    dy: number;
};
/**
 * Return true when bounds B is entirely contained within marquee A.
 * Partial intersection does NOT select — the marquee must fully enclose.
 */
export declare function marqueeContains(marquee: MarqueeRect, bounds: MarqueeRect): boolean;
/**
 * Return true when grid lines at `gridSize` document px would render at least
 * `minScreenPx` apart at the current zoom. Used to skip grid drawing when
 * zoomed out far enough that lines would clutter.
 */
export declare function gridVisible(gridSize: number, zoom: number, minScreenPx?: number): boolean;
export {};
