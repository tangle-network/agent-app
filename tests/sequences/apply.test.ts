import { describe, expect, it } from 'vitest'
import { applySequenceOperation } from '../../src/sequences/apply'
import { captionTrackNameForLanguage } from '../../src/sequences/validate'
import { createMemoryStore, makeClip, makeTimeline, makeTrack } from './fixtures'

const ctx = { playheadFrame: 0 }

function baseSetup() {
  const timeline = makeTimeline({
    fps: 30,
    durationFrames: 600,
    tracks: [
      makeTrack({ id: 'v1', kind: 'video', sortOrder: 0 }),
      makeTrack({ id: 'a1', kind: 'audio', sortOrder: 1 }),
      makeTrack({ id: 'c1', kind: 'caption', sortOrder: 2 }),
    ],
    clips: [
      makeClip({
        id: 'clip-a',
        trackId: 'v1',
        startFrame: 100,
        durationFrames: 80,
        sourceInFrame: 10,
        generationId: 'gen-1',
        metadata: { origin: 'test' },
      }),
      makeClip({ id: 'clip-cap', trackId: 'c1', startFrame: 100, durationFrames: 60, text: 'hello' }),
    ],
  })
  return { timeline, store: createMemoryStore(timeline) }
}

describe('place_clip', () => {
  it('creates the clip on the auto-resolved track with the media ref in metadata', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'place_clip',
      label: 'b-roll',
      startFrame: 200,
      durationFrames: 150,
      media: { url: 'https://cdn.example.com/v.mp4', kind: 'video' },
      metadata: { prompt: 'city at night' },
    }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.trackId).toBe('v1')
    expect(result.clip.startFrame).toBe(200)
    expect(result.clip.durationFrames).toBe(150)
    expect(result.clip.sourceInFrame).toBe(0)
    expect(result.clip.metadata).toEqual({
      prompt: 'city at night',
      media: { url: 'https://cdn.example.com/v.mp4', kind: 'video' },
    })
    expect(timeline.clips.some((clip) => clip.id === result.clip.id)).toBe(true)
  })

  it('routes audio media to the audio track', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'place_clip',
      label: 'vo',
      startFrame: 0,
      durationFrames: 60,
      media: { url: '/api/media/vo-1', kind: 'audio' },
    }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.trackId).toBe('a1')
  })
})

describe('add_caption placement', () => {
  it('places at the playhead with the fps*3 default when the caption track is clear there', async () => {
    const timeline = makeTimeline({
      fps: 30,
      durationFrames: 600,
      tracks: [makeTrack({ id: 'v1', kind: 'video' }), makeTrack({ id: 'c1', kind: 'caption' })],
      // A video clip overlapping the playhead must NOT slide the caption —
      // collision intervals come from the target caption track only.
      clips: [makeClip({ id: 'vid', trackId: 'v1', startFrame: 40, durationFrames: 40 })],
    })
    const store = createMemoryStore(timeline)
    const result = await applySequenceOperation(store, timeline, { type: 'add_caption', text: 'hello world' }, { playheadFrame: 45 })
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.trackId).toBe('c1')
    expect(result.clip.startFrame).toBe(45)
    expect(result.clip.durationFrames).toBe(90)
    expect(result.clip.text).toBe('hello world')
    expect(result.clip.sourceInFrame).toBe(0)
  })

  it('slides past an occupied caption interval at the playhead', async () => {
    const timeline = makeTimeline({
      fps: 30,
      durationFrames: 600,
      tracks: [makeTrack({ id: 'c1', kind: 'caption' })],
      clips: [makeClip({ id: 'cap-1', trackId: 'c1', startFrame: 100, durationFrames: 60, text: 'first' })],
    })
    const store = createMemoryStore(timeline)
    const result = await applySequenceOperation(store, timeline, { type: 'add_caption', text: 'second' }, { playheadFrame: 120 })
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.startFrame).toBe(160)
    expect(result.clip.durationFrames).toBe(90)
  })

  it('honors explicit placement without sliding', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'add_caption',
      text: 'pinned',
      startFrame: 300,
      durationFrames: 45,
    }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.startFrame).toBe(300)
    expect(result.clip.durationFrames).toBe(45)
  })
})

describe('add_caption per-language tracks', () => {
  it('creates a named caption track for an unseen language and reuses it next time', async () => {
    const { timeline, store } = baseSetup()
    const first = await applySequenceOperation(store, timeline, { type: 'add_caption', text: 'hola', language: 'es' }, ctx)
    if (first.kind !== 'clip') throw new Error(`expected clip result, got ${first.kind}`)
    const created = timeline.tracks.find((track) => track.id === first.clip.trackId)
    expect(created).toMatchObject({ kind: 'caption', name: captionTrackNameForLanguage('es') })
    expect(created?.id).not.toBe('c1')
    expect(first.clip.language).toBe('es')

    const captionTrackCount = timeline.tracks.filter((track) => track.kind === 'caption').length
    const second = await applySequenceOperation(store, timeline, { type: 'add_caption', text: 'adiós', language: 'es' }, ctx)
    if (second.kind !== 'clip') throw new Error(`expected clip result, got ${second.kind}`)
    expect(second.clip.trackId).toBe(first.clip.trackId)
    expect(timeline.tracks.filter((track) => track.kind === 'caption').length).toBe(captionTrackCount)
  })

  it('reuses a track whose metadata.language matches even when named differently', async () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'cja', kind: 'caption', name: 'Japanese subs', metadata: { language: 'ja' } })],
    })
    const store = createMemoryStore(timeline)
    const result = await applySequenceOperation(store, timeline, { type: 'add_caption', text: 'こんにちは', language: 'ja' }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.trackId).toBe('cja')
    expect(timeline.tracks).toHaveLength(1)
  })
})

describe('split_clip', () => {
  it('shortens the original to the cut and creates a source-shifted second half', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, { type: 'split_clip', clipId: 'clip-a', atFrame: 130 }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)

    const first = timeline.clips.find((clip) => clip.id === 'clip-a')
    expect(first).toMatchObject({ startFrame: 100, durationFrames: 30, sourceInFrame: 10, sourceOutFrame: 40 })

    expect(result.clip.id).not.toBe('clip-a')
    expect(result.clip).toMatchObject({
      trackId: 'v1',
      label: 'clip-a',
      startFrame: 130,
      durationFrames: 50,
      sourceInFrame: 40,
      sourceOutFrame: null,
      generationId: 'gen-1',
      metadata: { origin: 'test' },
    })
  })

  it('preserves the disabled state on the second half', async () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'v1', kind: 'video' })],
      clips: [makeClip({ id: 'off', trackId: 'v1', startFrame: 0, durationFrames: 40, disabled: true })],
    })
    const store = createMemoryStore(timeline)
    const result = await applySequenceOperation(store, timeline, { type: 'split_clip', clipId: 'off', atFrame: 25 }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.disabled).toBe(true)
  })
})

describe('clip patch operations', () => {
  it('move_clip updates startFrame and trackId', async () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'v1', kind: 'video', sortOrder: 0 }), makeTrack({ id: 'v2', kind: 'video', sortOrder: 1 })],
      clips: [makeClip({ id: 'clip-a', trackId: 'v1', startFrame: 100, durationFrames: 80 })],
    })
    const store = createMemoryStore(timeline)
    const result = await applySequenceOperation(store, timeline, { type: 'move_clip', clipId: 'clip-a', startFrame: 250, trackId: 'v2' }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip).toMatchObject({ id: 'clip-a', startFrame: 250, trackId: 'v2' })
  })

  it('trim_clip updates start, duration, and source in-point', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'trim_clip',
      clipId: 'clip-a',
      startFrame: 110,
      durationFrames: 40,
      sourceInFrame: 20,
    }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip).toMatchObject({ startFrame: 110, durationFrames: 40, sourceInFrame: 20 })
  })

  it('set_clip_text updates text, label, and language', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'set_clip_text',
      clipId: 'clip-cap',
      text: 'updated caption',
      language: 'en',
    }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip).toMatchObject({ text: 'updated caption', label: 'updated caption', language: 'en' })
  })

  it('set_clip_disabled toggles the flag', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, { type: 'set_clip_disabled', clipId: 'clip-a', disabled: true }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.disabled).toBe(true)
  })

  it('delete_clip removes the clip and returns its snapshot', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, { type: 'delete_clip', clipId: 'clip-cap' }, ctx)
    if (result.kind !== 'clip') throw new Error(`expected clip result, got ${result.kind}`)
    expect(result.clip.id).toBe('clip-cap')
    expect(result.clip.text).toBe('hello')
    expect(timeline.clips.some((clip) => clip.id === 'clip-cap')).toBe(false)
  })
})

describe('track / sequence / export operations', () => {
  it('create_track returns the new track', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, { type: 'create_track', kind: 'reference', name: 'Guide' }, ctx)
    if (result.kind !== 'track') throw new Error(`expected track result, got ${result.kind}`)
    expect(result.track).toMatchObject({ kind: 'reference', name: 'Guide' })
    expect(timeline.tracks.some((track) => track.id === result.track.id)).toBe(true)
  })

  it('extend_sequence returns the sequence with the new duration', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, { type: 'extend_sequence', durationFrames: 1200 }, ctx)
    if (result.kind !== 'sequence') throw new Error(`expected sequence result, got ${result.kind}`)
    expect(result.sequence.durationFrames).toBe(1200)
    expect(timeline.sequence.durationFrames).toBe(1200)
  })

  it('queue_export returns the queued record with metadata passed through', async () => {
    const { timeline, store } = baseSetup()
    const result = await applySequenceOperation(store, timeline, {
      type: 'queue_export',
      format: 'srt',
      metadata: { burnIn: false },
    }, ctx)
    if (result.kind !== 'export') throw new Error(`expected export result, got ${result.kind}`)
    expect(result.record).toMatchObject({ format: 'srt', status: 'queued', metadata: { burnIn: false } })
    expect(store.exports).toHaveLength(1)
  })
})

describe('apply re-validates before touching the store', () => {
  it('rejects an invalid operation without mutating state', async () => {
    const { timeline, store } = baseSetup()
    const clipCount = timeline.clips.length
    await expect(applySequenceOperation(store, timeline, { type: 'move_clip', clipId: 'missing', startFrame: 0 }, ctx))
      .rejects.toThrow('references unknown clip missing')
    expect(timeline.clips).toHaveLength(clipCount)
    expect(store.exports).toHaveLength(0)
  })

  it('rejects a locked-track caption target without creating clips', async () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'c1', kind: 'caption', locked: true })],
    })
    const store = createMemoryStore(timeline)
    await expect(applySequenceOperation(store, timeline, { type: 'add_caption', text: 'hi', trackId: 'c1' }, ctx))
      .rejects.toThrow('targets locked track')
    expect(timeline.clips).toHaveLength(0)
  })
})
