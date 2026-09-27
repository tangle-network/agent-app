/**
 * Sequences-area story fixtures. Self-contained on purpose: the shared
 * `src/stories/fixtures/` barrel was absent from the working tree when these
 * stories were written, so this file mirrors its `makePlaygroundReelTimeline`
 * and `makeSolidFrameProvider` byte-for-byte behavior (same shapes, same
 * solid-color provider — no media decode, no network) and adds the
 * multi-track, empty, and lookup variants the sequence stories need. If the
 * shared fixtures return, the reel/provider below can be re-pointed at them.
 */
import type { SequenceApplyResult, SequenceClip, SequenceOperation, SequenceTimeline, SequenceTrack } from '../../sequences';
import type { VideoFrameProvider } from '../../sequences-react';
export declare function makePlaygroundReelTimeline(): SequenceTimeline;
export declare function makeStudioCutTimeline(): SequenceTimeline;
export declare function makeEmptyTimeline(): SequenceTimeline;
export declare function makeAudioClip(): SequenceClip;
export declare function trackOf(timeline: SequenceTimeline, trackId: string): SequenceTrack;
export declare function clipsOf(timeline: SequenceTimeline, trackId: string): SequenceClip[];
export declare function clipOf(timeline: SequenceTimeline, clipId: string): SequenceClip;
/**
 * Simplest valid `VideoFrameProvider`: paints a deterministic solid color into
 * the preview rect. `drawFrame` never touches network or <video>/<img>. The
 * color cycles by second so scrubbing is visibly distinct.
 */
export declare function makeSolidFrameProvider(): VideoFrameProvider;
/**
 * Host `onApplyOperations` stand-in: logs the operations and echoes an
 * index-aligned `SequenceApplyResult[]` so the editor's optimistic-id
 * reconciliation has a well-formed reply for any edit (playground pattern).
 */
export declare function makeEchoApply(timeline: SequenceTimeline): (operations: SequenceOperation[]) => Promise<SequenceApplyResult[]>;
