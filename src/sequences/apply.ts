/**
 * Maps one validated `SequenceOperation` to `SequenceStore` calls and reports
 * what changed. Each call re-validates its single operation against the
 * provided timeline — a dispatcher that skips batch validation still cannot
 * reach the store with an invalid write. The timeline must be the CURRENT
 * state: dispatchers applying a batch refresh it between operations so later
 * operations can reference entities earlier ones created.
 *
 * Split assumes source frames advance 1:1 with sequence frames (the model
 * addresses source in/out points at sequence fps); time-remapped clips are
 * outside this operation vocabulary.
 */

import type { SequenceClip, SequenceExportRecord, SequenceMeta, SequenceTimeline, SequenceTrack } from './model'
import type {
  AddCaptionOperation,
  PlaceClipOperation,
  SequenceOperation,
  SplitClipOperation,
} from './operations'
import type { SequenceClipPatch, SequenceStore } from './store'
import {
  resolveCaptionPlacement,
  resolveCaptionTarget,
  resolvePlaceClipTrack,
  validateSequenceOperation,
} from './validate'
import type { SequenceOperationContext } from './validate'

/**
 * The entity an operation changed, for the MCP layer to serialize back to the
 * agent. Conventions for multi-entity operations:
 * - `split_clip` returns the newly created second half (the first half is the
 *   original clip id with a shortened duration).
 * - `delete_clip` returns the pre-delete clip snapshot.
 */
export type SequenceApplyResult =
  | { kind: 'clip'; clip: SequenceClip }
  | { kind: 'track'; track: SequenceTrack }
  | { kind: 'export'; record: SequenceExportRecord }
  | { kind: 'sequence'; sequence: SequenceMeta }

export async function applySequenceOperation(
  store: SequenceStore,
  timeline: SequenceTimeline,
  op: SequenceOperation,
  ctx: SequenceOperationContext,
): Promise<SequenceApplyResult> {
  validateSequenceOperation(timeline, op, ctx)
  switch (op.type) {
    case 'place_clip':
      return applyPlaceClip(store, timeline, op)
    case 'add_caption':
      return applyAddCaption(store, timeline, op, ctx)
    case 'move_clip': {
      const patch: SequenceClipPatch = { startFrame: op.startFrame }
      if (op.trackId !== undefined) patch.trackId = op.trackId
      return { kind: 'clip', clip: await store.updateClip(op.clipId, patch) }
    }
    case 'trim_clip': {
      const patch: SequenceClipPatch = { startFrame: op.startFrame, durationFrames: op.durationFrames }
      if (op.sourceInFrame !== undefined) patch.sourceInFrame = op.sourceInFrame
      return { kind: 'clip', clip: await store.updateClip(op.clipId, patch) }
    }
    case 'split_clip':
      return applySplitClip(store, timeline, op)
    case 'set_clip_text': {
      const patch: SequenceClipPatch = { text: op.text, label: clipLabelFromText(op.text) }
      if (op.language !== undefined) patch.language = op.language
      return { kind: 'clip', clip: await store.updateClip(op.clipId, patch) }
    }
    case 'set_clip_disabled':
      return { kind: 'clip', clip: await store.updateClip(op.clipId, { disabled: op.disabled }) }
    case 'delete_clip': {
      const snapshot = requireTimelineClip(timeline, op.clipId)
      await store.deleteClip(op.clipId)
      return { kind: 'clip', clip: snapshot }
    }
    case 'create_track':
      return { kind: 'track', track: await store.createTrack({ kind: op.kind, name: op.name }) }
    case 'extend_sequence':
      return { kind: 'sequence', sequence: await store.updateSequenceDuration(op.durationFrames) }
    case 'queue_export':
      return { kind: 'export', record: await store.createExport(op.format, op.metadata) }
  }
}

async function applyPlaceClip(
  store: SequenceStore,
  timeline: SequenceTimeline,
  op: PlaceClipOperation,
): Promise<SequenceApplyResult> {
  const track = resolvePlaceClipTrack(timeline, op)
  // NewSequenceClip carries no first-class media field; the provider URL
  // reference rides in metadata.media for the store to resolve. Stores that
  // resolve media through generationId/assetId can ignore it.
  const metadata = op.media
    ? { ...(op.metadata ?? {}), media: { url: op.media.url, kind: op.media.kind } }
    : op.metadata
  const clip = await store.createClip({
    trackId: track.id,
    label: op.label,
    startFrame: op.startFrame,
    durationFrames: op.durationFrames,
    sourceInFrame: op.sourceInFrame ?? 0,
    ...(op.generationId !== undefined ? { generationId: op.generationId } : {}),
    ...(op.assetId !== undefined ? { assetId: op.assetId } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  })
  return { kind: 'clip', clip }
}

async function applyAddCaption(
  store: SequenceStore,
  timeline: SequenceTimeline,
  op: AddCaptionOperation,
  ctx: SequenceOperationContext,
): Promise<SequenceApplyResult> {
  const target = resolveCaptionTarget(timeline, op)
  const placement = resolveCaptionPlacement(timeline, op, ctx, target.kind === 'existing' ? target.track.id : null)
  const track = target.kind === 'existing'
    ? target.track
    : await store.createTrack({ kind: 'caption', name: target.name })
  const clip = await store.createClip({
    trackId: track.id,
    label: clipLabelFromText(op.text),
    startFrame: placement.startFrame,
    durationFrames: placement.durationFrames,
    sourceInFrame: 0,
    text: op.text,
    ...(op.language !== undefined ? { language: op.language } : {}),
  })
  return { kind: 'clip', clip }
}

async function applySplitClip(
  store: SequenceStore,
  timeline: SequenceTimeline,
  op: SplitClipOperation,
): Promise<SequenceApplyResult> {
  // Snapshot before any write: stores may hand back live row objects, so
  // reading `original` after updateClip would see the shortened first half.
  const original = { ...requireTimelineClip(timeline, op.clipId) }
  const offset = op.atFrame - original.startFrame
  // First half keeps the clip id; its out point becomes explicit at the cut so
  // the playable source range stays exact.
  await store.updateClip(original.id, {
    durationFrames: offset,
    sourceOutFrame: original.sourceInFrame + offset,
  })
  const second = await store.createClip({
    trackId: original.trackId,
    label: original.label,
    startFrame: op.atFrame,
    durationFrames: original.durationFrames - offset,
    sourceInFrame: original.sourceInFrame + offset,
    sourceOutFrame: original.sourceOutFrame,
    ...(original.text !== undefined ? { text: original.text } : {}),
    ...(original.language !== undefined ? { language: original.language } : {}),
    ...(original.generationId !== undefined ? { generationId: original.generationId } : {}),
    ...(original.assetId !== undefined ? { assetId: original.assetId } : {}),
    metadata: original.metadata,
  })
  // NewSequenceClip has no disabled field; a disabled original must not yield
  // an enabled second half.
  const secondFinal = original.disabled ? await store.updateClip(second.id, { disabled: true }) : second
  return { kind: 'clip', clip: secondFinal }
}

function requireTimelineClip(timeline: SequenceTimeline, clipId: string): SequenceClip {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId)
  // Unreachable after validateSequenceOperation; kept loud for callers that
  // hand-roll dispatch.
  if (!clip) throw new Error(`references unknown clip ${clipId}`)
  return clip
}

/** Clip labels mirror caption text, truncated so list UIs stay readable. */
function clipLabelFromText(text: string): string {
  return text.length > 120 ? text.slice(0, 120) : text
}
