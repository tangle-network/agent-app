/**
 * Sequences fixtures: a video + caption `SequenceTimeline` for the timeline
 * editor, and a dependency-free `VideoFrameProvider` that paints deterministic
 * solid frames — no media decode, no network — so the preview monitor renders
 * something real in stories.
 */
import type { SequenceTimeline } from '../../sequences';
import type { VideoFrameProvider } from '../../sequences-react';
export declare function makePlaygroundReelTimeline(): SequenceTimeline;
/** Prebuilt instance for stories that don't need isolation. */
export declare const playgroundReelTimeline: SequenceTimeline;
/**
 * Simplest valid `VideoFrameProvider`: paints a deterministic solid color into
 * the preview rect. `drawFrame` never touches network or <video>/<img>. The
 * color cycles by second so scrubbing is visibly distinct.
 */
export declare function makeSolidFrameProvider(): VideoFrameProvider;
