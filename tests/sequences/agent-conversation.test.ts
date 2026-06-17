/**
 * Deterministic end-to-end gate for the agent-drivable sequences seam — the
 * in-repo twin of the live eval, with NO LLM and NO API key. A scripted plan
 * of MCP tool calls is driven through the REAL `createSequencesMcpHandler`
 * (JSON-RPC over a Request, the exact channel an in-sandbox agent uses) against
 * an in-memory `SequenceStore`. The validate/apply kernel, seconds→frames
 * conversion, caption-track auto-creation, export queue, and decision-log
 * writes are all the real code path; only the model is replaced by a fixed
 * script that reads tool results to recover live clip ids the way a real agent
 * does.
 *
 * The post-state is then asserted with the same deterministic frame-math checks
 * the campaign runs (./checks). A green run here means: a scripted agent can
 * assemble a cut, caption it, refine it (trim/split), and queue an export
 * through this shell's tools, and an INVALID op surfaces as a model-readable
 * error — proven on every CI without spending a token.
 */

import { describe, expect, it } from 'vitest'
import type {
  SequenceClip,
  SequenceDecision,
  SequenceExportRecord,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
} from '../../src/sequences/model'
import type {
  NewSequenceClip,
  NewSequenceDecision,
  NewSequenceTrack,
  SequenceClipPatch,
  SequenceStore,
} from '../../src/sequences/store'
import { createSequencesMcpHandler } from '../../src/sequences/mcp-handler'
import {
  checkCaptionCount,
  checkCaptionLanguages,
  checkDecisionLogComplete,
  checkExportQueued,
  checkNoVideoGaps,
  checkSplitOccurred,
  checkVideoClipCount,
  checkVideoClipsOrdered,
} from './checks'
import type { SequenceCheckFn } from './checks'

const MEDIA = 'https://cdn.test/clip.mp4'

// ---------------------------------------------------------------------------
// In-memory store — full SequenceStore, throws like the contract demands, and
// resolves metadata.media into clip.media exactly as a real store does so the
// place_clip media path is exercised end to end.
// ---------------------------------------------------------------------------

interface MemoryState {
  sequence: SequenceMeta
  tracks: SequenceTrack[]
  clips: SequenceClip[]
  decisions: SequenceDecision[]
  exports: SequenceExportRecord[]
}

function createMemoryStore(opts: { durationFrames?: number } = {}): { store: SequenceStore; state: MemoryState } {
  let nextId = 0
  const id = (prefix: string) => `${prefix}-${++nextId}`

  const state: MemoryState = {
    sequence: {
      id: 'seq-1',
      title: 'Launch teaser',
      fps: 30,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames: opts.durationFrames ?? 1800,
      status: 'active',
      metadata: {},
    },
    tracks: [{ id: 'track-video', kind: 'video', name: 'Video 1', sortOrder: 0, locked: false, muted: false, metadata: {} }],
    clips: [],
    decisions: [],
    exports: [],
  }

  const findClip = (clipId: string): SequenceClip => {
    const clip = state.clips.find((c) => c.id === clipId)
    if (!clip) throw new Error(`clip ${clipId} not found in sequence ${state.sequence.id}`)
    return clip
  }

  const store: SequenceStore = {
    async getTimeline(): Promise<SequenceTimeline> {
      return structuredClone({ sequence: state.sequence, tracks: state.tracks, clips: state.clips })
    },
    async getClip(clipId): Promise<SequenceClip> {
      return structuredClone(findClip(clipId))
    },
    async createTrack(input: NewSequenceTrack): Promise<SequenceTrack> {
      const track: SequenceTrack = {
        id: id('track'),
        kind: input.kind,
        name: input.name,
        sortOrder: input.sortOrder ?? state.tracks.length,
        locked: false,
        muted: false,
        metadata: {},
      }
      state.tracks.push(track)
      return structuredClone(track)
    },
    async createClip(input: NewSequenceClip): Promise<SequenceClip> {
      if (!state.tracks.some((t) => t.id === input.trackId)) {
        throw new Error(`track ${input.trackId} not found in sequence ${state.sequence.id}`)
      }
      const metadata = input.metadata ?? {}
      const media = metadata.media as SequenceClip['media'] | undefined
      const clip: SequenceClip = {
        id: id('clip'),
        trackId: input.trackId,
        label: input.label,
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        sourceInFrame: input.sourceInFrame ?? 0,
        sourceOutFrame: input.sourceOutFrame ?? null,
        disabled: false,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
        ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
        ...(media ? { media } : {}),
        metadata,
      }
      state.clips.push(clip)
      return structuredClone(clip)
    },
    async updateClip(clipId, patch: SequenceClipPatch): Promise<SequenceClip> {
      const clip = findClip(clipId)
      if (patch.trackId !== undefined) clip.trackId = patch.trackId
      if (patch.label !== undefined) clip.label = patch.label
      if (patch.startFrame !== undefined) clip.startFrame = patch.startFrame
      if (patch.durationFrames !== undefined) clip.durationFrames = patch.durationFrames
      if (patch.sourceInFrame !== undefined) clip.sourceInFrame = patch.sourceInFrame
      if (patch.sourceOutFrame !== undefined) clip.sourceOutFrame = patch.sourceOutFrame
      if (patch.disabled !== undefined) clip.disabled = patch.disabled
      if (patch.text !== undefined) clip.text = patch.text
      if (patch.language !== undefined) clip.language = patch.language
      if (patch.metadata !== undefined) clip.metadata = patch.metadata
      return structuredClone(clip)
    },
    async deleteClip(clipId): Promise<void> {
      findClip(clipId)
      state.clips = state.clips.filter((c) => c.id !== clipId)
    },
    async updateSequenceDuration(durationFrames): Promise<SequenceMeta> {
      state.sequence = { ...state.sequence, durationFrames }
      return structuredClone(state.sequence)
    },
    async recordDecision(input: NewSequenceDecision): Promise<SequenceDecision> {
      const decision: SequenceDecision = {
        id: id('decision'),
        clipId: input.clipId ?? null,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        accepted: input.accepted ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date('2026-06-17T00:00:00Z'),
      }
      state.decisions.push(decision)
      return structuredClone(decision)
    },
    async createExport(format, metadata): Promise<SequenceExportRecord> {
      const record: SequenceExportRecord = {
        id: id('export'),
        format,
        status: 'queued',
        resultUrl: null,
        metadata: metadata ?? {},
        createdAt: new Date('2026-06-17T00:00:00Z'),
      }
      state.exports.push(record)
      return structuredClone(record)
    },
    async listDecisions(limit?: number): Promise<SequenceDecision[]> {
      const rows = [...state.decisions].reverse()
      return structuredClone(limit !== undefined ? rows.slice(0, limit) : rows)
    },
    async listExports(limit?: number): Promise<SequenceExportRecord[]> {
      const rows = [...state.exports].reverse()
      return structuredClone(limit !== undefined ? rows.slice(0, limit) : rows)
    },
  }

  return { store, state }
}

// ---------------------------------------------------------------------------
// Scripted conversation driver over the REAL handler. A step is a function of
// the tool-result transcript so far → the next batch of tool calls (returning
// [] ends the turn). This is the in-repo, demo-free equivalent of the eval's
// scripted LlmClient: ids are recovered from get_timeline_state results exactly
// as an agent would read them.
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>

interface ToolResult {
  name: string
  isError: boolean
  text: string
  json?: Record<string, any>
}

async function callTool(handler: Handler, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await handler(
    new Request('http://app.test/api/sequences/seq-1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = result.content[0]!.text
  const isError = result.isError === true
  return { name, isError, text, json: isError ? undefined : (JSON.parse(text) as Record<string, any>) }
}

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

type Step = (transcript: ToolResult[]) => ToolCall[]

/** Run a scripted plan against one handler and return the flat transcript of
 *  every tool result the model would have read. */
async function runScript(handler: Handler, steps: Step[]): Promise<ToolResult[]> {
  const transcript: ToolResult[] = []
  for (const step of steps) {
    const calls = step(transcript)
    for (const call of calls) {
      transcript.push(await callTool(handler, call.name, call.args))
    }
  }
  return transcript
}

interface ReadClip {
  id: string
  track_id: string
  start_frame: number
}

/** Recover the serialized clips from the most recent get_timeline_state result
 *  — how an agent reads ids before trimming/splitting. */
function latestClips(transcript: ToolResult[]): ReadClip[] {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const r = transcript[i]
    if (r && r.name === 'get_timeline_state' && r.json && Array.isArray(r.json.clips)) {
      return r.json.clips as ReadClip[]
    }
  }
  return []
}

/** Video-track clip ids in start-frame order, the lane an agent edits a cut on. */
function videoClipIds(transcript: ToolResult[], videoTrackId: string): string[] {
  return latestClips(transcript)
    .filter((c) => c.track_id === videoTrackId)
    .sort((a, b) => a.start_frame - b.start_frame)
    .map((c) => c.id)
}

function expectChecks(timeline: SequenceTimeline, decisions: SequenceDecision[], checks: SequenceCheckFn[]): void {
  for (const check of checks) {
    const result = check(timeline, decisions)
    expect(result.passed, `${result.id}: ${result.detail}`).toBe(true)
  }
}

// ---------------------------------------------------------------------------

describe('deterministic agent conversation (no LLM)', () => {
  it('assembles 3 contiguous clips, captions, splits, trims, and queues an export', async () => {
    const { store, state } = createMemoryStore()
    const handler = createSequencesMcpHandler({ store, playheadFrame: 0 })

    const transcript = await runScript(handler, [
      // 1. Lay down three contiguous 3s clips → a 9s cut, no gaps.
      () => [
        { name: 'place_clip', args: { label: 'A', start_seconds: 0, duration_seconds: 3, media_url: MEDIA, media_kind: 'video' } },
        { name: 'place_clip', args: { label: 'B', start_seconds: 3, duration_seconds: 3, media_url: MEDIA, media_kind: 'video' } },
        { name: 'place_clip', args: { label: 'C', start_seconds: 6, duration_seconds: 3, media_url: MEDIA, media_kind: 'video' } },
      ],
      // 2. Caption the opening in English.
      () => [{ name: 'add_caption', args: { text: 'Welcome to the show', language: 'en', start_seconds: 0, duration_seconds: 3 } }],
      // 3. Read ids back, then split clip B at 4s (inside [3s,6s)).
      () => [{ name: 'get_timeline_state', args: {} }],
      (transcript) => {
        const videoIds = videoClipIds(transcript, 'track-video')
        const second = videoIds[1]
        return second ? [{ name: 'split_clip', args: { clip_id: second, at_seconds: 4 } }] : []
      },
      // 4. Trim the first clip's head (re-anchor source-in), no gap introduced.
      () => [{ name: 'get_timeline_state', args: {} }],
      (transcript) => {
        const first = videoClipIds(transcript, 'track-video')[0]
        return first
          ? [{ name: 'trim_clip', args: { clip_id: first, start_seconds: 0, duration_seconds: 3, source_in_seconds: 0.5 } }]
          : []
      },
      // 5. Queue the final mp4 export.
      () => [{ name: 'queue_export', args: { format: 'mp4' } }],
    ])

    // Every scripted op succeeded (no isError on the happy path).
    const failed = transcript.filter((r) => r.isError)
    expect(failed.map((r) => `${r.name}: ${r.text}`)).toEqual([])

    const timeline = await store.getTimeline()
    const decisions = await store.listDecisions()

    // Direct state assertions on the resulting timeline.
    const videoClips = timeline.clips.filter((c) => c.trackId === 'track-video')
    expect(videoClips).toHaveLength(4) // 3 placed + 1 from the split
    const sorted = [...videoClips].sort((a, b) => a.startFrame - b.startFrame)
    expect(sorted.map((c) => c.startFrame)).toEqual([0, 90, 120, 180]) // 0s,3s,4s,6s @30fps
    // contiguous: each clip starts exactly where the previous ends.
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startFrame).toBe(sorted[i - 1]!.startFrame + sorted[i - 1]!.durationFrames)
    }
    // caption present on its own auto-created caption track.
    const captionClips = timeline.clips.filter((c) => typeof c.text === 'string')
    expect(captionClips).toHaveLength(1)
    expect(captionClips[0]!.language).toBe('en')
    const captionTrack = timeline.tracks.find((t) => t.id === captionClips[0]!.trackId)!
    expect(captionTrack.kind).toBe('caption')
    // export queued.
    expect(state.exports).toHaveLength(1)
    expect(state.exports[0]!.format).toBe('mp4')
    // decision-log completeness: place×3 + caption + split + trim + export = 7
    // agent_edit rows, every mutating call audited.
    const agentEdits = decisions.filter((d) => d.kind === 'agent_edit')
    expect(agentEdits).toHaveLength(7)

    // The same deterministic checks the live campaign runs.
    expectChecks(timeline, decisions, [
      checkVideoClipCount(3),
      checkVideoClipsOrdered(),
      checkNoVideoGaps(270), // contiguous 0..270 (9s @30fps)
      checkCaptionLanguages(['en']),
      checkCaptionCount('en', 1),
      checkSplitOccurred(4),
      checkExportQueued('mp4'),
      checkDecisionLogComplete(7),
    ])
  })

  it('surfaces an invalid op (split unknown clip) as a model-readable isError and writes nothing', async () => {
    const { store, state } = createMemoryStore()
    const handler = createSequencesMcpHandler({ store, playheadFrame: 0 })

    const transcript = await runScript(handler, [
      // Seed one real clip so the timeline is non-empty.
      () => [{ name: 'place_clip', args: { label: 'A', start_seconds: 0, duration_seconds: 3, media_url: MEDIA, media_kind: 'video' } }],
      // Now drive an op against a clip that does not exist.
      () => [{ name: 'split_clip', args: { clip_id: 'does-not-exist', at_seconds: 1 } }],
      () => [{ name: 'move_clip', args: { clip_id: 'ghost-2', start_seconds: 2 } }],
    ])

    const place = transcript.find((r) => r.name === 'place_clip')!
    expect(place.isError).toBe(false)

    const badSplit = transcript.find((r) => r.name === 'split_clip')!
    expect(badSplit.isError).toBe(true)
    expect(badSplit.text).toContain('split_clip failed:')
    expect(badSplit.text).toContain('does-not-exist')

    const badMove = transcript.find((r) => r.name === 'move_clip')!
    expect(badMove.isError).toBe(true)
    expect(badMove.text).toContain('ghost-2')

    // The invalid ops wrote nothing: only the one valid clip and its single
    // decision row survive (validate runs before any store write).
    expect(state.clips).toHaveLength(1)
    const agentEdits = state.decisions.filter((d) => d.kind === 'agent_edit')
    expect(agentEdits).toHaveLength(1)
  })
})
