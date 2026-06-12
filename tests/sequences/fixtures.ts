import type {
  SequenceClip,
  SequenceDecision,
  SequenceExportRecord,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
} from '../../src/sequences/model'
import type { SequenceStore } from '../../src/sequences/store'

export function makeTrack(input: Partial<SequenceTrack> & Pick<SequenceTrack, 'id' | 'kind'>): SequenceTrack {
  return {
    name: input.id,
    sortOrder: 0,
    locked: false,
    muted: false,
    metadata: {},
    ...input,
  }
}

export function makeClip(
  input: Partial<SequenceClip> & Pick<SequenceClip, 'id' | 'trackId' | 'startFrame' | 'durationFrames'>,
): SequenceClip {
  return {
    label: input.id,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: false,
    metadata: {},
    ...input,
  }
}

export function makeTimeline(input: {
  fps?: number
  durationFrames?: number
  tracks: SequenceTrack[]
  clips?: SequenceClip[]
}): SequenceTimeline {
  const sequence: SequenceMeta = {
    id: 'seq-1',
    title: 'Test sequence',
    fps: input.fps ?? 30,
    width: 1920,
    height: 1080,
    aspectRatio: '16:9',
    durationFrames: input.durationFrames ?? 600,
    status: 'active',
    metadata: {},
  }
  return { sequence, tracks: input.tracks, clips: input.clips ?? [] }
}

export interface MemorySequenceStore extends SequenceStore {
  timeline: SequenceTimeline
  exports: SequenceExportRecord[]
  decisions: SequenceDecision[]
}

/** In-memory `SequenceStore` over a mutable timeline. Mutates the SAME object
 *  callers hold, mirroring a dispatcher that re-fetches between operations. */
export function createMemoryStore(timeline: SequenceTimeline): MemorySequenceStore {
  let counter = 0
  const nextId = (prefix: string) => `${prefix}-${++counter}`
  const exports: SequenceExportRecord[] = []
  const decisions: SequenceDecision[] = []

  const findClip = (clipId: string): SequenceClip => {
    const clip = timeline.clips.find((candidate) => candidate.id === clipId)
    if (!clip) throw new Error(`memory store: clip ${clipId} not found`)
    return clip
  }

  return {
    timeline,
    exports,
    decisions,
    async getTimeline() {
      return timeline
    },
    async getClip(clipId) {
      return findClip(clipId)
    },
    async createTrack(input) {
      const track: SequenceTrack = {
        id: nextId('track'),
        kind: input.kind,
        name: input.name,
        sortOrder: input.sortOrder ?? timeline.tracks.length,
        locked: false,
        muted: false,
        metadata: {},
      }
      timeline.tracks.push(track)
      return track
    },
    async createClip(input) {
      const clip: SequenceClip = {
        id: nextId('clip'),
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
        metadata: input.metadata ?? {},
      }
      timeline.clips.push(clip)
      return clip
    },
    async updateClip(clipId, patch) {
      const clip = findClip(clipId)
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (clip as unknown as Record<string, unknown>)[key] = value
      }
      return clip
    },
    async deleteClip(clipId) {
      const index = timeline.clips.findIndex((candidate) => candidate.id === clipId)
      if (index < 0) throw new Error(`memory store: clip ${clipId} not found`)
      timeline.clips.splice(index, 1)
    },
    async updateSequenceDuration(durationFrames) {
      timeline.sequence.durationFrames = durationFrames
      return timeline.sequence
    },
    async recordDecision(input) {
      const decision: SequenceDecision = {
        id: nextId('decision'),
        clipId: input.clipId ?? null,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        accepted: input.accepted ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      }
      decisions.push(decision)
      return decision
    },
    async createExport(format, metadata) {
      const record: SequenceExportRecord = {
        id: nextId('export'),
        format,
        status: 'queued',
        resultUrl: null,
        metadata: metadata ?? {},
        createdAt: new Date(),
      }
      exports.push(record)
      return record
    },
    async listDecisions(limit) {
      return limit === undefined ? decisions : decisions.slice(0, limit)
    },
    async listExports(limit) {
      return limit === undefined ? exports : exports.slice(0, limit)
    },
  }
}
