/**
 * Program monitor: a canvas letterboxed to the sequence aspect that paints
 * the playhead frame — black base, the topmost enabled video-track clip via
 * `frameProvider.drawFrame`, then caption text bottom-centered on an 80%
 * black backing bar with type scaled to canvas height / 18.
 *
 * Track stacking: tracks composite bottom-up, so among clips active at the
 * frame the one on the HIGHEST sortOrder track covers the rest; muted tracks
 * do not render. Only `video` tracks paint — `reference` tracks are
 * non-rendered guide media (model contract) and are excluded from mp4/EDL/
 * contact-sheet export, so painting them would preview content the program
 * output does not contain. Paints serialize through a latest-wins queue —
 * decode is async, so a slow seek never paints over a newer frame.
 *
 * `sourceSeconds` = (sourceInFrame + playhead offset into the clip) / fps:
 * the model maps source frames 1:1 at sequence fps.
 */
import type { SequenceTimeline } from '../../sequences/model';
import type { PlaybackClock, VideoFrameProvider } from '../contracts';
export interface PreviewCanvasProps {
    timeline: SequenceTimeline;
    clock: PlaybackClock;
    frameProvider: VideoFrameProvider;
    className?: string;
}
export declare function PreviewCanvas({ timeline, clock, frameProvider, className }: PreviewCanvasProps): import("react").JSX.Element;
