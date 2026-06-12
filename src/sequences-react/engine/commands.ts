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
 * The durable inverse of a committed create references that LOCAL id — the
 * host's `onApplyOperations` is the layer that reconciles local ids to server
 * ids (or the store accepts client ids). Purely local undo (uncommitted) is
 * always exact.
 *
 * Transforms re-resolve their target clip at execute/undo time and throw when
 * it no longer exists (e.g. removed by a `reset()` rebase) — editing a wrong
 * or absent clip silently would corrupt the durable op stream.
 */

import {
  assertClipFitsSequence,
  clampClipStart,
  type SequenceClip,
  type SequenceTimeline,
  type SequenceTrack,
} from '../../sequences/model'
import type { EditorTimelineState, TimelineCommand } from '../contracts'

// ---------------------------------------------------------------------------
// Shared lookup + immutable-update helpers
// ---------------------------------------------------------------------------

function requireClip(timeline: SequenceTimeline, clipId: string, context: string): SequenceClip {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId)
  if (!clip) throw new Error(`${context}: clip ${clipId} does not exist in sequence ${timeline.sequence.id}`)
  return clip
}

function requireUnlockedTrack(timeline: SequenceTimeline, trackId: string, context: string): SequenceTrack {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`${context}: track ${trackId} does not exist in sequence ${timeline.sequence.id}`)
  if (track.locked) throw new Error(`${context}: track ${track.name} (${trackId}) is locked`)
  return track
}

function assertNewClipId(timeline: SequenceTimeline, clipId: string, context: string): void {
  if (timeline.clips.some((candidate) => candidate.id === clipId)) {
    throw new Error(`${context}: clip id ${clipId} already exists in sequence ${timeline.sequence.id}`)
  }
}

function patchClip(
  state: EditorTimelineState,
  clipId: string,
  context: string,
  patch: Partial<SequenceClip>,
): EditorTimelineState {
  requireClip(state.timeline, clipId, context)
  return {
    ...state,
    timeline: {
      ...state.timeline,
      clips: state.timeline.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
    },
  }
}

function insertClip(state: EditorTimelineState, clip: SequenceClip, context: string): EditorTimelineState {
  assertNewClipId(state.timeline, clip.id, context)
  return {
    ...state,
    timeline: { ...state.timeline, clips: [...state.timeline.clips, clip] },
  }
}

function removeClip(state: EditorTimelineState, clipId: string, context: string): EditorTimelineState {
  requireClip(state.timeline, clipId, context)
  return {
    ...state,
    timeline: {
      ...state.timeline,
      clips: state.timeline.clips.filter((clip) => clip.id !== clipId),
    },
    selectedClipIds: state.selectedClipIds.filter((id) => id !== clipId),
  }
}

// ---------------------------------------------------------------------------
// move_clip
// ---------------------------------------------------------------------------

export interface MoveClipInput {
  timeline: SequenceTimeline
  clipId: string
  startFrame: number
  /** Omitted → stays on its current track. */
  trackId?: string
}

/** Drag-move. The target start clamps through the model's `clampClipStart`
 *  so drags past either edge land at the boundary instead of throwing
 *  mid-gesture; the emitted operation carries the clamped value. */
export function moveClipCommand(input: MoveClipInput): TimelineCommand {
  const context = 'move_clip'
  const clip = requireClip(input.timeline, input.clipId, context)
  const targetTrackId = input.trackId ?? clip.trackId
  requireUnlockedTrack(input.timeline, targetTrackId, context)
  if (!Number.isInteger(input.startFrame)) throw new Error(`${context}: startFrame must be an integer frame`)
  const targetStart = clampClipStart({
    startFrame: input.startFrame,
    durationFrames: clip.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
  })
  const originalStart = clip.startFrame
  const originalTrackId = clip.trackId
  const trackChanged = targetTrackId !== originalTrackId
  const clipId = input.clipId

  return {
    label: `Move ${clip.label}`,
    execute: (state) => patchClip(state, clipId, context, { startFrame: targetStart, trackId: targetTrackId }),
    undo: (state) => patchClip(state, clipId, context, { startFrame: originalStart, trackId: originalTrackId }),
    operations: () => [
      { type: 'move_clip', clipId, startFrame: targetStart, ...(trackChanged ? { trackId: targetTrackId } : {}) },
    ],
    inverseOperations: () => [
      { type: 'move_clip', clipId, startFrame: originalStart, ...(trackChanged ? { trackId: originalTrackId } : {}) },
    ],
  }
}

// ---------------------------------------------------------------------------
// trim_clip
// ---------------------------------------------------------------------------

export interface TrimClipInput {
  timeline: SequenceTimeline
  clipId: string
  startFrame: number
  durationFrames: number
  /** New source in-point when trimming the head; omitted → unchanged. */
  sourceInFrame?: number
}

/** Trim is strict where move is forgiving: the caller (a trim handle) already
 *  knows both edges, so out-of-bounds input is a bug, not a gesture. */
export function trimClipCommand(input: TrimClipInput): TimelineCommand {
  const context = 'trim_clip'
  const clip = requireClip(input.timeline, input.clipId, context)
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: `${context} ${clip.label}`,
  })
  if (input.sourceInFrame !== undefined && (!Number.isInteger(input.sourceInFrame) || input.sourceInFrame < 0)) {
    throw new Error(`${context}: sourceInFrame must be a non-negative integer`)
  }
  const targetSourceIn = input.sourceInFrame ?? clip.sourceInFrame
  const target = { startFrame: input.startFrame, durationFrames: input.durationFrames, sourceInFrame: targetSourceIn }
  const original = { startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame }
  const clipId = input.clipId

  return {
    label: `Trim ${clip.label}`,
    execute: (state) => patchClip(state, clipId, context, target),
    undo: (state) => patchClip(state, clipId, context, original),
    operations: () => [{ type: 'trim_clip', clipId, ...target }],
    inverseOperations: () => [{ type: 'trim_clip', clipId, ...original }],
  }
}

// ---------------------------------------------------------------------------
// place_clip
// ---------------------------------------------------------------------------

export interface PlaceClipInput {
  timeline: SequenceTimeline
  /** Caller-minted optimistic id for the local clip (see module header). */
  clipId: string
  trackId: string
  label: string
  startFrame: number
  durationFrames: number
  /** Omitted → 0 (start of the source). */
  sourceInFrame?: number
  media?: { url: string; kind: 'video' | 'image' | 'audio' }
  generationId?: string
  assetId?: string
  metadata?: Record<string, unknown>
}

export function placeClipCommand(input: PlaceClipInput): TimelineCommand {
  const context = 'place_clip'
  assertNewClipId(input.timeline, input.clipId, context)
  requireUnlockedTrack(input.timeline, input.trackId, context)
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: `${context} ${input.label}`,
  })
  const sourceInFrame = input.sourceInFrame ?? 0
  if (!Number.isInteger(sourceInFrame) || sourceInFrame < 0) {
    throw new Error(`${context}: sourceInFrame must be a non-negative integer`)
  }
  const clip: SequenceClip = {
    id: input.clipId,
    trackId: input.trackId,
    label: input.label,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sourceInFrame,
    sourceOutFrame: null,
    disabled: false,
    ...(input.media ? { media: { url: input.media.url, kind: input.media.kind } } : {}),
    ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
    ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
    metadata: input.metadata ?? {},
  }
  const clipId = input.clipId

  return {
    label: `Place ${input.label}`,
    execute: (state) => insertClip(state, structuredClone(clip), context),
    undo: (state) => removeClip(state, clipId, context),
    operations: () => [
      {
        type: 'place_clip',
        trackId: clip.trackId,
        label: clip.label,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        sourceInFrame,
        ...(input.media ? { media: { url: input.media.url, kind: input.media.kind } } : {}),
        ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
        ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    ],
    inverseOperations: () => [{ type: 'delete_clip', clipId }],
  }
}

// ---------------------------------------------------------------------------
// delete_clip
// ---------------------------------------------------------------------------

export interface DeleteClipInput {
  timeline: SequenceTimeline
  clipId: string
}

/** Snapshots the full clip at construction so undo restores it exactly. The
 *  durable inverse rebuilds within the closed operation union: caption clips
 *  (caption track + text) invert through `add_caption` — `place_clip` cannot
 *  carry text/language — everything else through `place_clip` with media and
 *  product references intact. */
export function deleteClipCommand(input: DeleteClipInput): TimelineCommand {
  const context = 'delete_clip'
  const snapshot = structuredClone(requireClip(input.timeline, input.clipId, context))
  const track = input.timeline.tracks.find((candidate) => candidate.id === snapshot.trackId)
  if (!track) throw new Error(`${context}: clip ${snapshot.id} references unknown track ${snapshot.trackId}`)
  const captionText =
    track.kind === 'caption' && typeof snapshot.text === 'string' && snapshot.text.length > 0 ? snapshot.text : null
  const clipId = input.clipId

  return {
    label: `Delete ${snapshot.label}`,
    execute: (state) => removeClip(state, clipId, context),
    undo: (state) => insertClip(state, structuredClone(snapshot), context),
    operations: () => [{ type: 'delete_clip', clipId }],
    inverseOperations: () =>
      captionText !== null
        ? [
            {
              type: 'add_caption',
              text: captionText,
              ...(snapshot.language !== undefined ? { language: snapshot.language } : {}),
              startFrame: snapshot.startFrame,
              durationFrames: snapshot.durationFrames,
              trackId: snapshot.trackId,
            },
          ]
        : [
            {
              type: 'place_clip',
              trackId: snapshot.trackId,
              label: snapshot.label,
              startFrame: snapshot.startFrame,
              durationFrames: snapshot.durationFrames,
              sourceInFrame: snapshot.sourceInFrame,
              ...(snapshot.media ? { media: { url: snapshot.media.url, kind: snapshot.media.kind } } : {}),
              ...(snapshot.generationId !== undefined ? { generationId: snapshot.generationId } : {}),
              ...(snapshot.assetId !== undefined ? { assetId: snapshot.assetId } : {}),
              metadata: structuredClone(snapshot.metadata),
            },
          ],
  }
}

// ---------------------------------------------------------------------------
// split_clip
// ---------------------------------------------------------------------------

export interface SplitClipInput {
  timeline: SequenceTimeline
  clipId: string
  /** Sequence-frame to cut at; must fall strictly inside the clip. */
  atFrame: number
  /** Caller-minted id for the second (tail) clip. */
  newClipId: string
}

/** Source mapping is 1:1 frames (no rate ramps in the model), so the tail's
 *  source in-point is the head's in-point advanced by the head duration. */
export function splitClipCommand(input: SplitClipInput): TimelineCommand {
  const context = 'split_clip'
  const original = structuredClone(requireClip(input.timeline, input.clipId, context))
  assertNewClipId(input.timeline, input.newClipId, context)
  if (!Number.isInteger(input.atFrame)) throw new Error(`${context}: atFrame must be an integer frame`)
  const clipEnd = original.startFrame + original.durationFrames
  if (input.atFrame <= original.startFrame || input.atFrame >= clipEnd) {
    throw new Error(
      `${context}: atFrame ${input.atFrame} must fall strictly inside clip ${original.id} [${original.startFrame}, ${clipEnd})`,
    )
  }
  const headDurationFrames = input.atFrame - original.startFrame
  const tailDurationFrames = clipEnd - input.atFrame
  const tail: SequenceClip = {
    ...structuredClone(original),
    id: input.newClipId,
    startFrame: input.atFrame,
    durationFrames: tailDurationFrames,
    sourceInFrame: original.sourceInFrame + headDurationFrames,
  }
  const clipId = input.clipId
  const newClipId = input.newClipId

  return {
    label: `Split ${original.label}`,
    execute: (state) =>
      insertClip(patchClip(state, clipId, context, { durationFrames: headDurationFrames }), structuredClone(tail), context),
    undo: (state) =>
      patchClip(removeClip(state, newClipId, context), clipId, context, structuredClone(original)),
    operations: () => [{ type: 'split_clip', clipId, atFrame: input.atFrame }],
    inverseOperations: () => [
      { type: 'delete_clip', clipId: newClipId },
      {
        type: 'trim_clip',
        clipId,
        startFrame: original.startFrame,
        durationFrames: original.durationFrames,
        sourceInFrame: original.sourceInFrame,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// add_caption
// ---------------------------------------------------------------------------

export interface AddCaptionInput {
  timeline: SequenceTimeline
  /** Caller-minted optimistic id for the local caption clip. */
  clipId: string
  /** Editor commands are concrete: the caller resolves placement (e.g. via
   *  `chooseCaptionPlacement`) and the target track before constructing. */
  trackId: string
  text: string
  language?: string
  startFrame: number
  durationFrames: number
}

export function addCaptionCommand(input: AddCaptionInput): TimelineCommand {
  const context = 'add_caption'
  assertNewClipId(input.timeline, input.clipId, context)
  const track = requireUnlockedTrack(input.timeline, input.trackId, context)
  if (track.kind !== 'caption') {
    throw new Error(`${context}: track ${track.name} (${track.id}) is kind ${track.kind}; captions require a caption track`)
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new Error(`${context}: text must be a non-empty string`)
  }
  assertClipFitsSequence({
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.timeline.sequence.durationFrames,
    label: context,
  })
  const clip: SequenceClip = {
    id: input.clipId,
    trackId: input.trackId,
    label: input.text,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: false,
    text: input.text,
    ...(input.language !== undefined ? { language: input.language } : {}),
    metadata: {},
  }
  const clipId = input.clipId

  return {
    label: `Add caption`,
    execute: (state) => insertClip(state, structuredClone(clip), context),
    undo: (state) => removeClip(state, clipId, context),
    operations: () => [
      {
        type: 'add_caption',
        text: input.text,
        ...(input.language !== undefined ? { language: input.language } : {}),
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        trackId: input.trackId,
      },
    ],
    inverseOperations: () => [{ type: 'delete_clip', clipId }],
  }
}

// ---------------------------------------------------------------------------
// set_clip_text
// ---------------------------------------------------------------------------

export interface SetClipTextInput {
  timeline: SequenceTimeline
  clipId: string
  text: string
  /** Omitted → language unchanged. */
  language?: string
}

/** Requires the clip to already carry text: `set_clip_text` has no "create"
 *  semantics in the union, and an inverse for a text-less clip would have to
 *  invent an empty string. Boundary: when the clip had NO language and this
 *  command sets one, local undo restores `undefined` exactly but the durable
 *  inverse cannot clear language (the op has no clear form) — flagged to the
 *  apply layer. */
export function setClipTextCommand(input: SetClipTextInput): TimelineCommand {
  const context = 'set_clip_text'
  const clip = requireClip(input.timeline, input.clipId, context)
  if (typeof clip.text !== 'string') {
    throw new Error(`${context}: clip ${clip.id} has no text body; create caption text through add_caption`)
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new Error(`${context}: text must be a non-empty string`)
  }
  const originalText = clip.text
  const originalLanguage = clip.language
  const targetLanguage = input.language ?? clip.language
  /** Caption labels mirror their text (see addCaptionCommand); keep the
   *  mirror in sync only when it was in sync to begin with. */
  const mirrorsLabel = clip.label === clip.text
  const clipId = input.clipId

  return {
    label: `Edit caption text`,
    execute: (state) =>
      patchClip(state, clipId, context, {
        text: input.text,
        language: targetLanguage,
        ...(mirrorsLabel ? { label: input.text } : {}),
      }),
    undo: (state) =>
      patchClip(state, clipId, context, {
        text: originalText,
        language: originalLanguage,
        ...(mirrorsLabel ? { label: originalText } : {}),
      }),
    operations: () => [
      { type: 'set_clip_text', clipId, text: input.text, ...(input.language !== undefined ? { language: input.language } : {}) },
    ],
    inverseOperations: () => [
      {
        type: 'set_clip_text',
        clipId,
        text: originalText,
        ...(originalLanguage !== undefined ? { language: originalLanguage } : {}),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// set_clip_disabled (toggle)
// ---------------------------------------------------------------------------

export interface ToggleClipDisabledInput {
  timeline: SequenceTimeline
  clipId: string
}

/** The target value is captured at construction (not flipped at execute time)
 *  so redo after a rebase applies the same durable op the stack already
 *  emitted. */
export function toggleClipDisabledCommand(input: ToggleClipDisabledInput): TimelineCommand {
  const context = 'set_clip_disabled'
  const clip = requireClip(input.timeline, input.clipId, context)
  const original = clip.disabled
  const target = !original
  const clipId = input.clipId

  return {
    label: target ? `Disable ${clip.label}` : `Enable ${clip.label}`,
    execute: (state) => patchClip(state, clipId, context, { disabled: target }),
    undo: (state) => patchClip(state, clipId, context, { disabled: original }),
    operations: () => [{ type: 'set_clip_disabled', clipId, disabled: target }],
    inverseOperations: () => [{ type: 'set_clip_disabled', clipId, disabled: original }],
  }
}
