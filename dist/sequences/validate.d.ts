/**
 * Pre-write validation for sequence operations. Every rule runs against a
 * `SequenceTimeline` snapshot BEFORE any `SequenceStore` write, so a rejected
 * plan leaves no partial state. Batch errors carry the shape
 * `operation N (type): reason` — precise enough for an LLM planner to repair
 * the offending operation and resubmit.
 *
 * The resolution helpers (`resolvePlaceClipTrack`, `resolveCaptionTarget`,
 * `resolveCaptionPlacement`) are shared with ./apply so validation and
 * application cannot disagree about which track or bounds an operation lands
 * on.
 *
 * Validation is static: a batch is checked against the timeline as given, so
 * an operation may not reference entities created by an earlier operation in
 * the same batch. Dispatchers that chain operations must refresh the timeline
 * between applications and validate per-operation.
 */
import type { SequenceTimeline, SequenceTrack, TimelineClipBounds } from './model';
import type { AddCaptionOperation, CreateTrackOperation, DeleteClipOperation, ExtendSequenceOperation, MoveClipOperation, PlaceClipOperation, QueueExportOperation, SequenceOperation, SetClipDisabledOperation, SetClipTextOperation, SplitClipOperation, TrimClipOperation } from './operations';
/** Editor/agent context an operation is resolved against. `playheadFrame` is
 *  the implicit position for omitted caption placement; never persisted. */
export interface SequenceOperationContext {
    playheadFrame: number;
}
/** Validate each operation in a sequence against the timeline and context, throwing detailed errors on failure */
export declare function validateSequenceOperations(timeline: SequenceTimeline, operations: SequenceOperation[], ctx: SequenceOperationContext): void;
/** Validate a sequence operation against the timeline and context to ensure correctness */
export declare function validateSequenceOperation(timeline: SequenceTimeline, operation: SequenceOperation, ctx: SequenceOperationContext): void;
/** Validate the properties and constraints of a PlaceClipOperation within a SequenceTimeline */
export declare function validatePlaceClip(timeline: SequenceTimeline, operation: PlaceClipOperation): void;
/** Validate the parameters and context of an AddCaptionOperation within a sequence timeline */
export declare function validateAddCaption(timeline: SequenceTimeline, operation: AddCaptionOperation, ctx: SequenceOperationContext): void;
/** Validate that a clip move operation is within bounds and targets a compatible unlocked track */
export declare function validateMoveClip(timeline: SequenceTimeline, operation: MoveClipOperation): void;
/** Validate that a trim clip operation respects timeline bounds and source frame constraints */
export declare function validateTrimClip(timeline: SequenceTimeline, operation: TrimClipOperation): void;
/** Validate that a split operation on a clip is within valid frame boundaries and conditions */
export declare function validateSplitClip(timeline: SequenceTimeline, operation: SplitClipOperation): void;
/** Validate that a SetClipTextOperation targets a caption clip with non-empty text and valid language tag */
export declare function validateSetClipText(timeline: SequenceTimeline, operation: SetClipTextOperation): void;
/** Validate that the clip can be disabled within the given timeline and operation constraints */
export declare function validateSetClipDisabled(timeline: SequenceTimeline, operation: SetClipDisabledOperation): void;
/** Validate that the clip to delete exists and is mutable in the given timeline */
export declare function validateDeleteClip(timeline: SequenceTimeline, operation: DeleteClipOperation): void;
/** Validate that a CreateTrackOperation has a supported kind and a non-empty name */
export declare function validateCreateTrack(operation: CreateTrackOperation): void;
/** Validate that the extend sequence operation has a positive duration and exceeds the last clip end frame */
export declare function validateExtendSequence(timeline: SequenceTimeline, operation: ExtendSequenceOperation): void;
/** Validate that the queue export operation uses a supported export format */
export declare function validateQueueExport(operation: QueueExportOperation): void;
/**
 * Shape-gate untrusted JSON (a product's `onApplyOperations` route body) into
 * `SequenceOperation[]` BEFORE `validateSequenceOperations` sees it. The
 * validator assumes well-typed fields (`label.trim()` on a number is a raw
 * TypeError → 500); this parser turns junk into a thrown Error naming the
 * operation index and field so the route can answer 400 with an actionable
 * reason. Unknown fields are dropped — only vocabulary fields reach the
 * validator and store.
 */
export declare function parseSequenceOperations(input: unknown): SequenceOperation[];
/** Resolve caption target by specifying an existing track or creating a new one with language and name */
export type CaptionTargetResolution = {
    kind: 'existing';
    track: SequenceTrack;
} | {
    kind: 'create';
    language: string;
    name: string;
};
/** Naming convention for auto-created per-language caption tracks. The name
 *  doubles as the recognition rule because `SequenceStore.createTrack` cannot
 *  persist track metadata — matching by `metadata.language` alone would never
 *  find tracks this module created. */
export declare function captionTrackNameForLanguage(language: string): string;
/** Target track for a `place_clip`. Video and image media land on video
 *  tracks, audio media on audio tracks; a `reference` track is valid only when
 *  targeted explicitly. Media-less clips (placeholders, agent markers) need an
 *  explicit trackId because no kind can be inferred. */
export declare function resolvePlaceClipTrack(timeline: SequenceTimeline, operation: PlaceClipOperation): SequenceTrack;
/** Target caption track for an `add_caption`. With `language` set and no
 *  matching caption track, resolution returns a `create` instruction the apply
 *  layer turns into a real track — a locked matching track is an error, never
 *  a silent duplicate. */
export declare function resolveCaptionTarget(timeline: SequenceTimeline, operation: AddCaptionOperation): CaptionTargetResolution;
/** Caption bounds. Fully omitted placement slides past occupied intervals via
 *  `chooseCaptionPlacement`; a partially explicit placement fills the missing
 *  half deterministically (startFrame ← playhead, durationFrames ← fps*3) and
 *  must pass the caller's bounds check — no collision slide. */
export declare function resolveCaptionPlacement(timeline: SequenceTimeline, operation: AddCaptionOperation, ctx: SequenceOperationContext, targetTrackId: string | null): TimelineClipBounds;
/** Last occupied frame across all clips — the floor for `extend_sequence`. */
export declare function lastClipEndFrame(timeline: SequenceTimeline): number;
/** Media references must be provider URLs or app-served paths. Local sandbox
 *  artifacts (file:, data:, /tmp/, /home/) are rejected because they are
 *  unreachable from the product and signal an agent substituting local ffmpeg
 *  output for real provider generation. Delegates to the canonical
 *  `assertMediaUrl` boundary in `../web` — sequences and design-canvas share ONE
 *  rule so the two surfaces cannot drift on what counts as a reachable url. */
export declare function assertSequenceMediaUrl(url: string): void;
