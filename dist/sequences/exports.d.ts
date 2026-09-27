/**
 * Pure interchange-format builders over `SequenceTimeline` — SRT, WebVTT,
 * CMX3600 EDL, OpenTimelineIO JSON, and the contact-sheet manifest. mp4
 * rendering needs ffmpeg and stays product-side; everything here is
 * deterministic frame math producing strings or JSON-serializable documents.
 *
 * Builders throw instead of emitting empty documents: an empty subtitle file
 * or zero-event EDL downloads "successfully" and then fails silently inside
 * the user's player or NLE — the worst failure mode for an agent-driven
 * editor. The one exception is OTIO, which meaningfully round-trips sequence
 * settings (fps, dimensions, track structure) even with zero clips.
 *
 * Disabled clips are excluded from every format: an export reflects what
 * renders, and a cue or event for an invisible clip is a lie.
 */
import { type SequenceMediaKind, type SequenceTimeline } from './model';
/** Define options to export captions filtered by an optional BCP-47 language tag */
export interface CaptionExportOptions {
    /** BCP-47 tag; matched case-insensitively against `clip.language`. Clips
     *  with no language never match a language-scoped export. */
    language?: string;
}
/** Numbered SubRip cues from caption-track clips, in timeline order. Throws
 *  when no cue survives filtering — see module doc on empty documents. */
export declare function buildSrt(timeline: SequenceTimeline, opts?: CaptionExportOptions): string;
/** WebVTT with numbered cue identifiers; same filtering and frame math as
 *  `buildSrt`, dot millisecond separator per the VTT grammar. */
export declare function buildVtt(timeline: SequenceTimeline, opts?: CaptionExportOptions): string;
/** CMX3600-style EDL: one event per enabled video/audio clip in record-start
 *  order. Source in/out come from `sourceInFrame` + `durationFrames`; record
 *  in/out from `startFrame`. Timecodes are non-drop `HH:MM:SS:FF` at the
 *  sequence fps. Throws when the timeline has no video/audio clips. */
export declare function buildEdl(timeline: SequenceTimeline): string;
/** Represent a rational time value with a specific rate and numeric value for OTIO schema */
export interface OtioRationalTime {
    OTIO_SCHEMA: 'RationalTime.1';
    rate: number;
    value: number;
}
/** Define a time range with a start time and duration using OtioRationalTime values */
export interface OtioTimeRange {
    OTIO_SCHEMA: 'TimeRange.1';
    start_time: OtioRationalTime;
    duration: OtioRationalTime;
}
/** Define the structure for an external media reference with schema, URL, and optional time range */
export interface OtioExternalReference {
    OTIO_SCHEMA: 'ExternalReference.1';
    target_url: string;
    /** Natural extent of the source media when known; null when unknown. */
    available_range: OtioTimeRange | null;
}
/** Represent missing references in OTIO with a fixed schema identifier */
export interface OtioMissingReference {
    OTIO_SCHEMA: 'MissingReference.1';
}
/** Define the structure for a gap element with schema, name, and source time range properties */
export interface OtioGap {
    OTIO_SCHEMA: 'Gap.1';
    name: string;
    source_range: OtioTimeRange;
}
/** Define a clip object with metadata, source range, and media reference according to OTIO schema */
export interface OtioClip {
    OTIO_SCHEMA: 'Clip.2';
    name: string;
    source_range: OtioTimeRange;
    media_reference: OtioExternalReference | OtioMissingReference;
    metadata: Record<string, unknown>;
}
/** Define a track containing video or audio clips with metadata and child elements */
export interface OtioTrack {
    OTIO_SCHEMA: 'Track.1';
    name: string;
    kind: 'Video' | 'Audio';
    metadata: Record<string, unknown>;
    children: Array<OtioClip | OtioGap>;
}
/** Represent a stack container holding a named collection of OtioTrack children */
export interface OtioStack {
    OTIO_SCHEMA: 'Stack.1';
    name: string;
    children: OtioTrack[];
}
/** Define the structure of a timeline with metadata, tracks, and global start time in OTIO format */
export interface OtioTimeline {
    OTIO_SCHEMA: 'Timeline.1';
    name: string;
    global_start_time: OtioRationalTime;
    metadata: Record<string, unknown>;
    tracks: OtioStack;
}
/**
 * OpenTimelineIO `Timeline.1` document. Serialize with `JSON.stringify` at the
 * file-write edge.
 *
 * OTIO track children are SEQUENTIAL — position comes from accumulated child
 * durations, so timeline gaps become explicit `Gap.1` children and two enabled
 * clips overlapping on one track are unrepresentable (throws). Caption and
 * reference tracks export as `Video` tracks (OTIO has no caption kind) with
 * the original kind preserved in `metadata.sequenceTrackKind`; agent tracks
 * carry decision markers, never media, and are excluded.
 */
export declare function buildOtio(timeline: SequenceTimeline): OtioTimeline;
/** Describe a single entry in a contact sheet with timing and media source details */
export interface ContactSheetEntry {
    clipId: string;
    trackId: string;
    label: string;
    /** Timeline frame the sample represents — the clip midpoint. */
    frame: number;
    /** `m:ss.ff` timecode of `frame`, for human-readable sheet labels. */
    timecode: string;
    /** Source-media frame to extract: `sourceInFrame` + midpoint offset for
     *  video, always 0 for stills (a seek into an image yields nothing). */
    sourceFrame: number;
    sourceSeconds: number;
    url: string;
    mediaKind: SequenceMediaKind;
}
/** Define the structure for a contact sheet manifest including metadata and entries */
export interface ContactSheetManifest {
    sequenceId: string;
    title: string;
    fps: number;
    width: number;
    height: number;
    entries: ContactSheetEntry[];
}
/**
 * One sample frame per enabled video-track clip with resolved, completed
 * media — the product side renders the actual sheet (needs ffmpeg/canvas).
 * Clips whose media is still rendering upstream (`providerStatus` queued/
 * processing/failed) have no extractable frame and are excluded; audio media
 * on a video track likewise. Throws when nothing is sampleable — see module
 * doc on empty documents.
 */
export declare function buildContactSheetManifest(timeline: SequenceTimeline): ContactSheetManifest;
