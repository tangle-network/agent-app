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

/** Define sequence status as one of the specific lifecycle stages draft, active, exporting, or archived */
export type SequenceStatus = 'draft' | 'active' | 'exporting' | 'archived'

/** Define export formats available for sequence data including video, subtitle, and metadata types */
export type SequenceExportFormat = 'mp4' | 'otio' | 'xml' | 'edl' | 'vtt' | 'srt' | 'contact_sheet'

/** Represent export status of a sequence as queued, processing, completed, failed, or cancelled */
export type SequenceExportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** Define media types allowed in a sequence including video, image, and audio */
export type SequenceMediaKind = 'video' | 'image' | 'audio'

/** Describe metadata and properties of a media sequence including dimensions, duration, and status */
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

/** Define properties and state for a sequence track including id, kind, name, order, and flags */
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

/** Define properties for a media sequence clip including timing, source, track, and caption details */
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

/** Describe a record representing the export details and status of a sequence */
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

/** Convert seconds to the nearest whole number of frames based on frames per second */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('seconds must be a non-negative finite number')
  assertFps(fps)
  return Math.round(seconds * fps)
}

/** Convert a frame count to seconds based on the given frames per second rate */
export function framesToSeconds(frames: number, fps: number): number {
  if (!Number.isInteger(frames) || frames < 0) throw new Error('frames must be a non-negative integer')
  assertFps(fps)
  return frames / fps
}

/** Format a number of seconds into a string with integer or two-decimal precision suffix s */
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

/** Define the start frame and duration in frames for a timeline clip's bounds */
export interface TimelineClipBounds {
  startFrame: number
  durationFrames: number
}

/** Define a time range with inclusive start and end frame numbers */
export interface TimelineInterval {
  startFrame: number
  endFrame: number
}

/** Clamp the clip start frame within the valid range of the sequence duration and clip length */
export function clampClipStart(input: {
  startFrame: number
  durationFrames: number
  sequenceDurationFrames: number
}): number {
  assertSequenceDuration(input.sequenceDurationFrames)
  assertClipDuration(input.durationFrames)
  return Math.max(0, Math.min(input.sequenceDurationFrames - input.durationFrames, input.startFrame))
}

/** Clamp clip duration to fit within sequence bounds and minimum length constraints */
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

/** Validate that a clip's start and duration fit within the sequence duration without overflow */
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

/** Place a caption near the playhead inside FREE space only — the caption
 *  track never double-books. Prefers fps*3 frames, floors at fps. The gap
 *  holding (or first after) the playhead wins; with everything ahead occupied
 *  the latest earlier gap is used instead. Throws when no gap can hold the
 *  minimum — the caller must supply explicit bounds or clear space. */
export function chooseCaptionPlacement(input: {
  playheadFrame: number
  fps: number
  sequenceDurationFrames: number
  occupiedIntervals: TimelineInterval[]
}): TimelineClipBounds {
  const preferredDurationFrames = Math.min(input.fps * 3, input.sequenceDurationFrames)
  const minimumDurationFrames = Math.min(input.fps, preferredDurationFrames)
  const occupied = input.occupiedIntervals
    .map((interval) => ({
      startFrame: Math.max(0, interval.startFrame),
      endFrame: Math.min(input.sequenceDurationFrames, interval.endFrame),
    }))
    .filter((interval) => interval.endFrame > interval.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)

  // Merge overlaps so the gap walk sees each free run exactly once.
  const merged: TimelineInterval[] = []
  for (const interval of occupied) {
    const last = merged[merged.length - 1]
    if (last && interval.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, interval.endFrame)
    else merged.push({ ...interval })
  }

  const gaps: TimelineInterval[] = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.startFrame > cursor) gaps.push({ startFrame: cursor, endFrame: interval.startFrame })
    cursor = interval.endFrame
  }
  if (cursor < input.sequenceDurationFrames) gaps.push({ startFrame: cursor, endFrame: input.sequenceDurationFrames })

  const usable = gaps.filter((gap) => gap.endFrame - gap.startFrame >= minimumDurationFrames)
  const latestUsable = usable[usable.length - 1]
  if (latestUsable === undefined) {
    throw new Error(
      `no free gap of at least ${minimumDurationFrames} frames on the caption track — pass explicit startFrame/durationFrames or clear space first`,
    )
  }
  const gap = usable.find((candidate) => candidate.endFrame > input.playheadFrame) ?? latestUsable
  const durationFrames = Math.min(preferredDurationFrames, gap.endFrame - gap.startFrame)
  const startFrame = Math.max(gap.startFrame, Math.min(input.playheadFrame, gap.endFrame - durationFrames))
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
