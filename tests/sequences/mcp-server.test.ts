import { describe, expect, it } from 'vitest'
import type {
  SequenceClip,
  SequenceDecision,
  SequenceExportRecord,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
} from '../../src/sequences/model'
import type { SequenceOperation } from '../../src/sequences/operations'
import type {
  NewSequenceClip,
  NewSequenceDecision,
  NewSequenceTrack,
  SequenceClipPatch,
  SequenceStore,
} from '../../src/sequences/store'
import { SEQUENCE_MCP_TOOLS } from '../../src/sequences/mcp-tools'
import { createSequencesMcpHandler } from '../../src/sequences/mcp-handler'
import { DEFAULT_SEQUENCES_MCP_DESCRIPTION, buildSequencesMcpServerEntry } from '../../src/sequences/mcp-entry'

// ---------------------------------------------------------------------------
// In-memory store fake — full SequenceStore, throws like the contract demands.
// The validate/apply kernel is the REAL one: these tests are end-to-end from
// Request to store state.
// ---------------------------------------------------------------------------

interface MemoryState {
  sequence: SequenceMeta
  tracks: SequenceTrack[]
  clips: SequenceClip[]
  decisions: SequenceDecision[]
  exports: SequenceExportRecord[]
}

function createMemoryStore(): { store: SequenceStore; state: MemoryState } {
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
      durationFrames: 900,
      status: 'active',
      metadata: {},
    },
    tracks: [
      { id: 'track-video', kind: 'video', name: 'Video 1', sortOrder: 0, locked: false, muted: false, metadata: {} },
      { id: 'track-captions', kind: 'caption', name: 'Captions', sortOrder: 1, locked: false, muted: false, metadata: {} },
    ],
    clips: [
      {
        id: 'clip-intro',
        trackId: 'track-video',
        label: 'Intro',
        startFrame: 0,
        durationFrames: 150,
        sourceInFrame: 0,
        sourceOutFrame: null,
        disabled: false,
        media: { url: 'https://cdn.test/intro.mp4', kind: 'video', durationSeconds: 8, providerStatus: 'completed' },
        metadata: {},
      },
    ],
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
    async getClip(clipId: string): Promise<SequenceClip> {
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
      // The kernel rides provider-URL media in metadata.media; a real store
      // resolves it into clip.media — mirror that here.
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
    async updateClip(clipId: string, patch: SequenceClipPatch): Promise<SequenceClip> {
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
    async deleteClip(clipId: string): Promise<void> {
      findClip(clipId)
      state.clips = state.clips.filter((c) => c.id !== clipId)
    },
    async updateSequenceDuration(durationFrames: number): Promise<SequenceMeta> {
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
        createdAt: new Date('2026-06-12T00:00:00Z'),
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
        createdAt: new Date('2026-06-12T00:00:00Z'),
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
// JSON-RPC driver
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>

function setup(playheadFrame = 60) {
  const { store, state } = createMemoryStore()
  const handler = createSequencesMcpHandler({ store, playheadFrame })
  return { handler, state }
}

function post(handler: Handler, body: string): Promise<Response> {
  return handler(
    new Request('http://app.test/api/sequences/seq-1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  )
}

async function rpc(handler: Handler, method: string, params?: unknown, id: number | string = 1) {
  const res = await post(handler, JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }))
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

/** tools/call returning the parsed JSON the model would read. */
async function callTool(handler: Handler, name: string, args?: Record<string, unknown>) {
  const { status, body } = await rpc(handler, 'tools/call', { name, arguments: args })
  expect(status).toBe(200)
  const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  return {
    isError: result.isError === true,
    text: result.content[0]!.text,
    json: result.isError ? undefined : (JSON.parse(result.content[0]!.text) as Record<string, any>),
  }
}

// ---------------------------------------------------------------------------

describe('initialize handshake', () => {
  it('echoes a supported protocol version with serverInfo and tools capability', async () => {
    const { handler } = setup()
    const { status, body } = await rpc(handler, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'opencode', version: '1.0.0' },
    })
    expect(status).toBe(200)
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe('sequences')
    expect(body.result.capabilities.tools).toBeDefined()
  })

  it('answers an unsupported requested version with the newest it speaks', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'initialize', { protocolVersion: '1999-01-01' })
    expect(body.result.protocolVersion).toBe('2025-06-18')
  })

  it('acknowledges notifications/initialized with 202 and no body', async () => {
    const { handler } = setup()
    const res = await post(handler, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })
})

describe('tools/list', () => {
  it('lists all 16 sequence tools with descriptions and object schemas', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'tools/list')
    const tools = body.result.tools as Array<{ name: string; description: string; inputSchema: any }>
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_timeline_state',
        'get_frame_at_time',
        'get_clip',
        'place_clip',
        'add_caption',
        'add_captions',
        'move_clip',
        'trim_clip',
        'split_clip',
        'set_clip_text',
        'delete_clip',
        'set_clip_disabled',
        'create_track',
        'extend_sequence',
        'queue_export',
        'list_decisions',
      ].sort(),
    )
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
    }
    const placeClip = tools.find((t) => t.name === 'place_clip')!
    expect(placeClip.inputSchema.required).toEqual(['label', 'start_seconds', 'duration_seconds'])
    expect(SEQUENCE_MCP_TOOLS).toHaveLength(16)
  })
})

describe('read tools', () => {
  it('get_timeline_state serializes timecodes, playhead, and media status', async () => {
    const { handler } = setup(60)
    const { json } = await callTool(handler, 'get_timeline_state')
    expect(json!.sequence.duration_timecode).toBe('0:30.00')
    expect(json!.sequence.duration_seconds).toBe(30)
    expect(json!.playhead).toEqual({ frame: 60, seconds: 2, timecode: '0:02.00' })
    expect(json!.tracks).toHaveLength(2)
    const intro = json!.clips[0]
    expect(intro.start_timecode).toBe('0:00.00')
    expect(intro.end_timecode).toBe('0:05.00')
    expect(intro.media).toEqual({ url: 'https://cdn.test/intro.mp4', kind: 'video', duration_seconds: 8, provider_status: 'completed' })
  })

  it('get_frame_at_time reports active clips with a readable summary', async () => {
    const { handler } = setup()
    const { json } = await callTool(handler, 'get_frame_at_time', { seconds: 2 })
    expect(json!.frame).toBe(60)
    expect(json!.summary).toContain('video "Intro"')
    expect(json!.active).toHaveLength(1)
  })

  it('get_frame_at_time beyond the sequence is an isError the model can read', async () => {
    const { handler } = setup()
    const result = await callTool(handler, 'get_frame_at_time', { seconds: 9999 })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('get_frame_at_time failed:')
    expect(result.text).toContain('beyond the sequence')
  })

  it('get_clip surfaces the store throw for an unknown id', async () => {
    const { handler } = setup()
    const result = await callTool(handler, 'get_clip', { clip_id: 'clip-ghost' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('clip clip-ghost not found')
  })
})

describe('mutating tools', () => {
  it('place_clip converts seconds once, persists, and records ONE agent_edit decision', async () => {
    const { handler, state } = setup()
    const { isError, json } = await callTool(handler, 'place_clip', {
      label: 'B-roll',
      start_seconds: 5,
      duration_seconds: 4,
      media_url: 'https://cdn.test/broll.mp4',
      media_kind: 'video',
    })
    expect(isError).toBe(false)

    expect(json!.changed).toHaveLength(1)
    const clip = json!.changed[0].clip
    expect(clip.start_frame).toBe(150)
    expect(clip.duration_frames).toBe(120)
    expect(clip.start_seconds).toBe(5)
    expect(clip.start_timecode).toBe('0:05.00')
    expect(clip.track_id).toBe('track-video')
    expect(clip.media.url).toBe('https://cdn.test/broll.mp4')

    expect(state.clips).toHaveLength(2)
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]!.kind).toBe('agent_edit')
    expect(state.decisions[0]!.instruction).toMatch(/^place_clip \{"label":"B-roll"/)
    expect(json!.decision_id).toBe(state.decisions[0]!.id)
  })

  it('a validation throw becomes isError with the reason and writes NOTHING', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'place_clip', {
      label: 'Too long',
      start_seconds: 29,
      duration_seconds: 10,
      media_url: 'https://cdn.test/x.mp4',
      media_kind: 'video',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('place_clip failed:')
    expect(result.text).toContain('extends beyond the sequence duration')
    expect(result.text).toContain('900-frame sequence')
    expect(state.clips).toHaveLength(1)
    expect(state.decisions).toHaveLength(0)
  })

  it('rejects local sandbox media URLs with the kernel reason', async () => {
    const { handler, state } = setup()
    const result = await callTool(handler, 'place_clip', {
      label: 'Fake render',
      start_seconds: 0,
      duration_seconds: 2,
      media_url: 'file:///tmp/out.mp4',
      media_kind: 'video',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not a local sandbox file')
    expect(state.clips).toHaveLength(1)
  })

  it('argument-shape errors name the argument and unit', async () => {
    const { handler } = setup()
    const missing = await callTool(handler, 'place_clip', { start_seconds: 0, duration_seconds: 1 })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('label is required')

    const halfMedia = await callTool(handler, 'place_clip', {
      label: 'x',
      start_seconds: 0,
      duration_seconds: 1,
      media_url: 'https://cdn.test/x.mp4',
    })
    expect(halfMedia.isError).toBe(true)
    expect(halfMedia.text).toContain('media_url and media_kind must be provided together')

    const negative = await callTool(handler, 'move_clip', { clip_id: 'clip-intro', start_seconds: -1 })
    expect(negative.isError).toBe(true)
    expect(negative.text).toContain('start_seconds is required and must be a non-negative number of seconds')

    const subFrame = await callTool(handler, 'place_clip', { label: 'x', start_seconds: 0, duration_seconds: 0.001 })
    expect(subFrame.isError).toBe(true)
    expect(subFrame.text).toContain('duration_seconds')
    expect(subFrame.text).toContain('30 fps')
  })

  it('add_caption without bounds anchors to the server-set playhead', async () => {
    const { handler, state } = setup(60)
    const { json } = await callTool(handler, 'add_caption', { text: 'Hello world' })
    const caption = json!.changed[0].clip
    expect(caption.start_frame).toBe(60)
    expect(caption.duration_frames).toBe(90)
    expect(caption.text).toBe('Hello world')
    expect(state.clips.find((c) => c.text === 'Hello world')!.trackId).toBe('track-captions')
  })

  it('add_caption with a language auto-creates the per-language caption track', async () => {
    const { handler, state } = setup()
    const { json } = await callTool(handler, 'add_caption', { text: 'Hola', language: 'es' })
    const caption = json!.changed[0].clip
    expect(caption.language).toBe('es')
    const track = state.tracks.find((t) => t.id === caption.track_id)!
    expect(track.kind).toBe('caption')
    expect(track.name).toBe('Captions (es)')
  })

  it('add_captions applies the batch in order under ONE decision row', async () => {
    const { handler, state } = setup()
    const { json } = await callTool(handler, 'add_captions', {
      language: 'en',
      captions: [
        { text: 'one', start_seconds: 0, duration_seconds: 2 },
        { text: 'two', start_seconds: 2, duration_seconds: 2 },
        { text: 'three', start_seconds: 4, duration_seconds: 2 },
      ],
    })
    expect(json!.changed).toHaveLength(3)
    // The first caption creates the per-language track; the rest reuse it.
    const captionClips = state.clips.filter((c) => c.text !== undefined)
    expect(captionClips).toHaveLength(3)
    const trackIds = new Set(captionClips.map((c) => c.trackId))
    expect(trackIds.size).toBe(1)
    expect(state.tracks.find((t) => t.id === [...trackIds][0])!.name).toBe('Captions (en)')
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]!.instruction).toMatch(/^add_captions /)
    expect(json!.changed.map((c: any) => c.clip.text)).toEqual(['one', 'two', 'three'])
  })

  it('add_captions pinpoints the broken entry by index', async () => {
    const { handler } = setup()
    const result = await callTool(handler, 'add_captions', {
      captions: [
        { text: 'fine', start_seconds: 0, duration_seconds: 2 },
        { text: 'broken', start_seconds: 2 },
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('captions[1]')
    expect(result.text).toContain('duration_seconds')
  })

  it('add_captions keeps adjacent transcription cues adjacent in frames (end-derived rounding)', async () => {
    const { handler, state } = setup()
    // round(0.49·30)=15 and round(0.49·30)+round(0.49·30)=30 ≠ round(0.98·30)=29:
    // independent rounding would end cue 1 at frame 30 while cue 2 starts at 29.
    const { isError } = await callTool(handler, 'add_captions', {
      language: 'en',
      captions: [
        { text: 'one', start_seconds: 0.49, duration_seconds: 0.49 },
        { text: 'two', start_seconds: 0.98, duration_seconds: 0.49 },
      ],
    })
    expect(isError).toBe(false)
    const cues = state.clips.filter((c) => c.text !== undefined).sort((a, b) => a.startFrame - b.startFrame)
    expect(cues).toHaveLength(2)
    expect(cues[0]!.startFrame + cues[0]!.durationFrames).toBe(cues[1]!.startFrame)
  })

  it('get_frame_at_time floors: the half-frame before a cut reports the clip on screen, not the next one', async () => {
    const { handler } = setup()
    // clip-intro covers [0, 150) = [0s, 5s). At 4.99s frame 149 is displayed;
    // nearest-rounding would answer 150 — past the clip.
    const before = await callTool(handler, 'get_frame_at_time', { seconds: 4.99 })
    expect(before.json!.frame).toBe(149)
    expect(before.json!.active).toHaveLength(1)

    const at = await callTool(handler, 'get_frame_at_time', { seconds: 5 })
    expect(at.json!.frame).toBe(150)
    expect(at.json!.active).toHaveLength(0)
  })

  it('trim_clip enforces the source window of a split half and source_out_seconds lifts it', async () => {
    const { handler, state } = setup()
    await callTool(handler, 'split_clip', { clip_id: 'clip-intro', at_seconds: 2 })
    // Head window is now [0s, 2s); extending to 4s without a new out-point is
    // a corrupted source range.
    const rejected = await callTool(handler, 'trim_clip', {
      clip_id: 'clip-intro',
      start_seconds: 0,
      duration_seconds: 4,
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('source window [0, 60) holds 60')

    const accepted = await callTool(handler, 'trim_clip', {
      clip_id: 'clip-intro',
      start_seconds: 0,
      duration_seconds: 4,
      source_out_seconds: 4,
    })
    expect(accepted.isError).toBe(false)
    expect(state.clips.find((c) => c.id === 'clip-intro')).toMatchObject({ durationFrames: 120, sourceOutFrame: 120 })
  })

  it('move/trim/split/disable/delete round-trip through the store', async () => {
    const { handler, state } = setup()

    const moved = await callTool(handler, 'move_clip', { clip_id: 'clip-intro', start_seconds: 10 })
    expect(moved.json!.changed[0].clip.start_frame).toBe(300)

    const trimmed = await callTool(handler, 'trim_clip', {
      clip_id: 'clip-intro',
      start_seconds: 10,
      duration_seconds: 2,
      source_in_seconds: 1,
    })
    expect(trimmed.json!.changed[0].clip.duration_frames).toBe(60)
    expect(trimmed.json!.changed[0].clip.source_in_frame).toBe(30)

    // Split at 11s: original keeps 300..330, the returned clip is the right
    // half 330..360 with its source in-point re-anchored at the cut.
    const split = await callTool(handler, 'split_clip', { clip_id: 'clip-intro', at_seconds: 11 })
    const rightHalf = split.json!.changed[0].clip
    expect(rightHalf.start_frame).toBe(330)
    expect(rightHalf.duration_frames).toBe(30)
    expect(rightHalf.source_in_frame).toBe(60)
    expect(state.clips).toHaveLength(2)
    expect(state.clips.find((c) => c.id === 'clip-intro')!.durationFrames).toBe(30)

    const disabled = await callTool(handler, 'set_clip_disabled', { clip_id: 'clip-intro', disabled: true })
    expect(disabled.json!.changed[0].clip.disabled).toBe(true)

    const deleted = await callTool(handler, 'delete_clip', { clip_id: 'clip-intro' })
    expect(deleted.isError).toBe(false)
    expect(deleted.json!.changed[0].clip.id).toBe('clip-intro')
    expect(state.clips.some((c) => c.id === 'clip-intro')).toBe(false)
    // delete decision row must not reference the removed clip
    expect(state.decisions.at(-1)!.clipId).toBeNull()

    const unknown = await callTool(handler, 'move_clip', { clip_id: 'clip-intro', start_seconds: 0 })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('references unknown clip clip-intro')
  })

  it('set_clip_text rewrites a caption clip and rejects non-caption targets', async () => {
    const { handler, state } = setup()
    await callTool(handler, 'add_caption', { text: 'draft wording', start_seconds: 0, duration_seconds: 2 })
    const captionId = state.clips.find((c) => c.text === 'draft wording')!.id

    const edited = await callTool(handler, 'set_clip_text', { clip_id: captionId, text: 'final wording', language: 'en' })
    expect(edited.json!.changed[0].clip.text).toBe('final wording')

    const wrongTrack = await callTool(handler, 'set_clip_text', { clip_id: 'clip-intro', text: 'nope' })
    expect(wrongTrack.isError).toBe(true)
    expect(wrongTrack.text).toContain('text edits apply only to caption clips')
  })

  it('create_track, extend_sequence, and queue_export return their post-state', async () => {
    const { handler, state } = setup()

    const track = await callTool(handler, 'create_track', { kind: 'audio', name: 'Music' })
    expect(track.json!.changed[0].track.kind).toBe('audio')
    expect(state.tracks).toHaveLength(3)

    const extended = await callTool(handler, 'extend_sequence', { duration_seconds: 60 })
    expect(extended.json!.changed[0].sequence.duration_frames).toBe(1800)
    expect(extended.json!.changed[0].sequence.duration_timecode).toBe('1:00.00')

    const queued = await callTool(handler, 'queue_export', { format: 'mp4' })
    expect(queued.json!.changed[0].export.status).toBe('queued')
    expect(state.exports).toHaveLength(1)

    const badFormat = await callTool(handler, 'queue_export', { format: 'mov' })
    expect(badFormat.isError).toBe(true)
    expect(badFormat.text).toContain('format must be one of: mp4, otio, xml, edl, vtt, srt, contact_sheet')
  })

  it('list_decisions returns the log newest first with ISO timestamps', async () => {
    const { handler } = setup()
    await callTool(handler, 'add_caption', { text: 'first' })
    await callTool(handler, 'queue_export', { format: 'srt' })
    const { json } = await callTool(handler, 'list_decisions', { limit: 10 })
    expect(json!.decisions).toHaveLength(2)
    expect(json!.decisions[0].instruction).toMatch(/^queue_export /)
    expect(json!.decisions[0].kind).toBe('agent_edit')
    expect(json!.decisions[0].created_at).toBe('2026-06-12T00:00:00.000Z')
  })
})

describe('JSON-RPC protocol errors', () => {
  it('rejects non-POST with 405', async () => {
    const { handler } = setup()
    const res = await handler(new Request('http://app.test/mcp', { method: 'GET' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('malformed JSON is a -32700 parse error', async () => {
    const { handler } = setup()
    const res = await post(handler, '{nope')
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, any>
    expect(body.error.code).toBe(-32700)
    expect(body.id).toBeNull()
  })

  it('batch arrays and non-2.0 envelopes are -32600', async () => {
    const { handler } = setup()
    const batch = await post(handler, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))
    expect(batch.status).toBe(400)
    expect(((await batch.json()) as Record<string, any>).error.code).toBe(-32600)

    const noMethod = await post(handler, JSON.stringify({ jsonrpc: '2.0', id: 2 }))
    expect(((await noMethod.json()) as Record<string, any>).error.code).toBe(-32600)

    const wrongVersion = await post(handler, JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'ping' }))
    expect(((await wrongVersion.json()) as Record<string, any>).error.code).toBe(-32600)
  })

  it('unknown methods are -32601', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'resources/list')
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toContain('resources/list')
  })

  it('tools/call protocol misuse is -32602 with the available tool names', async () => {
    const { handler } = setup()
    const noName = await rpc(handler, 'tools/call', {})
    expect(noName.body.error.code).toBe(-32602)

    const unknownTool = await rpc(handler, 'tools/call', { name: 'paint_frame' })
    expect(unknownTool.body.error.code).toBe(-32602)
    expect(unknownTool.body.error.message).toContain('place_clip')

    const badArgs = await rpc(handler, 'tools/call', { name: 'get_clip', arguments: 'clip-intro' })
    expect(badArgs.body.error.code).toBe(-32602)
  })

  it('answers ping', async () => {
    const { handler } = setup()
    const { body } = await rpc(handler, 'ping')
    expect(body.result).toEqual({})
  })
})

describe('buildSequencesMcpServerEntry', () => {
  it('builds the AgentProfileMcpServer-shaped http entry', () => {
    const entry = buildSequencesMcpServerEntry({
      baseUrl: 'https://app.test/',
      path: '/api/sequences/seq-1/mcp',
      token: 'cap_abc',
    })
    expect(entry).toEqual({
      transport: 'http',
      url: 'https://app.test/api/sequences/seq-1/mcp',
      headers: { Authorization: 'Bearer cap_abc', 'Content-Type': 'application/json' },
      enabled: true,
      metadata: { description: DEFAULT_SEQUENCES_MCP_DESCRIPTION },
    })
  })

  it('carries identity headers when a ctx is supplied', () => {
    const entry = buildSequencesMcpServerEntry({
      baseUrl: 'https://app.test',
      path: '/api/sequences/seq-1/mcp',
      token: 'cap_abc',
      description: 'Edit the launch teaser timeline',
      ctx: { userId: 'user-1', workspaceId: 'ws-1', threadId: null },
    })
    expect(entry.headers.Authorization).toBe('Bearer cap_abc')
    expect(entry.headers['X-Agent-App-User-Id']).toBe('user-1')
    expect(entry.headers['X-Agent-App-Workspace-Id']).toBe('ws-1')
    expect(entry.metadata.description).toBe('Edit the launch teaser timeline')
  })

  it('fails closed on a missing token and a relative path', () => {
    expect(() =>
      buildSequencesMcpServerEntry({ baseUrl: 'https://app.test', path: '/mcp', token: '  ' }),
    ).toThrow(/capability token/)
    expect(() =>
      buildSequencesMcpServerEntry({ baseUrl: 'https://app.test', path: 'mcp', token: 'cap_abc' }),
    ).toThrow(/must start with/)
  })
})

// The registry builds its operations from the closed union — a compile-time
// guard that the MCP layer never invents operation shapes.
const _opCheck: SequenceOperation = { type: 'delete_clip', clipId: 'x' }
void _opCheck
