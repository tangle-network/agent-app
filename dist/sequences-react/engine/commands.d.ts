/**
 * Concrete `TimelineCommand` factories. Every factory captures the inverse
 * from PRE-state at construction — undo is a value computed once, never a
 * re-derivation from whatever state exists later. Local execute/undo update
 * `EditorTimelineState` immutably; `operations()`/`inverseOperations()` return
 * the durable `SequenceOperation[]` equivalent, built per call from captured
 * primitives so callers can never alias command internals.
 *
 * Id boundary: `place_clip`, `add_caption`, and `split_clip` mint clip ids
 * server-side, so factories that create local clips take a caller-minted id.
 * Every factory also takes an optional `resolveClipId` — a LIVE local→server
 * alias lookup the host feeds from `onApplyOperations` results. Resolution
 * runs at execute/undo/emission time (never at construction), so a command
 * captured against an optimistic `local-…` id keeps working after a server
 * refresh replaced it with the minted id. Residual boundary: clips a durable
 * undo recreates (e.g. the `place_clip` inverse of a delete) mint FRESH
 * server ids that only the next refresh reconciles.
 *
 * Transforms re-resolve their target clip at execute/undo time and throw when
 * it no longer exists (e.g. removed by a `reset()` rebase) — editing a wrong
 * or absent clip silently would corrupt the durable op stream.
 */
import { type SequenceTimeline } from '../../sequences/model';
import type { TimelineCommand } from '../contracts';
/** Live local→server clip-id lookup (see module header). Must return its
 *  argument when no alias exists. */
export type ClipIdResolver = (clipId: string) => string;
/** Define input parameters to move a clip within a timeline including optional track and resolver */
export interface MoveClipInput {
    timeline: SequenceTimeline;
    clipId: string;
    startFrame: number;
    /** Omitted → stays on its current track. */
    trackId?: string;
    resolveClipId?: ClipIdResolver;
}
/** Drag-move. The target start clamps through the model's `clampClipStart`
 *  so drags past either edge land at the boundary instead of throwing
 *  mid-gesture; the emitted operation carries the clamped value. */
export declare function moveClipCommand(input: MoveClipInput): TimelineCommand;
/** Define input parameters for trimming a clip within a sequence timeline */
export interface TrimClipInput {
    timeline: SequenceTimeline;
    clipId: string;
    startFrame: number;
    durationFrames: number;
    /** New source in-point when trimming the head; omitted → unchanged. */
    sourceInFrame?: number;
    resolveClipId?: ClipIdResolver;
}
/** Trim is strict where move is forgiving: the caller (a trim handle) already
 *  knows both edges, so out-of-bounds input is a bug, not a gesture. */
export declare function trimClipCommand(input: TrimClipInput): TimelineCommand;
/** Define input parameters required to place a clip within a sequence timeline */
export interface PlaceClipInput {
    timeline: SequenceTimeline;
    /** Caller-minted optimistic id for the local clip (see module header). */
    clipId: string;
    trackId: string;
    label: string;
    startFrame: number;
    durationFrames: number;
    /** Omitted → 0 (start of the source). */
    sourceInFrame?: number;
    media?: {
        url: string;
        kind: 'video' | 'image' | 'audio';
    };
    generationId?: string;
    assetId?: string;
    metadata?: Record<string, unknown>;
    resolveClipId?: ClipIdResolver;
}
/** Resolve and validate clip placement parameters to create a timeline command */
export declare function placeClipCommand(input: PlaceClipInput): TimelineCommand;
/** Define input parameters required to delete a clip from a sequence timeline */
export interface DeleteClipInput {
    timeline: SequenceTimeline;
    clipId: string;
    resolveClipId?: ClipIdResolver;
}
/** Snapshots the full clip at construction so undo restores it exactly. The
 *  durable inverse rebuilds within the closed operation union: caption clips
 *  (caption track + text) invert through `add_caption` — `place_clip` cannot
 *  carry text/language — everything else through `place_clip` with media,
 *  product references, source window, and disabled state intact. Boundary:
 *  the caption path cannot carry `disabled` or `metadata`, so a deleted
 *  disabled caption resurrects ENABLED server-side and caption metadata is
 *  lost — local undo stays exact (same class of loss as the `set_clip_text`
 *  language-clear boundary). */
export declare function deleteClipCommand(input: DeleteClipInput): TimelineCommand;
/** Define input parameters for splitting a clip at a specific frame within a timeline */
export interface SplitClipInput {
    timeline: SequenceTimeline;
    clipId: string;
    /** Sequence-frame to cut at; must fall strictly inside the clip. */
    atFrame: number;
    /** Caller-minted id for the second (tail) clip. */
    newClipId: string;
    resolveClipId?: ClipIdResolver;
}
/** Source mapping is 1:1 frames (no rate ramps in the model), so the tail's
 *  source in-point is the head's in-point advanced by the head duration. */
export declare function splitClipCommand(input: SplitClipInput): TimelineCommand;
/** Define input parameters for adding a caption clip to a sequence timeline */
export interface AddCaptionInput {
    timeline: SequenceTimeline;
    /** Caller-minted optimistic id for the local caption clip. */
    clipId: string;
    /** Editor commands are concrete: the caller resolves placement (e.g. via
     *  `chooseCaptionPlacement`) and the target track before constructing. */
    trackId: string;
    text: string;
    language?: string;
    startFrame: number;
    durationFrames: number;
    resolveClipId?: ClipIdResolver;
}
/** Resolve a command to add a caption to a specified caption track within a timeline */
export declare function addCaptionCommand(input: AddCaptionInput): TimelineCommand;
/** Define input parameters for setting text and optional language on a specific clip in a timeline */
export interface SetClipTextInput {
    timeline: SequenceTimeline;
    clipId: string;
    text: string;
    /** Omitted → language unchanged. */
    language?: string;
    resolveClipId?: ClipIdResolver;
}
/** Requires the clip to already carry text: `set_clip_text` has no "create"
 *  semantics in the union, and an inverse for a text-less clip would have to
 *  invent an empty string. Boundary: when the clip had NO language and this
 *  command sets one, local undo restores `undefined` exactly but the durable
 *  inverse cannot clear language (the op has no clear form) — flagged to the
 *  apply layer. */
export declare function setClipTextCommand(input: SetClipTextInput): TimelineCommand;
/** Define input parameters to toggle the disabled state of a clip within a timeline */
export interface ToggleClipDisabledInput {
    timeline: SequenceTimeline;
    clipId: string;
    resolveClipId?: ClipIdResolver;
}
/** The target value is captured at construction (not flipped at execute time)
 *  so redo after a rebase applies the same durable op the stack already
 *  emitted. */
export declare function toggleClipDisabledCommand(input: ToggleClipDisabledInput): TimelineCommand;
