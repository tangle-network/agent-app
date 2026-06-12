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

export const MIN_SEQUENCE_CLIP_FRAMES = 1

/** Track kinds. `reference` holds non-rendered guide media; `agent` holds the
 *  agent-decision lane rendered as markers, never as media. */
export type SequenceTrackKind = 'video' | 'audio' | 'caption' | 'reference' | 'agent'

export type SequenceStatus = 'draft' | 'active' | 'exporting' | 'archived'

export type SequenceExportFormat = 'mp4' | 'otio' | 'xml' | 'edl' | 'vtt' | 'srt' | 'contact_sheet'

export type SequenceExportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

export type SequenceMediaKind = 'video' | 'image' | 'audio'

export interface SequenceMeta {
  id: string
  title: string
  fps: number
  width: number
  height: number
  aspectRatio: string
  durationFrames: number
  status: SequenceStatus
  metadata: Record<string, unknown>
}

export interface SequenceTrack {
  id: string
  kind: SequenceTrackKind
  name: string
  sortOrder: number
  locked: boolean
  muted: boolean
  metadata: Record<string, unknown>
}

/** Resolved playable media behind a clip. The store resolves product-specific
 *  references (generation rows, asset rows) into this shape; the core model
 *  never sees the product's tables. */
export interface SequenceClipMedia {
  url: string
  kind: SequenceMediaKind
  /** Natural duration of the source media when known. */
  durationSeconds?: number
  /** Provider job state for media still rendering upstream. */
  providerStatus?: 'queued' | 'processing' | 'completed' | 'failed'
}

export interface SequenceClip {
  id: string
  trackId: string
  label: string
  startFrame: number
  durationFrames: number
  /** Source-relative in point (frames into the source media). */
  sourceInFrame: number
  /** Source-relative out point; null = natural end of the source. */
  sourceOutFrame: number | null
  disabled: boolean
  /** Caption/text body for clips on caption tracks. */
  text?: string
  /** BCP-47 language tag for caption clips (e.g. 'en', 'es', 'ja'). */
  language?: string
  /** Opaque product reference to a generation row, when the clip came from one. */
  generationId?: string
  /** Opaque product reference to an asset row, when the clip came from one. */
  assetId?: string
  media?: SequenceClipMedia
  metadata: Record<string, unknown>
}

/** One entry in the sequence's decision log — human edits, agent proposals,
 *  agent edits, exports, and notes all land here so the edit history is a
 *  single auditable lane. */
export interface SequenceDecision {
  id: string
  clipId: string | null
  kind: 'human_edit' | 'agent_proposal' | 'agent_edit' | 'export' | 'note'
  instruction: string
  reasoningSummary: string | null
  accepted: boolean | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface SequenceExportRecord {
  id: string
  format: SequenceExportFormat
  status: SequenceExportStatus
  resultUrl: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

/** The full timeline aggregate — what `get_timeline_state` returns and what
 *  every operation validates against. */
export interface SequenceTimeline {
  sequence: SequenceMeta
  tracks: SequenceTrack[]
  clips: SequenceClip[]
}

/** What is on screen/audible at a single frame — the answer shape for
 *  "what is happening at 0:34". */
export interface SequenceFrameSnapshot {
  frame: number
  seconds: number
  /** Active (enabled, in-range) clips at this frame, with their track. */
  active: Array<{ track: SequenceTrack; clip: SequenceClip }>
  /** Caption text visible at this frame, in track sort order. */
  captions: Array<{ text: string; language?: string; clipId: string }>
}

// ---------------------------------------------------------------------------
// Frame math
// ---------------------------------------------------------------------------

export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('seconds must be a non-negative finite number')
  assertFps(fps)
  return Math.round(seconds * fps)
}

export function framesToSeconds(frames: number, fps: number): number {
  if (!Number.isInteger(frames) || frames < 0) throw new Error('frames must be a non-negative integer')
  assertFps(fps)
  return frames / fps
}

export function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(2)}s`
}

/** `m:ss.ff` timecode for UI and agent-readable frame references. */
export function formatTimecode(frames: number, fps: number): string {
  assertFps(fps)
  if (!Number.isInteger(frames) || frames < 0) throw new Error('frames must be a non-negative integer')
  const totalSeconds = Math.floor(frames / fps)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const residualFrames = frames % fps
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(residualFrames).padStart(2, '0')}`
}

export interface TimelineClipBounds {
  startFrame: number
  durationFrames: number
}

export interface TimelineInterval {
  startFrame: number
  endFrame: number
}

export function clampClipStart(input: {
  startFrame: number
  durationFrames: number
  sequenceDurationFrames: number
}): number {
  assertSequenceDuration(input.sequenceDurationFrames)
  assertClipDuration(input.durationFrames)
  return Math.max(0, Math.min(input.sequenceDurationFrames - input.durationFrames, input.startFrame))
}

export function clampClipDuration(input: {
  startFrame: number
  durationFrames: number
  sequenceDurationFrames: number
}): number {
  assertSequenceDuration(input.sequenceDurationFrames)
  if (input.startFrame < 0 || input.startFrame >= input.sequenceDurationFrames) {
    throw new Error('startFrame must be inside the sequence')
  }
  return Math.max(MIN_SEQUENCE_CLIP_FRAMES, Math.min(input.durationFrames, input.sequenceDurationFrames - input.startFrame))
}

export function assertClipFitsSequence(input: {
  startFrame: number
  durationFrames: number
  sequenceDurationFrames: number
  label: string
}): void {
  assertSequenceDuration(input.sequenceDurationFrames)
  assertClipDuration(input.durationFrames)
  if (!Number.isInteger(input.startFrame) || input.startFrame < 0) {
    throw new Error(`${input.label} startFrame must be a non-negative integer`)
  }
  if (input.startFrame + input.durationFrames > input.sequenceDurationFrames) {
    throw new Error(`${input.label} extends beyond the sequence duration`)
  }
}

/** Place a caption near the playhead, sliding past occupied intervals so the
 *  caption track never double-books. Prefers fps*3 frames, floors at fps. */
export function chooseCaptionPlacement(input: {
  playheadFrame: number
  fps: number
  sequenceDurationFrames: number
  occupiedIntervals: TimelineInterval[]
}): TimelineClipBounds {
  const preferredDurationFrames = Math.min(input.fps * 3, input.sequenceDurationFrames)
  const minimumDurationFrames = Math.min(input.fps, preferredDurationFrames)
  const intervals = input.occupiedIntervals
    .map((interval) => ({
      startFrame: Math.max(0, interval.startFrame),
      endFrame: Math.min(input.sequenceDurationFrames, interval.endFrame),
    }))
    .filter((interval) => interval.endFrame > interval.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)

  let startFrame = Math.max(0, Math.min(input.playheadFrame, Math.max(0, input.sequenceDurationFrames - minimumDurationFrames)))
  let durationFrames = preferredDurationFrames
  for (const interval of intervals) {
    if (interval.endFrame <= startFrame) continue
    const availableBeforeInterval = interval.startFrame - startFrame
    if (availableBeforeInterval >= minimumDurationFrames) {
      durationFrames = Math.min(preferredDurationFrames, availableBeforeInterval)
      break
    }
    if (interval.startFrame < startFrame + minimumDurationFrames) startFrame = interval.endFrame
  }

  const remainingFrames = input.sequenceDurationFrames - startFrame
  if (remainingFrames < minimumDurationFrames) {
    startFrame = Math.max(0, input.sequenceDurationFrames - minimumDurationFrames)
    durationFrames = minimumDurationFrames
  } else {
    durationFrames = Math.min(durationFrames, remainingFrames)
  }

  return { startFrame, durationFrames }
}

/** Resolve everything active at one frame — the core of `get_frame_at_time`. */
export function snapshotFrame(timeline: SequenceTimeline, frame: number): SequenceFrameSnapshot {
  if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer')
  if (frame >= timeline.sequence.durationFrames) {
    throw new Error(`frame ${frame} is beyond the sequence (${timeline.sequence.durationFrames} frames)`)
  }
  const trackById = new Map(timeline.tracks.map((track) => [track.id, track]))
  const sortedTracks = [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder)
  const trackOrder = new Map(sortedTracks.map((track, index) => [track.id, index]))

  const active = timeline.clips
    .filter((clip) => !clip.disabled && clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames)
    .map((clip) => {
      const track = trackById.get(clip.trackId)
      if (!track) throw new Error(`clip ${clip.id} references unknown track ${clip.trackId}`)
      return { track, clip }
    })
    .sort((a, b) => (trackOrder.get(a.track.id) ?? 0) - (trackOrder.get(b.track.id) ?? 0))

  const captions = active
    .filter(({ track, clip }) => track.kind === 'caption' && typeof clip.text === 'string' && clip.text.length > 0)
    .map(({ clip }) => ({ text: clip.text as string, language: clip.language, clipId: clip.id }))

  return {
    frame,
    seconds: framesToSeconds(frame, timeline.sequence.fps),
    active,
    captions,
  }
}

/** Occupied intervals on one track, for placement collision checks. */
export function trackIntervals(timeline: SequenceTimeline, trackId: string): TimelineInterval[] {
  return timeline.clips
    .filter((clip) => clip.trackId === trackId && !clip.disabled)
    .map((clip) => ({ startFrame: clip.startFrame, endFrame: clip.startFrame + clip.durationFrames }))
    .sort((a, b) => a.startFrame - b.startFrame)
}

function assertFps(fps: number): void {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('fps must be a positive integer')
}

function assertSequenceDuration(sequenceDurationFrames: number): void {
  if (!Number.isInteger(sequenceDurationFrames) || sequenceDurationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error('sequenceDurationFrames must be a positive integer')
  }
}

function assertClipDuration(durationFrames: number): void {
  if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error('durationFrames must be a positive integer')
  }
}
