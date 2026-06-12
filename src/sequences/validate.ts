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

import { assertClipFitsSequence, chooseCaptionPlacement, trackIntervals } from './model'
import type {
  SequenceClip,
  SequenceExportFormat,
  SequenceMediaKind,
  SequenceTimeline,
  SequenceTrack,
  SequenceTrackKind,
  TimelineClipBounds,
} from './model'
import type {
  AddCaptionOperation,
  CreateTrackOperation,
  DeleteClipOperation,
  ExtendSequenceOperation,
  MoveClipOperation,
  PlaceClipOperation,
  QueueExportOperation,
  SequenceOperation,
  SetClipDisabledOperation,
  SetClipTextOperation,
  SplitClipOperation,
  TrimClipOperation,
} from './operations'

/** Editor/agent context an operation is resolved against. `playheadFrame` is
 *  the implicit position for omitted caption placement; never persisted. */
export interface SequenceOperationContext {
  playheadFrame: number
}

/** Runtime membership sets typed as exhaustive Records so adding a model
 *  variant fails compilation here instead of silently passing junk through. */
const TRACK_KINDS: Record<SequenceTrackKind, true> = {
  video: true,
  audio: true,
  caption: true,
  reference: true,
  agent: true,
}

const EXPORT_FORMATS: Record<SequenceExportFormat, true> = {
  mp4: true,
  otio: true,
  xml: true,
  edl: true,
  vtt: true,
  srt: true,
  contact_sheet: true,
}

const MEDIA_KINDS: Record<SequenceMediaKind, true> = {
  video: true,
  image: true,
  audio: true,
}

/** Loose BCP-47 shape — enough to keep junk out of track names and clip rows
 *  without shipping a full registry. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/

export function validateSequenceOperations(
  timeline: SequenceTimeline,
  operations: SequenceOperation[],
  ctx: SequenceOperationContext,
): void {
  assertPlayheadFrame(ctx.playheadFrame)
  operations.forEach((operation, index) => {
    try {
      validateSequenceOperation(timeline, operation, ctx)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`operation ${index + 1} (${operation.type}): ${reason}`)
    }
  })
}

export function validateSequenceOperation(
  timeline: SequenceTimeline,
  operation: SequenceOperation,
  ctx: SequenceOperationContext,
): void {
  switch (operation.type) {
    case 'place_clip':
      return validatePlaceClip(timeline, operation)
    case 'add_caption':
      return validateAddCaption(timeline, operation, ctx)
    case 'move_clip':
      return validateMoveClip(timeline, operation)
    case 'trim_clip':
      return validateTrimClip(timeline, operation)
    case 'split_clip':
      return validateSplitClip(timeline, operation)
    case 'set_clip_text':
      return validateSetClipText(timeline, operation)
    case 'set_clip_disabled':
      return validateSetClipDisabled(timeline, operation)
    case 'delete_clip':
      return validateDeleteClip(timeline, operation)
    case 'create_track':
      return validateCreateTrack(operation)
    case 'extend_sequence':
      return validateExtendSequence(timeline, operation)
    case 'queue_export':
      return validateQueueExport(operation)
    default: {
      // The union is closed at compile time; operations parsed from LLM JSON
      // can still arrive with junk types at runtime.
      const unknown = operation as { type?: unknown }
      throw new Error(`unsupported operation type ${JSON.stringify(unknown.type)}`)
    }
  }
}

export function validatePlaceClip(timeline: SequenceTimeline, operation: PlaceClipOperation): void {
  if (operation.label.trim().length === 0) throw new Error('label must be non-empty')
  if (operation.media) {
    if (!(operation.media.kind in MEDIA_KINDS)) {
      throw new Error(`unsupported media kind ${JSON.stringify(operation.media.kind)}`)
    }
    assertSequenceMediaUrl(operation.media.url)
  }
  if (operation.sourceInFrame !== undefined) assertSourceInFrame(operation.sourceInFrame)
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: operation.durationFrames })
  resolvePlaceClipTrack(timeline, operation)
}

export function validateAddCaption(
  timeline: SequenceTimeline,
  operation: AddCaptionOperation,
  ctx: SequenceOperationContext,
): void {
  if (operation.text.trim().length === 0) throw new Error('text must be non-empty')
  if (operation.language !== undefined) assertLanguageTag(operation.language)
  const target = resolveCaptionTarget(timeline, operation)
  const placement = resolveCaptionPlacement(
    timeline,
    operation,
    ctx,
    target.kind === 'existing' ? target.track.id : null,
  )
  // The auto path clamps inside chooseCaptionPlacement; only explicit
  // placement can land out of bounds.
  if (operation.startFrame !== undefined || operation.durationFrames !== undefined) {
    assertOperationBounds(timeline, placement)
  }
}

export function validateMoveClip(timeline: SequenceTimeline, operation: MoveClipOperation): void {
  const { clip, track } = requireMutableClip(timeline, operation.clipId)
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: clip.durationFrames })
  if (operation.trackId !== undefined) {
    const destination = requireTrack(timeline, operation.trackId)
    assertUnlocked(destination)
    if (destination.kind !== track.kind) {
      throw new Error(`moves a ${track.kind} clip to a ${destination.kind} track (${destination.id})`)
    }
  }
}

export function validateTrimClip(timeline: SequenceTimeline, operation: TrimClipOperation): void {
  requireMutableClip(timeline, operation.clipId)
  if (operation.sourceInFrame !== undefined) assertSourceInFrame(operation.sourceInFrame)
  assertOperationBounds(timeline, { startFrame: operation.startFrame, durationFrames: operation.durationFrames })
}

export function validateSplitClip(timeline: SequenceTimeline, operation: SplitClipOperation): void {
  const { clip } = requireMutableClip(timeline, operation.clipId)
  if (!Number.isInteger(operation.atFrame)) throw new Error('atFrame must be an integer')
  if (clip.durationFrames < 2) {
    throw new Error(`clip ${clip.id} is ${clip.durationFrames} frame(s) long; splitting needs at least 2 frames`)
  }
  const endFrame = clip.startFrame + clip.durationFrames
  if (operation.atFrame <= clip.startFrame || operation.atFrame >= endFrame) {
    throw new Error(
      `atFrame ${operation.atFrame} must fall strictly inside clip ${clip.id} (valid range ${clip.startFrame + 1}..${endFrame - 1})`,
    )
  }
}

export function validateSetClipText(timeline: SequenceTimeline, operation: SetClipTextOperation): void {
  const { track } = requireMutableClip(timeline, operation.clipId)
  if (track.kind !== 'caption') {
    throw new Error(`targets a clip on a ${track.kind} track; text edits apply only to caption clips`)
  }
  if (operation.text.trim().length === 0) {
    throw new Error('text must be non-empty; use delete_clip to remove a caption')
  }
  if (operation.language !== undefined) assertLanguageTag(operation.language)
}

export function validateSetClipDisabled(timeline: SequenceTimeline, operation: SetClipDisabledOperation): void {
  requireMutableClip(timeline, operation.clipId)
}

export function validateDeleteClip(timeline: SequenceTimeline, operation: DeleteClipOperation): void {
  requireMutableClip(timeline, operation.clipId)
}

export function validateCreateTrack(operation: CreateTrackOperation): void {
  if (!(operation.kind in TRACK_KINDS)) throw new Error(`unsupported track kind ${JSON.stringify(operation.kind)}`)
  if (operation.name.trim().length === 0) throw new Error('name must be non-empty')
}

export function validateExtendSequence(timeline: SequenceTimeline, operation: ExtendSequenceOperation): void {
  if (!Number.isInteger(operation.durationFrames) || operation.durationFrames <= 0) {
    throw new Error('durationFrames must be a positive integer')
  }
  const lastEnd = lastClipEndFrame(timeline)
  if (operation.durationFrames < lastEnd) {
    throw new Error(`durationFrames ${operation.durationFrames} is below the last clip end (frame ${lastEnd})`)
  }
}

export function validateQueueExport(operation: QueueExportOperation): void {
  if (!(operation.format in EXPORT_FORMATS)) {
    throw new Error(`unsupported export format ${JSON.stringify(operation.format)}`)
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers — shared with ./apply
// ---------------------------------------------------------------------------

export type CaptionTargetResolution =
  | { kind: 'existing'; track: SequenceTrack }
  | { kind: 'create'; language: string; name: string }

/** Naming convention for auto-created per-language caption tracks. The name
 *  doubles as the recognition rule because `SequenceStore.createTrack` cannot
 *  persist track metadata — matching by `metadata.language` alone would never
 *  find tracks this module created. */
export function captionTrackNameForLanguage(language: string): string {
  return `Captions (${language})`
}

/** Target track for a `place_clip`. Video and image media land on video
 *  tracks, audio media on audio tracks; a `reference` track is valid only when
 *  targeted explicitly. Media-less clips (placeholders, agent markers) need an
 *  explicit trackId because no kind can be inferred. */
export function resolvePlaceClipTrack(timeline: SequenceTimeline, operation: PlaceClipOperation): SequenceTrack {
  const media = operation.media
  if (operation.trackId !== undefined) {
    const track = requireTrack(timeline, operation.trackId)
    assertUnlocked(track)
    if (track.kind === 'caption') {
      throw new Error(`cannot target caption track ${track.id}; use add_caption for caption content`)
    }
    if (media) {
      const primary: SequenceTrackKind = media.kind === 'audio' ? 'audio' : 'video'
      if (track.kind !== primary && track.kind !== 'reference') {
        throw new Error(`media kind ${media.kind} requires a ${primary} or reference track; track ${track.id} is ${track.kind}`)
      }
    }
    return track
  }
  if (!media) throw new Error('requires trackId when media is omitted — the target track kind cannot be inferred')
  const wanted: SequenceTrackKind = media.kind === 'audio' ? 'audio' : 'video'
  const track = tracksBySortOrder(timeline).find((candidate) => candidate.kind === wanted && !candidate.locked)
  if (!track) throw new Error(`requires an unlocked ${wanted} track and the sequence has none`)
  return track
}

/** Target caption track for an `add_caption`. With `language` set and no
 *  matching caption track, resolution returns a `create` instruction the apply
 *  layer turns into a real track — a locked matching track is an error, never
 *  a silent duplicate. */
export function resolveCaptionTarget(timeline: SequenceTimeline, operation: AddCaptionOperation): CaptionTargetResolution {
  if (operation.trackId !== undefined) {
    const track = requireTrack(timeline, operation.trackId)
    if (track.kind !== 'caption') {
      throw new Error(`targets ${track.kind} track ${track.id}; captions require a caption track`)
    }
    assertUnlocked(track)
    return { kind: 'existing', track }
  }
  const captionTracks = tracksBySortOrder(timeline).filter((track) => track.kind === 'caption')
  if (operation.language !== undefined) {
    const language = operation.language
    const matching = captionTracks.filter(
      (track) => track.metadata.language === language || track.name === captionTrackNameForLanguage(language),
    )
    const unlocked = matching.find((track) => !track.locked)
    if (unlocked) return { kind: 'existing', track: unlocked }
    if (matching.length > 0) throw new Error(`caption track for language "${language}" is locked`)
    return { kind: 'create', language, name: captionTrackNameForLanguage(language) }
  }
  const track = captionTracks.find((candidate) => !candidate.locked)
  if (!track) {
    throw new Error('requires an unlocked caption track and the sequence has none; pass language to auto-create one or create_track first')
  }
  return { kind: 'existing', track }
}

/** Caption bounds. Fully omitted placement slides past occupied intervals via
 *  `chooseCaptionPlacement`; a partially explicit placement fills the missing
 *  half deterministically (startFrame ← playhead, durationFrames ← fps*3) and
 *  must pass the caller's bounds check — no collision slide. */
export function resolveCaptionPlacement(
  timeline: SequenceTimeline,
  operation: AddCaptionOperation,
  ctx: SequenceOperationContext,
  targetTrackId: string | null,
): TimelineClipBounds {
  assertPlayheadFrame(ctx.playheadFrame)
  const fps = timeline.sequence.fps
  if (operation.startFrame === undefined && operation.durationFrames === undefined) {
    return chooseCaptionPlacement({
      playheadFrame: ctx.playheadFrame,
      fps,
      sequenceDurationFrames: timeline.sequence.durationFrames,
      occupiedIntervals: targetTrackId === null ? [] : trackIntervals(timeline, targetTrackId),
    })
  }
  return {
    startFrame: operation.startFrame ?? ctx.playheadFrame,
    durationFrames: operation.durationFrames ?? fps * 3,
  }
}

/** Last occupied frame across all clips — the floor for `extend_sequence`. */
export function lastClipEndFrame(timeline: SequenceTimeline): number {
  return timeline.clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0)
}

/** Media references must be provider URLs or app-served paths. Local sandbox
 *  artifacts (file:, data:, /tmp/, /home/) are rejected because they are
 *  unreachable from the product and signal an agent substituting local ffmpeg
 *  output for real provider generation. */
export function assertSequenceMediaUrl(url: string): void {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return
  if (trimmed.startsWith('/api/')) return
  const shown = trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('file:') || lower.startsWith('data:') || lower.startsWith('/tmp/') || lower.startsWith('/home/')) {
    throw new Error(`media url must reference a provider URL or rooted /api/ path, not a local sandbox file (${shown})`)
  }
  throw new Error(`media url must be http(s) or a rooted /api/ path (${shown})`)
}

// ---------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------

function requireClip(timeline: SequenceTimeline, clipId: string): SequenceClip {
  const clip = timeline.clips.find((candidate) => candidate.id === clipId)
  if (!clip) throw new Error(`references unknown clip ${clipId}`)
  return clip
}

function requireTrack(timeline: SequenceTimeline, trackId: string): SequenceTrack {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`references unknown track ${trackId}`)
  return track
}

/** Clip mutations (move, trim, split, text, disable, delete) are writes to the
 *  clip's track, so a locked track rejects them all. */
function requireMutableClip(timeline: SequenceTimeline, clipId: string): { clip: SequenceClip; track: SequenceTrack } {
  const clip = requireClip(timeline, clipId)
  const track = requireTrack(timeline, clip.trackId)
  if (track.locked) throw new Error(`clip ${clip.id} sits on locked track "${track.name}" (${track.id})`)
  return { clip, track }
}

function assertUnlocked(track: SequenceTrack): void {
  if (track.locked) throw new Error(`targets locked track "${track.name}" (${track.id})`)
}

function assertOperationBounds(timeline: SequenceTimeline, bounds: TimelineClipBounds): void {
  assertClipFitsSequence({
    startFrame: bounds.startFrame,
    durationFrames: bounds.durationFrames,
    sequenceDurationFrames: timeline.sequence.durationFrames,
    // The label carries the numbers so the thrown message is actionable
    // without access to the original arguments.
    label: `clip [start=${bounds.startFrame} duration=${bounds.durationFrames}] in a ${timeline.sequence.durationFrames}-frame sequence:`,
  })
}

function assertSourceInFrame(sourceInFrame: number): void {
  if (!Number.isInteger(sourceInFrame) || sourceInFrame < 0) {
    throw new Error('sourceInFrame must be a non-negative integer')
  }
}

function assertLanguageTag(language: string): void {
  if (!LANGUAGE_TAG.test(language)) {
    throw new Error(`language must be a BCP-47-style tag (got ${JSON.stringify(language)})`)
  }
}

function assertPlayheadFrame(playheadFrame: number): void {
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error('playheadFrame must be a non-negative integer')
  }
}

function tracksBySortOrder(timeline: SequenceTimeline): SequenceTrack[] {
  return [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder)
}
