/**
 * The sequences MCP tool registry — what the in-sandbox agent sees over the
 * live agent→timeline channel. Each entry carries an LLM-facing description,
 * a JSON Schema for the arguments, and the typed dispatch that converts
 * seconds→frames exactly once, validates the resulting operations, applies
 * them through the store, and records ONE decision row per mutating call.
 *
 * Tool arguments speak SECONDS (the unit an LLM reasons in); everything past
 * this edge is integer frames at the sequence fps. Results come back in
 * snake_case with both seconds and `m:ss.ff` timecodes so the model can quote
 * positions back to the user without doing frame math.
 *
 * Every mutation funnels through the ./validate + ./apply kernel: the WHOLE
 * operation batch validates against pre-state before the first write. Errors
 * thrown anywhere in a tool run (argument shape, validation, store) carry the
 * precise reason — the handler surfaces them verbatim as `isError` tool
 * results the model can act on.
 */

import {
  MIN_SEQUENCE_CLIP_FRAMES,
  formatSeconds,
  formatTimecode,
  framesToSeconds,
  secondsToFrames,
  snapshotFrame,
} from './model'
import type {
  SequenceClip,
  SequenceDecision,
  SequenceExportFormat,
  SequenceExportRecord,
  SequenceMediaKind,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
  SequenceTrackKind,
} from './model'
import type { SequenceOperation } from './operations'
import type { SequenceStore } from './store'
import { validateSequenceOperations } from './validate'
import type { SequenceOperationContext } from './validate'
import { applySequenceOperation } from './apply'
import type { SequenceApplyResult } from './apply'

/** Everything one tool invocation needs. Constructed per request by the
 *  handler — the store is already scoped + authorized by the product. The
 *  playhead is server-set (never a tool argument) so auto-placed captions
 *  anchor to what the user is actually looking at. */
export interface SequenceMcpToolEnv {
  store: SequenceStore
  playheadFrame: number
}

export interface SequenceMcpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, env: SequenceMcpToolEnv): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Enumerations (value-level twins of the model's type unions)
// ---------------------------------------------------------------------------

export const SEQUENCE_EXPORT_FORMATS = ['mp4', 'otio', 'xml', 'edl', 'vtt', 'srt', 'contact_sheet'] as const satisfies readonly SequenceExportFormat[]

export const SEQUENCE_TRACK_KINDS = ['video', 'audio', 'caption', 'reference', 'agent'] as const satisfies readonly SequenceTrackKind[]

export const SEQUENCE_MEDIA_KINDS = ['video', 'image', 'audio'] as const satisfies readonly SequenceMediaKind[]

/** Largest accepted `add_captions` batch — bounds one decision row / one
 *  validation pass to a size the store can absorb in a single request. */
export const MAX_CAPTION_BATCH = 500

const MAX_INSTRUCTION_ARG_CHARS = 400

// ---------------------------------------------------------------------------
// Argument readers — fail loud with the argument name and expected unit
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when provided`)
  }
  return value
}

function requireSeconds(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative number of seconds`)
  }
  return value
}

function optionalSeconds(args: Record<string, unknown>, name: string): number | undefined {
  if (args[name] === undefined || args[name] === null) return undefined
  return requireSeconds(args, name)
}

function requireBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name]
  if (typeof value !== 'boolean') throw new Error(`${name} is required and must be true or false`)
  return value
}

function optionalPositiveInteger(args: Record<string, unknown>, name: string, max: number): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}

function requireEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T {
  const value = args[name]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function optionalEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T | undefined {
  if (args[name] === undefined || args[name] === null) return undefined
  return requireEnum(args, name, values)
}

/** Seconds→frames for a duration argument: rejects values that round below the
 *  minimum so the model learns the frame floor instead of hitting a deeper
 *  validation error. */
function durationArgToFrames(seconds: number, name: string, fps: number): number {
  const frames = secondsToFrames(seconds, fps)
  if (frames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error(`${name} (${formatSeconds(seconds)}) is shorter than ${MIN_SEQUENCE_CLIP_FRAMES} frame at ${fps} fps — minimum is ${formatSeconds(MIN_SEQUENCE_CLIP_FRAMES / fps)}`)
  }
  return frames
}

// ---------------------------------------------------------------------------
// Wire views — snake_case, seconds + timecodes alongside raw frames
// ---------------------------------------------------------------------------

function clipView(clip: SequenceClip, fps: number): Record<string, unknown> {
  const endFrame = clip.startFrame + clip.durationFrames
  return {
    id: clip.id,
    track_id: clip.trackId,
    label: clip.label,
    start_seconds: framesToSeconds(clip.startFrame, fps),
    duration_seconds: framesToSeconds(clip.durationFrames, fps),
    end_seconds: framesToSeconds(endFrame, fps),
    start_timecode: formatTimecode(clip.startFrame, fps),
    end_timecode: formatTimecode(endFrame, fps),
    start_frame: clip.startFrame,
    duration_frames: clip.durationFrames,
    source_in_frame: clip.sourceInFrame,
    source_out_frame: clip.sourceOutFrame,
    disabled: clip.disabled,
    ...(clip.text !== undefined ? { text: clip.text } : {}),
    ...(clip.language !== undefined ? { language: clip.language } : {}),
    ...(clip.generationId !== undefined ? { generation_id: clip.generationId } : {}),
    ...(clip.assetId !== undefined ? { asset_id: clip.assetId } : {}),
    ...(clip.media
      ? {
          media: {
            url: clip.media.url,
            kind: clip.media.kind,
            ...(clip.media.durationSeconds !== undefined ? { duration_seconds: clip.media.durationSeconds } : {}),
            ...(clip.media.providerStatus !== undefined ? { provider_status: clip.media.providerStatus } : {}),
          },
        }
      : {}),
  }
}

function trackView(track: SequenceTrack): Record<string, unknown> {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name,
    sort_order: track.sortOrder,
    locked: track.locked,
    muted: track.muted,
  }
}

function sequenceView(sequence: SequenceMeta): Record<string, unknown> {
  return {
    id: sequence.id,
    title: sequence.title,
    fps: sequence.fps,
    width: sequence.width,
    height: sequence.height,
    aspect_ratio: sequence.aspectRatio,
    status: sequence.status,
    duration_frames: sequence.durationFrames,
    duration_seconds: framesToSeconds(sequence.durationFrames, sequence.fps),
    duration_timecode: formatTimecode(sequence.durationFrames, sequence.fps),
  }
}

function exportView(record: SequenceExportRecord): Record<string, unknown> {
  return {
    id: record.id,
    format: record.format,
    status: record.status,
    result_url: record.resultUrl,
    created_at: record.createdAt.toISOString(),
  }
}

function decisionView(decision: SequenceDecision): Record<string, unknown> {
  return {
    id: decision.id,
    clip_id: decision.clipId,
    kind: decision.kind,
    instruction: decision.instruction,
    reasoning_summary: decision.reasoningSummary,
    accepted: decision.accepted,
    created_at: decision.createdAt.toISOString(),
  }
}

function timelineView(timeline: SequenceTimeline, playheadFrame: number): Record<string, unknown> {
  const fps = timeline.sequence.fps
  return {
    sequence: sequenceView(timeline.sequence),
    playhead: {
      frame: playheadFrame,
      seconds: framesToSeconds(playheadFrame, fps),
      timecode: formatTimecode(playheadFrame, fps),
    },
    tracks: [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder).map(trackView),
    clips: [...timeline.clips].sort((a, b) => a.startFrame - b.startFrame).map((clip) => clipView(clip, fps)),
  }
}

function applyResultView(result: SequenceApplyResult, fps: number): Record<string, unknown> {
  switch (result.kind) {
    case 'clip':
      return { kind: 'clip', clip: clipView(result.clip, fps) }
    case 'track':
      return { kind: 'track', track: trackView(result.track) }
    case 'export':
      return { kind: 'export', export: exportView(result.record) }
    case 'sequence':
      return { kind: 'sequence', sequence: sequenceView(result.sequence) }
  }
}

// ---------------------------------------------------------------------------
// Mutation pipeline — validate the whole batch, apply in order, ONE decision
// ---------------------------------------------------------------------------

function instructionSummary(toolName: string, args: Record<string, unknown>): string {
  const body = JSON.stringify(args)
  const clipped = body.length > MAX_INSTRUCTION_ARG_CHARS ? `${body.slice(0, MAX_INSTRUCTION_ARG_CHARS - 3)}...` : body
  return `${toolName} ${clipped}`
}

interface MutationBuild {
  operations: SequenceOperation[]
  /** Decision-row clip attribution. Omit for non-clip-targeted edits; never
   *  set for `delete_clip` (the row must not reference a removed clip). */
  clipId?: string
}

/**
 * The single mutation path every editing tool funnels through: fetch the
 * timeline (the fps source for the one seconds→frames conversion), build the
 * frame-typed operations, validate the WHOLE batch against pre-state, apply
 * sequentially with a timeline refresh between operations (later operations in
 * a batch must see earlier writes), then record exactly one decision row. Any
 * throw before the first apply leaves the sequence untouched.
 */
async function runMutation(
  toolName: string,
  args: Record<string, unknown>,
  env: SequenceMcpToolEnv,
  build: (timeline: SequenceTimeline) => MutationBuild,
): Promise<Record<string, unknown>> {
  const timeline = await env.store.getTimeline()
  const fps = timeline.sequence.fps
  const { operations, clipId } = build(timeline)
  const context: SequenceOperationContext = { playheadFrame: env.playheadFrame }

  validateSequenceOperations(timeline, operations, context)

  const results: SequenceApplyResult[] = []
  let current = timeline
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index] as SequenceOperation
    results.push(await applySequenceOperation(env.store, current, operation, context))
    if (index < operations.length - 1) current = await env.store.getTimeline()
  }

  const decision = await env.store.recordDecision({
    clipId: clipId ?? null,
    kind: 'agent_edit',
    instruction: instructionSummary(toolName, args),
    metadata: { tool: toolName, operation_count: operations.length },
  })

  return {
    changed: results.map((result) => applyResultView(result, fps)),
    decision_id: decision.id,
  }
}

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------

function secondsSchema(description: string): Record<string, unknown> {
  return { type: 'number', minimum: 0, description }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const CLIP_ID_SCHEMA = { type: 'string', description: 'Clip id from get_timeline_state or get_clip' }

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const SEQUENCE_MCP_TOOLS: readonly SequenceMcpToolDefinition[] = [
  {
    name: 'get_timeline_state',
    description:
      'Read the full timeline: sequence settings (fps, duration), playhead, all tracks, and all clips with positions in seconds and m:ss.ff timecodes plus media URLs and provider status. Call this before editing to get real clip and track ids.',
    inputSchema: objectSchema({}, []),
    run: async (_args, env) => {
      const timeline = await env.store.getTimeline()
      return timelineView(timeline, env.playheadFrame)
    },
  },
  {
    name: 'get_frame_at_time',
    description:
      'What is on screen and audible at one moment. seconds is sequence time (e.g. 12.5). Returns the active clips, visible caption text, and a one-line human-readable summary.',
    inputSchema: objectSchema({ seconds: secondsSchema('Sequence time in seconds') }, ['seconds']),
    run: async (args, env) => {
      const timeline = await env.store.getTimeline()
      const fps = timeline.sequence.fps
      const frame = secondsToFrames(requireSeconds(args, 'seconds'), fps)
      const snapshot = snapshotFrame(timeline, frame)
      const activeParts = snapshot.active.map(({ track, clip }) => {
        const range = `${formatTimecode(clip.startFrame, fps)}-${formatTimecode(clip.startFrame + clip.durationFrames, fps)}`
        return `${track.kind} "${clip.label}" (${range})`
      })
      const captionParts = snapshot.captions.map((caption) => `"${caption.text}"`)
      const summary =
        `At ${formatTimecode(frame, fps)} (${formatSeconds(snapshot.seconds)}): ` +
        (activeParts.length > 0 ? activeParts.join('; ') : 'nothing active') +
        (captionParts.length > 0 ? `. Captions: ${captionParts.join(', ')}` : '')
      return {
        frame: snapshot.frame,
        seconds: snapshot.seconds,
        timecode: formatTimecode(frame, fps),
        summary,
        active: snapshot.active.map(({ track, clip }) => ({ track: trackView(track), clip: clipView(clip, fps) })),
        captions: snapshot.captions.map((caption) => ({
          text: caption.text,
          ...(caption.language !== undefined ? { language: caption.language } : {}),
          clip_id: caption.clipId,
        })),
      }
    },
  },
  {
    name: 'get_clip',
    description: 'Read one clip by id, including its position (seconds + timecode), source in/out points, text, and media/provider status.',
    inputSchema: objectSchema({ clip_id: CLIP_ID_SCHEMA }, ['clip_id']),
    run: async (args, env) => {
      const clip = await env.store.getClip(requireString(args, 'clip_id'))
      const timeline = await env.store.getTimeline()
      return clipView(clip, timeline.sequence.fps)
    },
  },
  {
    name: 'place_clip',
    description:
      'Place a new clip on the timeline. Requires label, start_seconds, duration_seconds. Bind playable media with media_url + media_kind (must come together), or reference product media via generation_id / asset_id. track_id targets a specific track; omit it to use the first unlocked track matching the media kind.',
    inputSchema: objectSchema(
      {
        label: { type: 'string', description: 'Short human-readable clip name' },
        start_seconds: secondsSchema('Where the clip starts on the timeline, in seconds'),
        duration_seconds: secondsSchema('Clip length in seconds (at least one frame)'),
        media_url: { type: 'string', description: 'Playable media URL; requires media_kind' },
        media_kind: { type: 'string', enum: [...SEQUENCE_MEDIA_KINDS], description: 'Kind of the media behind media_url' },
        generation_id: { type: 'string', description: 'Product generation row backing this clip' },
        asset_id: { type: 'string', description: 'Product asset row backing this clip' },
        track_id: { type: 'string', description: 'Target track id; omit for automatic track choice' },
      },
      ['label', 'start_seconds', 'duration_seconds'],
    ),
    run: (args, env) =>
      runMutation('place_clip', args, env, (timeline) => {
        const fps = timeline.sequence.fps
        const mediaUrl = optionalString(args, 'media_url')
        const mediaKind = optionalEnum(args, 'media_kind', SEQUENCE_MEDIA_KINDS)
        if ((mediaUrl === undefined) !== (mediaKind === undefined)) {
          throw new Error('media_url and media_kind must be provided together')
        }
        const generationId = optionalString(args, 'generation_id')
        const assetId = optionalString(args, 'asset_id')
        const trackId = optionalString(args, 'track_id')
        return {
          operations: [
            {
              type: 'place_clip',
              label: requireString(args, 'label'),
              startFrame: secondsToFrames(requireSeconds(args, 'start_seconds'), fps),
              durationFrames: durationArgToFrames(requireSeconds(args, 'duration_seconds'), 'duration_seconds', fps),
              ...(trackId !== undefined ? { trackId } : {}),
              ...(mediaUrl !== undefined && mediaKind !== undefined ? { media: { url: mediaUrl, kind: mediaKind } } : {}),
              ...(generationId !== undefined ? { generationId } : {}),
              ...(assetId !== undefined ? { assetId } : {}),
            },
          ],
        }
      }),
  },
  {
    name: 'add_caption',
    description:
      'Add one caption clip. Omit start_seconds and duration_seconds to auto-place roughly 3 seconds of caption near the playhead without overlapping existing captions. language is a BCP-47 tag like "en" or "es".',
    inputSchema: objectSchema(
      {
        text: { type: 'string', description: 'Caption text' },
        language: { type: 'string', description: 'BCP-47 language tag; omit for the sequence default' },
        start_seconds: secondsSchema('Caption start in seconds; omit to auto-place near the playhead'),
        duration_seconds: secondsSchema('Caption length in seconds; omit for the ~3s default'),
      },
      ['text'],
    ),
    run: (args, env) =>
      runMutation('add_caption', args, env, (timeline) => {
        const fps = timeline.sequence.fps
        const language = optionalString(args, 'language')
        const startSeconds = optionalSeconds(args, 'start_seconds')
        const durationSeconds = optionalSeconds(args, 'duration_seconds')
        return {
          operations: [
            {
              type: 'add_caption',
              text: requireString(args, 'text'),
              ...(language !== undefined ? { language } : {}),
              ...(startSeconds !== undefined ? { startFrame: secondsToFrames(startSeconds, fps) } : {}),
              ...(durationSeconds !== undefined
                ? { durationFrames: durationArgToFrames(durationSeconds, 'duration_seconds', fps) }
                : {}),
            },
          ],
        }
      }),
  },
  {
    name: 'add_captions',
    description:
      `Add many caption clips in one call — use this for transcription output instead of repeated add_caption. Each item needs text, start_seconds, duration_seconds. One shared language applies to every caption. Max ${MAX_CAPTION_BATCH} per call.`,
    inputSchema: objectSchema(
      {
        captions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CAPTION_BATCH,
          description: 'Caption entries in timeline order',
          items: objectSchema(
            {
              text: { type: 'string', description: 'Caption text' },
              start_seconds: secondsSchema('Caption start in seconds'),
              duration_seconds: secondsSchema('Caption length in seconds'),
            },
            ['text', 'start_seconds', 'duration_seconds'],
          ),
        },
        language: { type: 'string', description: 'BCP-47 language tag applied to every caption in the batch' },
      },
      ['captions'],
    ),
    run: (args, env) =>
      runMutation('add_captions', args, env, (timeline) => {
        const fps = timeline.sequence.fps
        const language = optionalString(args, 'language')
        const raw = args.captions
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error('captions is required and must be a non-empty array of {text, start_seconds, duration_seconds}')
        }
        if (raw.length > MAX_CAPTION_BATCH) {
          throw new Error(`captions has ${raw.length} entries — max ${MAX_CAPTION_BATCH} per call; split the batch`)
        }
        const operations = raw.map((entry, index): SequenceOperation => {
          if (!isRecord(entry)) throw new Error(`captions[${index}] must be an object with text, start_seconds, duration_seconds`)
          try {
            return {
              type: 'add_caption',
              text: requireString(entry, 'text'),
              startFrame: secondsToFrames(requireSeconds(entry, 'start_seconds'), fps),
              durationFrames: durationArgToFrames(requireSeconds(entry, 'duration_seconds'), 'duration_seconds', fps),
              ...(language !== undefined ? { language } : {}),
            }
          } catch (err) {
            throw new Error(`captions[${index}]: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
        return { operations }
      }),
  },
  {
    name: 'move_clip',
    description: 'Move a clip so it starts at start_seconds, optionally onto another track via track_id. Duration and source in/out points are unchanged.',
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        start_seconds: secondsSchema('New clip start on the timeline, in seconds'),
        track_id: { type: 'string', description: 'Destination track id; omit to stay on the current track' },
      },
      ['clip_id', 'start_seconds'],
    ),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('move_clip', args, env, (timeline) => {
        const trackId = optionalString(args, 'track_id')
        return {
          clipId,
          operations: [
            {
              type: 'move_clip',
              clipId,
              startFrame: secondsToFrames(requireSeconds(args, 'start_seconds'), timeline.sequence.fps),
              ...(trackId !== undefined ? { trackId } : {}),
            },
          ],
        }
      })
    },
  },
  {
    name: 'trim_clip',
    description:
      'Set a clip to start_seconds + duration_seconds. source_in_seconds re-anchors where playback begins inside the source media (use it when trimming the head so the visible content stays aligned).',
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        start_seconds: secondsSchema('Clip start on the timeline, in seconds'),
        duration_seconds: secondsSchema('New clip length in seconds (at least one frame)'),
        source_in_seconds: secondsSchema('Offset into the source media where playback begins, in seconds'),
      },
      ['clip_id', 'start_seconds', 'duration_seconds'],
    ),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('trim_clip', args, env, (timeline) => {
        const fps = timeline.sequence.fps
        const sourceInSeconds = optionalSeconds(args, 'source_in_seconds')
        return {
          clipId,
          operations: [
            {
              type: 'trim_clip',
              clipId,
              startFrame: secondsToFrames(requireSeconds(args, 'start_seconds'), fps),
              durationFrames: durationArgToFrames(requireSeconds(args, 'duration_seconds'), 'duration_seconds', fps),
              ...(sourceInSeconds !== undefined ? { sourceInFrame: secondsToFrames(sourceInSeconds, fps) } : {}),
            },
          ],
        }
      })
    },
  },
  {
    name: 'split_clip',
    description: 'Cut a clip into two at at_seconds (sequence time, strictly inside the clip). The original clip id keeps the left half; the returned clip is the new right half with its source in-point re-anchored at the cut.',
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        at_seconds: secondsSchema('Sequence time of the cut, in seconds; must fall strictly inside the clip'),
      },
      ['clip_id', 'at_seconds'],
    ),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('split_clip', args, env, (timeline) => ({
        clipId,
        operations: [
          {
            type: 'split_clip',
            clipId,
            atFrame: secondsToFrames(requireSeconds(args, 'at_seconds'), timeline.sequence.fps),
          },
        ],
      }))
    },
  },
  {
    name: 'set_clip_text',
    description: 'Replace a caption clip\'s text, optionally changing its BCP-47 language tag.',
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        text: { type: 'string', description: 'New caption text' },
        language: { type: 'string', description: 'BCP-47 language tag; omit to keep the current one' },
      },
      ['clip_id', 'text'],
    ),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('set_clip_text', args, env, () => {
        const language = optionalString(args, 'language')
        return {
          clipId,
          operations: [
            {
              type: 'set_clip_text',
              clipId,
              text: requireString(args, 'text'),
              ...(language !== undefined ? { language } : {}),
            },
          ],
        }
      })
    },
  },
  {
    name: 'delete_clip',
    description: 'Remove a clip from the timeline permanently. Prefer set_clip_disabled to audition a cut without losing the clip.',
    inputSchema: objectSchema({ clip_id: CLIP_ID_SCHEMA }, ['clip_id']),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('delete_clip', args, env, () => ({
        operations: [{ type: 'delete_clip', clipId }],
      }))
    },
  },
  {
    name: 'set_clip_disabled',
    description: 'Disable (true) or re-enable (false) a clip without deleting it. Disabled clips do not render or sound.',
    inputSchema: objectSchema(
      {
        clip_id: CLIP_ID_SCHEMA,
        disabled: { type: 'boolean', description: 'true hides the clip; false restores it' },
      },
      ['clip_id', 'disabled'],
    ),
    run: (args, env) => {
      const clipId = requireString(args, 'clip_id')
      return runMutation('set_clip_disabled', args, env, () => ({
        clipId,
        operations: [{ type: 'set_clip_disabled', clipId, disabled: requireBoolean(args, 'disabled') }],
      }))
    },
  },
  {
    name: 'create_track',
    description: `Add a track to the sequence. kind is one of: ${SEQUENCE_TRACK_KINDS.join(', ')}. New tracks sort below existing ones.`,
    inputSchema: objectSchema(
      {
        kind: { type: 'string', enum: [...SEQUENCE_TRACK_KINDS], description: 'Track kind' },
        name: { type: 'string', description: 'Track display name' },
      },
      ['kind', 'name'],
    ),
    run: (args, env) =>
      runMutation('create_track', args, env, () => ({
        operations: [
          {
            type: 'create_track',
            kind: requireEnum(args, 'kind', SEQUENCE_TRACK_KINDS),
            name: requireString(args, 'name'),
          },
        ],
      })),
  },
  {
    name: 'extend_sequence',
    description: 'Set the sequence\'s total duration in seconds. Growing always works; shrinking is rejected if any clip would fall past the new end.',
    inputSchema: objectSchema(
      { duration_seconds: secondsSchema('New total sequence duration in seconds') },
      ['duration_seconds'],
    ),
    run: (args, env) =>
      runMutation('extend_sequence', args, env, (timeline) => ({
        operations: [
          {
            type: 'extend_sequence',
            durationFrames: durationArgToFrames(requireSeconds(args, 'duration_seconds'), 'duration_seconds', timeline.sequence.fps),
          },
        ],
      })),
  },
  {
    name: 'queue_export',
    description: `Queue an export of the sequence. format is one of: ${SEQUENCE_EXPORT_FORMATS.join(', ')}. Returns the queued export record; rendering happens asynchronously.`,
    inputSchema: objectSchema(
      { format: { type: 'string', enum: [...SEQUENCE_EXPORT_FORMATS], description: 'Export format' } },
      ['format'],
    ),
    run: (args, env) =>
      runMutation('queue_export', args, env, () => ({
        operations: [{ type: 'queue_export', format: requireEnum(args, 'format', SEQUENCE_EXPORT_FORMATS) }],
      })),
  },
  {
    name: 'list_decisions',
    description: 'Read the sequence\'s edit-decision log (human edits, agent edits, exports, notes), newest first. limit caps the number of rows.',
    inputSchema: objectSchema(
      { limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max rows to return' } },
      [],
    ),
    run: async (args, env) => {
      const limit = optionalPositiveInteger(args, 'limit', 1000)
      const decisions = await env.store.listDecisions(limit)
      return { decisions: decisions.map(decisionView) }
    },
  },
]

export function findSequenceMcpTool(name: string): SequenceMcpToolDefinition | undefined {
  return SEQUENCE_MCP_TOOLS.find((tool) => tool.name === name)
}
