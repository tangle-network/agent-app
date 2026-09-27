/**
 * Frame-accurate sequence timeline model — the product-agnostic spine of the
 * sequences surface. A sequence is a fixed-fps, fixed-duration timeline of
 * tracks; clips sit on tracks at integer frame positions with non-destructive
 * source in/out points. Products bind this model to their own storage through
 * `SequenceStore` (./store) and surface it to agents through the MCP toolset
 * (./mcp).
 *
 * All positions and durations are integer FRAMES at the sequence's fps.
 * Seconds appear only at the API edge (agent tools speak seconds; the
 * dispatcher converts exactly once). Nothing here touches a database, the DOM,
 * or React.
 */
export declare const MIN_SEQUENCE_CLIP_FRAMES = 1;
/** Track kinds. `reference` holds non-rendered guide media; `agent` holds the
 *  agent-decision lane rendered as markers, never as media. */
export type SequenceTrackKind = 'video' | 'audio' | 'caption' | 'reference' | 'agent';
/** Define sequence status as one of the specific lifecycle stages draft, active, exporting, or archived */
export type SequenceStatus = 'draft' | 'active' | 'exporting' | 'archived';
/** Define export formats available for sequence data including video, subtitle, and metadata types */
export type SequenceExportFormat = 'mp4' | 'otio' | 'xml' | 'edl' | 'vtt' | 'srt' | 'contact_sheet';
/** Represent export status of a sequence as queued, processing, completed, failed, or cancelled */
export type SequenceExportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
/** Define media types allowed in a sequence including video, image, and audio */
export type SequenceMediaKind = 'video' | 'image' | 'audio';
/** Describe metadata and properties of a media sequence including dimensions, duration, and status */
export interface SequenceMeta {
    id: string;
    title: string;
    fps: number;
    width: number;
    height: number;
    aspectRatio: string;
    durationFrames: number;
    status: SequenceStatus;
    metadata: Record<string, unknown>;
}
/** Define properties and state for a sequence track including id, kind, name, order, and flags */
export interface SequenceTrack {
    id: string;
    kind: SequenceTrackKind;
    name: string;
    sortOrder: number;
    locked: boolean;
    muted: boolean;
    metadata: Record<string, unknown>;
}
/** Resolved playable media behind a clip. The store resolves product-specific
 *  references (generation rows, asset rows) into this shape; the core model
 *  never sees the product's tables. */
export interface SequenceClipMedia {
    url: string;
    kind: SequenceMediaKind;
    /** Natural duration of the source media when known. */
    durationSeconds?: number;
    /** Provider job state for media still rendering upstream. */
    providerStatus?: 'queued' | 'processing' | 'completed' | 'failed';
}
/** Define properties for a media sequence clip including timing, source, track, and caption details */
export interface SequenceClip {
    id: string;
    trackId: string;
    label: string;
    startFrame: number;
    durationFrames: number;
    /** Source-relative in point (frames into the source media). */
    sourceInFrame: number;
    /** Source-relative out point; null = natural end of the source. */
    sourceOutFrame: number | null;
    disabled: boolean;
    /** Caption/text body for clips on caption tracks. */
    text?: string;
    /** BCP-47 language tag for caption clips (e.g. 'en', 'es', 'ja'). */
    language?: string;
    /** Opaque product reference to a generation row, when the clip came from one. */
    generationId?: string;
    /** Opaque product reference to an asset row, when the clip came from one. */
    assetId?: string;
    media?: SequenceClipMedia;
    metadata: Record<string, unknown>;
}
/** One entry in the sequence's decision log — human edits, agent proposals,
 *  agent edits, exports, and notes all land here so the edit history is a
 *  single auditable lane. */
export interface SequenceDecision {
    id: string;
    clipId: string | null;
    kind: 'human_edit' | 'agent_proposal' | 'agent_edit' | 'export' | 'note';
    instruction: string;
    reasoningSummary: string | null;
    accepted: boolean | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
/** Describe a record representing the export details and status of a sequence */
export interface SequenceExportRecord {
    id: string;
    format: SequenceExportFormat;
    status: SequenceExportStatus;
    resultUrl: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
/** The full timeline aggregate — what `get_timeline_state` returns and what
 *  every operation validates against. */
export interface SequenceTimeline {
    sequence: SequenceMeta;
    tracks: SequenceTrack[];
    clips: SequenceClip[];
}
/** What is on screen/audible at a single frame — the answer shape for
 *  "what is happening at 0:34". */
export interface SequenceFrameSnapshot {
    frame: number;
    seconds: number;
    /** Active (enabled, in-range) clips at this frame, with their track. */
    active: Array<{
        track: SequenceTrack;
        clip: SequenceClip;
    }>;
    /** Caption text visible at this frame, in track sort order. */
    captions: Array<{
        text: string;
        language?: string;
        clipId: string;
    }>;
}
/** Convert seconds to the nearest whole number of frames based on frames per second */
export declare function secondsToFrames(seconds: number, fps: number): number;
/** Convert a frame count to seconds based on the given frames per second rate */
export declare function framesToSeconds(frames: number, fps: number): number;
/** Format a number of seconds into a string with integer or two-decimal precision suffix s */
export declare function formatSeconds(seconds: number): string;
/** `m:ss.ff` timecode for UI and agent-readable frame references. */
export declare function formatTimecode(frames: number, fps: number): string;
/** Define the start frame and duration in frames for a timeline clip's bounds */
export interface TimelineClipBounds {
    startFrame: number;
    durationFrames: number;
}
/** Define a time range with inclusive start and end frame numbers */
export interface TimelineInterval {
    startFrame: number;
    endFrame: number;
}
/** Clamp the clip start frame within the valid range of the sequence duration and clip length */
export declare function clampClipStart(input: {
    startFrame: number;
    durationFrames: number;
    sequenceDurationFrames: number;
}): number;
/** Clamp clip duration to fit within sequence bounds and minimum length constraints */
export declare function clampClipDuration(input: {
    startFrame: number;
    durationFrames: number;
    sequenceDurationFrames: number;
}): number;
/** Validate that a clip's start and duration fit within the sequence duration without overflow */
export declare function assertClipFitsSequence(input: {
    startFrame: number;
    durationFrames: number;
    sequenceDurationFrames: number;
    label: string;
}): void;
/** Place a caption near the playhead inside FREE space only — the caption
 *  track never double-books. Prefers fps*3 frames, floors at fps. The gap
 *  holding (or first after) the playhead wins; with everything ahead occupied
 *  the latest earlier gap is used instead. Throws when no gap can hold the
 *  minimum — the caller must supply explicit bounds or clear space. */
export declare function chooseCaptionPlacement(input: {
    playheadFrame: number;
    fps: number;
    sequenceDurationFrames: number;
    occupiedIntervals: TimelineInterval[];
}): TimelineClipBounds;
/** Resolve everything active at one frame — the core of `get_frame_at_time`. */
export declare function snapshotFrame(timeline: SequenceTimeline, frame: number): SequenceFrameSnapshot;
/** Occupied intervals on one track, for placement collision checks. */
export declare function trackIntervals(timeline: SequenceTimeline, trackId: string): TimelineInterval[];
