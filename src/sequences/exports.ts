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

import {
  formatTimecode,
  framesToSeconds,
  secondsToFrames,
  type SequenceClip,
  type SequenceMediaKind,
  type SequenceTimeline,
  type SequenceTrack,
  type SequenceTrackKind,
} from './model'

// ---------------------------------------------------------------------------
// Captions: SRT / WebVTT
// ---------------------------------------------------------------------------

/** Define options to export captions filtered by an optional BCP-47 language tag */
export interface CaptionExportOptions {
  /** BCP-47 tag; matched case-insensitively against `clip.language`. Clips
   *  with no language never match a language-scoped export. */
  language?: string
}

interface CaptionCue {
  startFrame: number
  endFrame: number
  lines: string[]
}

/** Numbered SubRip cues from caption-track clips, in timeline order. Throws
 *  when no cue survives filtering — see module doc on empty documents. */
export function buildSrt(timeline: SequenceTimeline, opts: CaptionExportOptions = {}): string {
  const fps = timeline.sequence.fps
  const cues = collectCaptionCues(timeline, opts.language)
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${frameToSubtitleTime(cue.startFrame, fps, ',')} --> ${frameToSubtitleTime(cue.endFrame, fps, ',')}`,
    ...cue.lines,
  ].join('\n'))
  return `${blocks.join('\n\n')}\n`
}

/** WebVTT with numbered cue identifiers; same filtering and frame math as
 *  `buildSrt`, dot millisecond separator per the VTT grammar. */
export function buildVtt(timeline: SequenceTimeline, opts: CaptionExportOptions = {}): string {
  const fps = timeline.sequence.fps
  const cues = collectCaptionCues(timeline, opts.language)
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${frameToSubtitleTime(cue.startFrame, fps, '.')} --> ${frameToSubtitleTime(cue.endFrame, fps, '.')}`,
    ...cue.lines,
  ].join('\n'))
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

function collectCaptionCues(timeline: SequenceTimeline, language?: string): CaptionCue[] {
  const captionTracks = timeline.tracks.filter((track) => track.kind === 'caption')
  const sortOrderByTrackId = new Map(captionTracks.map((track) => [track.id, track.sortOrder]))
  const wanted = language?.toLowerCase()

  const cues = timeline.clips
    .filter((clip) =>
      sortOrderByTrackId.has(clip.trackId)
      && !clip.disabled
      && typeof clip.text === 'string'
      && clip.text.trim().length > 0
      && (wanted === undefined || clip.language?.toLowerCase() === wanted))
    .map((clip) => ({
      startFrame: clip.startFrame,
      endFrame: clip.startFrame + clip.durationFrames,
      lines: captionLines(clip.text as string),
    }))
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)

  if (cues.length === 0) {
    const scope = language === undefined ? '' : ` in language '${language}'`
    throw new Error(
      `sequence '${timeline.sequence.title}' has no caption clips with text${scope} — an empty subtitle file would fail silently; add captions${language === undefined ? '' : ' in that language'} first`,
    )
  }
  return cues
}

/** A blank line inside a cue body terminates the cue early in both SRT and
 *  VTT parsers, silently truncating the caption — so internal empty lines are
 *  dropped and line edges trimmed. */
function captionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `HH:MM:SS<sep>mmm` from a frame position. Milliseconds derive from total
 *  frame time in one rounding step so the carry into seconds is exact at any
 *  fps (per-component rounding can emit `,1000`). */
function frameToSubtitleTime(frame: number, fps: number, separator: ',' | '.'): string {
  const totalMs = Math.round(framesToSeconds(frame, fps) * 1000)
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${separator}${String(ms).padStart(3, '0')}`
}

// ---------------------------------------------------------------------------
// CMX3600 EDL
// ---------------------------------------------------------------------------

/** CMX3600-style EDL: one event per enabled video/audio clip in record-start
 *  order. Source in/out come from `sourceInFrame` + `durationFrames`; record
 *  in/out from `startFrame`. Timecodes are non-drop `HH:MM:SS:FF` at the
 *  sequence fps. Throws when the timeline has no video/audio clips. */
export function buildEdl(timeline: SequenceTimeline): string {
  const fps = timeline.sequence.fps
  const events = clipsOnTracks(timeline, ['video', 'audio'])

  if (events.length === 0) {
    throw new Error(
      `sequence '${timeline.sequence.title}' has no enabled video or audio clips — an empty EDL would fail silently in the NLE`,
    )
  }

  const lines = [`TITLE: ${timeline.sequence.title}`, 'FCM: NON-DROP FRAME', '']
  events.forEach(({ track, clip }, index) => {
    const channel = track.kind === 'video' ? 'V' : 'A'
    const sourceIn = frameToEdlTimecode(clip.sourceInFrame, fps)
    const sourceOut = frameToEdlTimecode(clip.sourceInFrame + clip.durationFrames, fps)
    const recordIn = frameToEdlTimecode(clip.startFrame, fps)
    const recordOut = frameToEdlTimecode(clip.startFrame + clip.durationFrames, fps)
    lines.push(`${String(index + 1).padStart(3, '0')}  AX       ${channel}     C        ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`)
    lines.push(`* FROM CLIP NAME: ${clip.label}`)
    if (clip.media) lines.push(`* SOURCE FILE: ${clip.media.url}`)
    lines.push('')
  })
  return lines.join('\n')
}

/** Non-drop `HH:MM:SS:FF`. The frame field widens past two digits only when
 *  the fps demands it (fps > 100), so standard rates stay CMX-conformant. */
function frameToEdlTimecode(frame: number, fps: number): string {
  if (!Number.isInteger(frame) || frame < 0) throw new Error('frames must be a non-negative integer')
  const frameWidth = Math.max(2, String(fps - 1).length)
  const totalSeconds = Math.floor(frame / fps)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${String(frame % fps).padStart(frameWidth, '0')}`
}

// ---------------------------------------------------------------------------
// OpenTimelineIO
// ---------------------------------------------------------------------------

/** Represent a rational time value with a specific rate and numeric value for OTIO schema */
export interface OtioRationalTime {
  OTIO_SCHEMA: 'RationalTime.1'
  rate: number
  value: number
}

/** Define a time range with a start time and duration using OtioRationalTime values */
export interface OtioTimeRange {
  OTIO_SCHEMA: 'TimeRange.1'
  start_time: OtioRationalTime
  duration: OtioRationalTime
}

/** Define the structure for an external media reference with schema, URL, and optional time range */
export interface OtioExternalReference {
  OTIO_SCHEMA: 'ExternalReference.1'
  target_url: string
  /** Natural extent of the source media when known; null when unknown. */
  available_range: OtioTimeRange | null
}

/** Represent missing references in OTIO with a fixed schema identifier */
export interface OtioMissingReference {
  OTIO_SCHEMA: 'MissingReference.1'
}

/** Define the structure for a gap element with schema, name, and source time range properties */
export interface OtioGap {
  OTIO_SCHEMA: 'Gap.1'
  name: string
  source_range: OtioTimeRange
}

/** Define a clip object with metadata, source range, and media reference according to OTIO schema */
export interface OtioClip {
  OTIO_SCHEMA: 'Clip.2'
  name: string
  source_range: OtioTimeRange
  media_reference: OtioExternalReference | OtioMissingReference
  metadata: Record<string, unknown>
}

/** Define a track containing video or audio clips with metadata and child elements */
export interface OtioTrack {
  OTIO_SCHEMA: 'Track.1'
  name: string
  kind: 'Video' | 'Audio'
  metadata: Record<string, unknown>
  children: Array<OtioClip | OtioGap>
}

/** Represent a stack container holding a named collection of OtioTrack children */
export interface OtioStack {
  OTIO_SCHEMA: 'Stack.1'
  name: string
  children: OtioTrack[]
}

/** Define the structure of a timeline with metadata, tracks, and global start time in OTIO format */
export interface OtioTimeline {
  OTIO_SCHEMA: 'Timeline.1'
  name: string
  global_start_time: OtioRationalTime
  metadata: Record<string, unknown>
  tracks: OtioStack
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
export function buildOtio(timeline: SequenceTimeline): OtioTimeline {
  const fps = timeline.sequence.fps
  const tracks = [...timeline.tracks]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((track) => track.kind !== 'agent')

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: timeline.sequence.title,
    global_start_time: rationalTime(0, fps),
    metadata: {
      ...timeline.sequence.metadata,
      sequenceId: timeline.sequence.id,
      fps,
      width: timeline.sequence.width,
      height: timeline.sequence.height,
      aspectRatio: timeline.sequence.aspectRatio,
      durationFrames: timeline.sequence.durationFrames,
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks.map((track) => otioTrack(timeline, track, fps)),
    },
  }
}

function otioTrack(timeline: SequenceTimeline, track: SequenceTrack, fps: number): OtioTrack {
  const clips = timeline.clips
    .filter((clip) => clip.trackId === track.id && !clip.disabled)
    .sort((a, b) => a.startFrame - b.startFrame)

  const children: Array<OtioClip | OtioGap> = []
  let cursorFrame = 0
  for (const clip of clips) {
    if (clip.startFrame < cursorFrame) {
      throw new Error(
        `clip '${clip.label}' (${clip.id}) overlaps the previous clip on track '${track.name}' — OTIO tracks are sequential; move or trim the clip before exporting`,
      )
    }
    if (clip.startFrame > cursorFrame) {
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        name: '',
        source_range: timeRange(0, clip.startFrame - cursorFrame, fps),
      })
    }
    children.push(otioClip(clip, fps))
    cursorFrame = clip.startFrame + clip.durationFrames
  }

  return {
    OTIO_SCHEMA: 'Track.1',
    name: track.name,
    kind: otioTrackKind(track.kind),
    metadata: { ...track.metadata, sequenceTrackKind: track.kind },
    children,
  }
}

function otioClip(clip: SequenceClip, fps: number): OtioClip {
  const metadata: Record<string, unknown> = { ...clip.metadata }
  if (clip.text !== undefined) metadata.text = clip.text
  if (clip.language !== undefined) metadata.language = clip.language
  if (clip.generationId !== undefined) metadata.generationId = clip.generationId
  if (clip.assetId !== undefined) metadata.assetId = clip.assetId

  return {
    OTIO_SCHEMA: 'Clip.2',
    name: clip.label,
    source_range: timeRange(clip.sourceInFrame, clip.durationFrames, fps),
    media_reference: clip.media === undefined
      ? { OTIO_SCHEMA: 'MissingReference.1' }
      : {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: clip.media.url,
          available_range: clip.media.durationSeconds === undefined
            ? null
            : timeRange(0, secondsToFrames(clip.media.durationSeconds, fps), fps),
        },
    metadata,
  }
}

function otioTrackKind(kind: SequenceTrackKind): 'Video' | 'Audio' {
  if (kind === 'agent') throw new Error('agent tracks are excluded from OTIO export')
  return kind === 'audio' ? 'Audio' : 'Video'
}

function rationalTime(value: number, rate: number): OtioRationalTime {
  return { OTIO_SCHEMA: 'RationalTime.1', rate, value }
}

function timeRange(startValue: number, durationValue: number, rate: number): OtioTimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rationalTime(startValue, rate),
    duration: rationalTime(durationValue, rate),
  }
}

// ---------------------------------------------------------------------------
// Contact-sheet manifest
// ---------------------------------------------------------------------------

/** Describe a single entry in a contact sheet with timing and media source details */
export interface ContactSheetEntry {
  clipId: string
  trackId: string
  label: string
  /** Timeline frame the sample represents — the clip midpoint. */
  frame: number
  /** `m:ss.ff` timecode of `frame`, for human-readable sheet labels. */
  timecode: string
  /** Source-media frame to extract: `sourceInFrame` + midpoint offset for
   *  video, always 0 for stills (a seek into an image yields nothing). */
  sourceFrame: number
  sourceSeconds: number
  url: string
  mediaKind: SequenceMediaKind
}

/** Define the structure for a contact sheet manifest including metadata and entries */
export interface ContactSheetManifest {
  sequenceId: string
  title: string
  fps: number
  width: number
  height: number
  entries: ContactSheetEntry[]
}

/**
 * One sample frame per enabled video-track clip with resolved, completed
 * media — the product side renders the actual sheet (needs ffmpeg/canvas).
 * Clips whose media is still rendering upstream (`providerStatus` queued/
 * processing/failed) have no extractable frame and are excluded; audio media
 * on a video track likewise. Throws when nothing is sampleable — see module
 * doc on empty documents.
 */
export function buildContactSheetManifest(timeline: SequenceTimeline): ContactSheetManifest {
  const fps = timeline.sequence.fps
  const entries = clipsOnTracks(timeline, ['video'])
    .flatMap(({ clip }) => {
      const media = clip.media
      if (media === undefined) return []
      if (media.providerStatus !== undefined && media.providerStatus !== 'completed') return []
      if (media.kind === 'audio') return []
      const midpointOffset = Math.floor(clip.durationFrames / 2)
      const frame = clip.startFrame + midpointOffset
      const sourceFrame = media.kind === 'image' ? 0 : clip.sourceInFrame + midpointOffset
      return [{
        clipId: clip.id,
        trackId: clip.trackId,
        label: clip.label,
        frame,
        timecode: formatTimecode(frame, fps),
        sourceFrame,
        sourceSeconds: framesToSeconds(sourceFrame, fps),
        url: media.url,
        mediaKind: media.kind,
      }]
    })

  if (entries.length === 0) {
    throw new Error(
      `sequence '${timeline.sequence.title}' has no sampleable video clips (enabled, media resolved and completed) — a contact sheet would be empty`,
    )
  }

  return {
    sequenceId: timeline.sequence.id,
    title: timeline.sequence.title,
    fps,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    entries,
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Enabled clips on tracks of the given kinds, ordered by record start with
 *  track sort order then clip id as deterministic tie-breakers. */
function clipsOnTracks(
  timeline: SequenceTimeline,
  kinds: readonly SequenceTrackKind[],
): Array<{ track: SequenceTrack; clip: SequenceClip }> {
  const trackById = new Map(
    timeline.tracks.filter((track) => kinds.includes(track.kind)).map((track) => [track.id, track]),
  )
  return timeline.clips
    .filter((clip) => !clip.disabled && trackById.has(clip.trackId))
    .map((clip) => ({ track: trackById.get(clip.trackId) as SequenceTrack, clip }))
    .sort((a, b) =>
      a.clip.startFrame - b.clip.startFrame
      || a.track.sortOrder - b.track.sortOrder
      || a.clip.id.localeCompare(b.clip.id))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
