/**
 * Pure pointer-gesture math for the timeline editor. Every drag/trim/scrub
 * gesture quantizes through these functions so the interactive behavior is
 * unit-testable without a DOM. All inputs/outputs are integer frames except
 * pixel deltas and zoom (px per frame), which are the only float-valued edge.
 */
import type { SnapPoint, SnapResult } from '../contracts';
/** Quantize a horizontal pointer delta to whole frames at the current zoom. */
export declare function framesFromPixelDelta(deltaX: number, zoom: number): number;
export interface MoveDragInput {
    originStartFrame: number;
    durationFrames: number;
    deltaFrames: number;
    sequenceDurationFrames: number;
}
/** New start frame for a move drag, clamped so the clip stays fully inside
 *  the sequence. */
export declare function moveDragStartFrame(input: MoveDragInput): number;
export interface TrimStartDragInput {
    originStartFrame: number;
    originDurationFrames: number;
    originSourceInFrame: number;
    deltaFrames: number;
}
export interface TrimStartDragResult {
    startFrame: number;
    durationFrames: number;
    sourceInFrame: number;
}
/**
 * Head trim: the clip END is invariant; start slides between two hard walls —
 * it cannot reveal media before source frame 0 (sourceInFrame >= 0) and cannot
 * pass within MIN_SEQUENCE_CLIP_FRAMES of the end. sourceInFrame shifts by
 * exactly the start delta so the visible content stays anchored.
 */
export declare function trimStartDrag(input: TrimStartDragInput): TrimStartDragResult;
export interface TrimEndDragInput {
    originStartFrame: number;
    originDurationFrames: number;
    sourceInFrame: number;
    deltaFrames: number;
    sequenceDurationFrames: number;
    /** Natural source length in frames when known; bounds how far the tail can
     *  extend. Omit for stills and media of unknown length. */
    sourceDurationFrames?: number;
}
/** Tail trim: start is invariant; duration is bounded below by the minimum
 *  clip length and above by both the sequence end and the remaining source
 *  material past the in-point. */
export declare function trimEndDrag(input: TrimEndDragInput): {
    durationFrames: number;
};
/**
 * Smallest ruler step whose major ticks sit at least `minSpacingPx` apart at
 * the current zoom; past the table it grows in whole minutes so labels never
 * collide at extreme zoom-out.
 */
export declare function selectTickStepSeconds(input: {
    zoom: number;
    fps: number;
    minSpacingPx?: number;
}): number;
export interface LetterboxRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Contain-fit a media aspect inside a container, centered with letterbox or
 *  pillarbox bars. */
export declare function letterboxRect(input: {
    containerWidth: number;
    containerHeight: number;
    mediaWidth: number;
    mediaHeight: number;
}): LetterboxRect;
/** Caption type scales with the rendered frame, floored so captions stay
 *  legible on small previews. */
export declare function captionFontPx(canvasCssHeight: number): number;
/** Pixel geometry for a clip chip; width floors at 2px so 1-frame clips stay
 *  grabbable. */
export declare function clipChipGeometry(input: {
    startFrame: number;
    durationFrames: number;
    zoom: number;
}): {
    left: number;
    width: number;
};
/**
 * A move drag snaps whichever clip edge lands closest to a snap point: the
 * start edge directly, or the end edge re-expressed as a start. An unsnapped
 * candidate passes through unchanged.
 */
export declare function chooseMoveSnap(input: {
    candidateStartFrame: number;
    durationFrames: number;
    startSnap: SnapResult;
    endSnap: SnapResult;
}): {
    startFrame: number;
    point: SnapPoint | null;
};
