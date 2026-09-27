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
import type { Bounds, ScenePage } from '../../design-canvas/model';
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
export declare function hitTestPoint(page: ScenePage, x: number, y: number): string | null;
/** Define options to configure marquee selection behavior including containment requirements */
export interface MarqueeSelectOptions {
    /** When true, the element's AABB must be fully inside the marquee; default is
     *  intersection (any overlap selects). */
    requireFullContainment?: boolean;
}
/** Returns the ids of selectable elements on `page` whose AABB intersects (or
 *  is contained by) `rect`. Locked and invisible elements are excluded. */
export declare function marqueeSelect(page: ScenePage, rect: Bounds, opts?: MarqueeSelectOptions): string[];
/** Represent horizontal and vertical displacement values for nudging elements */
export interface NudgeDelta {
    dx: number;
    dy: number;
}
/** Map an arrow key to a document-px delta. `shift` engages the 10× step.
 *  Throws on unknown keys so callers handle only real nudge keys. */
export declare function nudgeDelta(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', shift: boolean): NudgeDelta;
/** Document-px offset applied to duplicated elements so the copy is visually
 *  separated from the original (matching common design-tool convention). */
export declare const DUPLICATE_OFFSET: NudgeDelta;
