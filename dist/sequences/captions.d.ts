/**
 * Caption planning — pure, server-safe helpers that turn transcripts into
 * frame-typed caption chunks and answer "are captions complete?" per language.
 * No store access, no React, no provider coupling: products feed transcript
 * segments in (from any transcription provider) and get chunk bounds out,
 * ready to become `add_caption` operations.
 *
 * All outputs are integer frames at the sequence fps. Seconds appear only on
 * the transcript-segment inputs, because that is what transcription providers
 * emit; the conversion happens exactly once, here.
 */
import { type SequenceTimeline, type TimelineInterval } from './model';
/** Server twin of `TranscriptionSegment` (../sequences-react/contracts) —
 *  structurally identical so react-side transcription output feeds
 *  `buildCaptionChunks` without mapping. Keep the shapes in lockstep. */
export interface TranscriptSegment {
    text: string;
    startSeconds: number;
    endSeconds: number;
}
/** One caption clip's worth of text with its timeline bounds. */
export interface CaptionChunk {
    text: string;
    startFrame: number;
    durationFrames: number;
}
/** Define options to configure caption chunk size, duration, and frame rate constraints */
export interface BuildCaptionChunksOptions {
    /** Upper bound on words per caption; segments split on word boundaries. */
    maxWordsPerChunk?: number;
    /** Readability floor — chunks shorter than this are extended, never
     *  overlapped: the following chunk's start is pushed forward instead. */
    minDurationSeconds?: number;
    fps: number;
}
/**
 * Split transcript segments into caption chunks. Within each segment, time is
 * apportioned to chunks by word count (a constant words-per-second estimate).
 * Guarantees, across the WHOLE output regardless of segment boundaries:
 *
 * - starts are strictly increasing and chunks never overlap
 * - every chunk lasts at least the min-duration clamp (and at least
 *   `MIN_SEQUENCE_CLIP_FRAMES`)
 * - a chunk may extend past its segment's end by at most the clamp — the cost
 *   of the readability floor on short tails
 *
 * Whitespace-only segments produce no chunks. Segments may arrive unsorted
 * (providers emit per-channel batches); they are ordered by start before
 * chunking so the no-overlap guarantee holds.
 */
export declare function buildCaptionChunks(segments: TranscriptSegment[], opts: BuildCaptionChunksOptions): CaptionChunk[];
/**
 * Normalize a BCP-47 tag to conventional casing: primary subtag lowercase,
 * 4-letter script subtags Title Case, 2-letter region subtags UPPER, all other
 * subtags lowercase. Throws on empty or structurally invalid tags.
 */
export declare function normalizeLanguageTag(tag: string): string;
/** Define options to specify target languages and an optional source language for fan-out operations */
export interface LanguageFanoutOptions {
    languages: string[];
    /** Excluded from the plan (exact normalized match only — 'en' does not
     *  exclude 'en-US'; a regional variant of the source is still a valid
     *  fan-out target). */
    sourceLanguage?: string;
}
/**
 * Plan which caption languages to generate: normalized, deduped (first
 * occurrence wins), source excluded. Throws on an empty request or any
 * invalid tag — a malformed fan-out request must fail before any generation
 * is queued. Returns [] when every requested language IS the source; the
 * caller reports "nothing to fan out" rather than erroring.
 */
export declare function planLanguageFanout(opts: LanguageFanoutOptions): string[];
/** Coverage for one caption language across the sequence. `language` is the
 *  clip's stored tag verbatim (no normalization — coverage reports what is
 *  actually on the timeline); null groups caption clips with no tag. */
export interface CaptionCoverageEntry {
    language: string | null;
    coveredFrames: number;
    totalFrames: number;
    /** Uncovered intervals, ascending; endFrame exclusive. */
    gaps: TimelineInterval[];
}
/**
 * Per-language caption coverage over [0, durationFrames). A frame counts as
 * covered when an enabled, non-empty-text clip on a caption-kind track spans
 * it. Overlapping clips merge (no double counting). Returns one entry per
 * distinct language, null first then lexicographic; [] when the timeline has
 * no caption clips at all.
 */
export declare function captionCoverage(timeline: SequenceTimeline): CaptionCoverageEntry[];
