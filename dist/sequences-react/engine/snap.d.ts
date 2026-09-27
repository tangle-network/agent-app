/**
 * Drag snapping. Snap points come from the timeline's structure (clip edges,
 * playhead, sequence end); the snap THRESHOLD is measured in screen pixels at
 * the current zoom — what feels "close" is a screen distance, not a frame
 * count — and converts to frames as thresholdPx / zoom.
 */
import type { SequenceTimeline } from '../../sequences/model';
import type { SnapPoint, SnapResult } from '../contracts';
/** Snap point with its owning clip when it came from one, so a drag can
 *  exclude the dragged clip's own edges. Structurally a `SnapPoint`. */
export interface TimelineSnapPoint extends SnapPoint {
    clipId?: string;
}
/** Disabled clips still occupy timeline space visually, so their edges remain
 *  snap targets. */
export declare function collectSnapPoints(timeline: SequenceTimeline, playheadFrame: number): TimelineSnapPoint[];
/** Define options to configure snapping behavior including zoom, threshold, and exclusion criteria */
export interface ApplySnapOptions {
    /** Pixels per frame — converts the pixel threshold into frames. */
    zoom: number;
    /** Screen-distance threshold; 10px matches the editor's hit-slop. */
    thresholdPx?: number;
    /** Return true to remove a point from consideration (e.g. the dragged
     *  clip's own edges via `TimelineSnapPoint.clipId`). */
    exclude?: (point: SnapPoint) => boolean;
}
/** Nearest candidate wins; ties keep the first candidate in `points` order
 *  (sorted by frame from `collectSnapPoints`, so the lower frame). */
export declare function applySnap(frame: number, points: SnapPoint[], opts: ApplySnapOptions): SnapResult;
