/**
 * One clip on a track lane. Owns the pointer gestures that edit it:
 *
 * - body drag        → move (horizontal frames + vertical retarget onto another
 *                       unlocked track of the same kind)
 * - edge handles     → head/tail trim, clamped to MIN_SEQUENCE_CLIP_FRAMES and
 *                       the source material bounds
 * - double-click     → inline caption text edit (caption clips only)
 *
 * Gesture discipline: pointer capture on gesture start, every move quantizes
 * to whole frames, Escape restores the pre-drag state without emitting, and a
 * completed gesture commits EXACTLY ONCE through the `onCommit*` callbacks —
 * the editor turns that into one command on the stack (one undo step). The
 * chip never writes timeline state itself; until commit it renders a local
 * preview only.
 *
 * Vertical retarget reads lane geometry captured at gesture start (rects of
 * every `[data-lane-track]` under the editor's `[data-timeline-tracks]` root),
 * so the moving chip itself can never occlude the hit test.
 */
import type { SequenceClip, SequenceTrack } from '../../sequences/model';
import type { SnapPoint, VideoFrameProvider } from '../contracts';
export interface ClipMoveCommit {
    clipId: string;
    startFrame: number;
    trackId: string;
}
export interface ClipTrimCommit {
    clipId: string;
    startFrame: number;
    durationFrames: number;
    sourceInFrame: number;
}
export interface TimelineClipChipProps {
    clip: SequenceClip;
    track: SequenceTrack;
    fps: number;
    /** Pixels per frame. */
    zoom: number;
    sequenceDurationFrames: number;
    selected: boolean;
    canWrite: boolean;
    /** Roving-tabindex: exactly one chip per editor carries tabIndex 0 so the
     *  clip set is a single Tab stop; arrows move focus across the others. */
    tabbable: boolean;
    frameProvider: VideoFrameProvider;
    /** Snap a candidate move (both clip edges considered); editor closes over
     *  the engine's snap points. */
    snapMove(candidate: {
        startFrame: number;
        durationFrames: number;
        clipId: string;
    }): {
        startFrame: number;
        point: SnapPoint | null;
    };
    /** Snap a single trim edge. */
    snapEdge(candidate: {
        frame: number;
        clipId: string;
    }): {
        frame: number;
        point: SnapPoint | null;
    };
    onSnapPointChange(point: SnapPoint | null): void;
    onSelect(clipId: string, additive: boolean): void;
    /** Keyboard delete of the focused clip (one command on the stack), routed
     *  through the same locked-track guard as the transport Delete key. */
    onRequestDelete(clipId: string): void;
    /** Move keyboard focus to the previous/next clip in DOM order (roving
     *  tabindex); the editor owns the ordered chip set. */
    onFocusStep(clipId: string, direction: -1 | 1): void;
    onCommitMove(input: ClipMoveCommit): void;
    onCommitTrim(input: ClipTrimCommit): void;
    onCommitText(input: {
        clipId: string;
        text: string;
    }): void;
}
export declare function TimelineClipChip(props: TimelineClipChipProps): import("react").JSX.Element;
