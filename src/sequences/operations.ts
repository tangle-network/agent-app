/**
 * The sequence operation union — the ONE mutation vocabulary shared by every
 * writer of a timeline: the MCP tool dispatcher (agent edits), the React
 * editor's command stack (human edits, undo/redo), and batch agent plans.
 * Positions are integer frames; the seconds→frames conversion happens at the
 * tool-argument edge (./mcp), never here.
 *
 * Validation lives in ./validate (`validateSequenceOperations`) and runs
 * against a `SequenceTimeline` BEFORE any store write; application lives in
 * ./apply (`applySequenceOperation`) which maps one validated operation to
 * `SequenceStore` calls. Keeping the union closed and frame-typed is what lets
 * undo work: every operation has a computable inverse given the pre-state.
 */

import type { SequenceExportFormat, SequenceTrackKind } from './model'

/** Define an operation to place a media clip with timing, track, and playback options */
export interface PlaceClipOperation {
  type: 'place_clip'
  /** Omitted → first unlocked track matching the media kind. */
  trackId?: string
  label: string
  startFrame: number
  durationFrames: number
  sourceInFrame?: number
  /** Explicit source out-point; null/omitted → natural end of the source.
   *  Carried so the durable inverse of a delete can restore a split clip's
   *  exact playable window. */
  sourceOutFrame?: number | null
  /** Create the clip disabled; omitted → enabled. Carried so the durable
   *  inverse of deleting a disabled clip does not resurrect it visible. */
  disabled?: boolean
  media?: { url: string; kind: 'video' | 'image' | 'audio' }
  generationId?: string
  assetId?: string
  metadata?: Record<string, unknown>
}

/** Add a caption with optional language, timing, and track placement details */
export interface AddCaptionOperation {
  type: 'add_caption'
  text: string
  /** BCP-47 tag; omitted → sequence default language. */
  language?: string
  /** Omitted → placed near the playhead via `chooseCaptionPlacement`. */
  startFrame?: number
  durationFrames?: number
  /** Target caption track; omitted → first unlocked caption track, creating
   *  a per-language track when `language` names one that has none. */
  trackId?: string
}

/** Resolve an operation to move a clip to a new start frame and optional track */
export interface MoveClipOperation {
  type: 'move_clip'
  clipId: string
  startFrame: number
  trackId?: string
}

/** Define an operation to trim a clip by adjusting its start, duration, and optional source in/out points */
export interface TrimClipOperation {
  type: 'trim_clip'
  clipId: string
  startFrame: number
  durationFrames: number
  /** New source in-point when trimming the head; omitted → unchanged. */
  sourceInFrame?: number
  /** New source out-point; null releases it to the source's natural end;
   *  omitted → unchanged. Required when extending a clip whose stored window
   *  (e.g. a split head's cut point) is too short for the new duration, and
   *  by the durable inverse of `split_clip` to restore the original window. */
  sourceOutFrame?: number | null
}

/** Split a clip at a specified frame inside the clip to create two separate segments */
export interface SplitClipOperation {
  type: 'split_clip'
  clipId: string
  /** Sequence-frame to cut at; must fall strictly inside the clip. */
  atFrame: number
}

/** Resolve an operation to set clipboard text with optional language and clip identifier */
export interface SetClipTextOperation {
  type: 'set_clip_text'
  clipId: string
  text: string
  language?: string
}

/** Define an operation to enable or disable a clip by its identifier */
export interface SetClipDisabledOperation {
  type: 'set_clip_disabled'
  clipId: string
  disabled: boolean
}

/** Represent a delete clip operation with a specified clip identifier */
export interface DeleteClipOperation {
  type: 'delete_clip'
  clipId: string
}

/** Define an operation to create a new sequence track with a specified kind and name */
export interface CreateTrackOperation {
  type: 'create_track'
  kind: SequenceTrackKind
  name: string
}

/** Define an operation to extend a sequence by a specified number of frames */
export interface ExtendSequenceOperation {
  type: 'extend_sequence'
  durationFrames: number
}

/** Define the structure for a queue export operation with format and optional metadata */
export interface QueueExportOperation {
  type: 'queue_export'
  format: SequenceExportFormat
  metadata?: Record<string, unknown>
}

/** Represent sequence editing actions for manipulating clips, tracks, captions, and exports */
export type SequenceOperation =
  | PlaceClipOperation
  | AddCaptionOperation
  | MoveClipOperation
  | TrimClipOperation
  | SplitClipOperation
  | SetClipTextOperation
  | SetClipDisabledOperation
  | DeleteClipOperation
  | CreateTrackOperation
  | ExtendSequenceOperation
  | QueueExportOperation

/** A batch of operations with the agent's stated intent — the decision-log
 *  unit for agent edits. */
export interface SequencePlan {
  summary: string
  operations: SequenceOperation[]
}

/** Extract the type of operation from a sequence operation object */
export type SequenceOperationType = SequenceOperation['type']

/** List all valid sequence operation types used in editing workflows */
export const SEQUENCE_OPERATION_TYPES: readonly SequenceOperationType[] = [
  'place_clip',
  'add_caption',
  'move_clip',
  'trim_clip',
  'split_clip',
  'set_clip_text',
  'set_clip_disabled',
  'delete_clip',
  'create_track',
  'extend_sequence',
  'queue_export',
] as const
