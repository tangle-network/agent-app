/**
 * One track: a sticky-left header (name, kind glyph, lock/mute state) and a
 * lane sized in timeline pixels (durationFrames * zoom) carrying a
 * `TimelineClipChip` per clip. The lane advertises itself through
 * `data-lane-track`/`data-lane-kind`/`data-lane-locked` — the geometry chips
 * read for vertical drag retargeting. Clicking empty lane space seeks the
 * playhead.
 */
import type { SequenceClip, SequenceTrack } from '../../sequences/model';
import type { SnapPoint, VideoFrameProvider } from '../contracts';
import type { ClipMoveCommit, ClipTrimCommit } from './TimelineClipChip';
export interface TimelineTrackRowProps {
    track: SequenceTrack;
    clips: SequenceClip[];
    fps: number;
    zoom: number;
    sequenceDurationFrames: number;
    selectedClipIds: ReadonlySet<string>;
    /** The single clip that carries tabIndex 0 (roving tabindex); null seeds the
     *  first chip in the editor as the lone Tab stop. */
    tabbableClipId: string | null;
    canWrite: boolean;
    frameProvider: VideoFrameProvider;
    snapMove(candidate: {
        startFrame: number;
        durationFrames: number;
        clipId: string;
    }): {
        startFrame: number;
        point: SnapPoint | null;
    };
    snapEdge(candidate: {
        frame: number;
        clipId: string;
    }): {
        frame: number;
        point: SnapPoint | null;
    };
    onSnapPointChange(point: SnapPoint | null): void;
    onSelectClip(clipId: string, additive: boolean): void;
    onRequestDeleteClip(clipId: string): void;
    onFocusStepClip(clipId: string, direction: -1 | 1): void;
    onCommitMove(input: ClipMoveCommit): void;
    onCommitTrim(input: ClipTrimCommit): void;
    onCommitText(input: {
        clipId: string;
        text: string;
    }): void;
    onLaneSeek(frame: number): void;
}
export declare function TimelineTrackRow(props: TimelineTrackRowProps): import("react").JSX.Element;
