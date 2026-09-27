/**
 * Adaptive timecode ruler. Tick density follows zoom through
 * `selectTickStepSeconds` (major ticks never closer than ~80px, minor ticks
 * at a fifth of the major step when they'd sit at least 8px apart). Click or
 * drag scrubs: the pointer is captured, every move quantizes to a whole frame,
 * and the frame is committed through `onScrub` (the editor routes it to
 * `PlaybackClock.seek`).
 */
export interface TimelineRulerProps {
    fps: number;
    durationFrames: number;
    /** Pixels per frame. */
    zoom: number;
    onScrub(frame: number): void;
}
export declare function TimelineRuler({ fps, durationFrames, zoom, onScrub }: TimelineRulerProps): import("react").JSX.Element;
