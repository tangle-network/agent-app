import { describe, expect, it } from 'vitest'
import type {
  SequenceClip,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
  SequenceTrackKind,
} from '../../src/sequences/model'
import {
  buildContactSheetManifest,
  buildEdl,
  buildOtio,
  buildSrt,
  buildVtt,
  type OtioClip,
  type OtioGap,
  type OtioTimeline,
} from '../../src/sequences/exports'

function meta(overrides: Partial<SequenceMeta> = {}): SequenceMeta {
  return {
    id: 'seq-1',
    title: 'Launch Teaser',
    fps: 24,
    width: 1920,
    height: 1080,
    aspectRatio: '16:9',
    durationFrames: 24 * 60,
    status: 'active',
    metadata: {},
    ...overrides,
  }
}

function track(id: string, kind: SequenceTrackKind, sortOrder: number, overrides: Partial<SequenceTrack> = {}): SequenceTrack {
  return { id, kind, name: id, sortOrder, locked: false, muted: false, metadata: {}, ...overrides }
}

function clip(
  id: string,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  overrides: Partial<SequenceClip> = {},
): SequenceClip {
  return {
    id,
    trackId,
    label: id,
    startFrame,
    durationFrames,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: false,
    metadata: {},
    ...overrides,
  }
}

function timeline(overrides: Partial<SequenceTimeline> = {}): SequenceTimeline {
  return { sequence: meta(), tracks: [], clips: [], ...overrides }
}

describe('buildSrt', () => {
  it('emits numbered cues with exact 24fps millisecond math, skipping blank and disabled clips', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [
        clip('c1', 'cap', 25, 48, { text: 'Hello world', language: 'en' }),
        clip('c2', 'cap', 100, 24, { text: 'Second line\n\n  with break ', language: 'en' }),
        clip('c3', 'cap', 200, 24, { text: '   ' }),
        clip('c4', 'cap', 300, 24, { text: 'Hidden', disabled: true }),
      ],
    })
    expect(buildSrt(t)).toBe(
      '1\n'
      + '00:00:01,042 --> 00:00:03,042\n'
      + 'Hello world\n'
      + '\n'
      + '2\n'
      + '00:00:04,167 --> 00:00:05,167\n'
      + 'Second line\n'
      + 'with break\n',
    )
  })

  it('rounds the same frame positions differently at 30fps', () => {
    const t = timeline({
      sequence: meta({ fps: 30, durationFrames: 30 * 60 }),
      tracks: [track('cap', 'caption', 0)],
      clips: [clip('c1', 'cap', 25, 48, { text: 'Hello world' })],
    })
    expect(buildSrt(t)).toBe(
      '1\n'
      + '00:00:00,833 --> 00:00:02,433\n'
      + 'Hello world\n',
    )
  })

  it('orders cues by start frame regardless of clip array order', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [
        clip('late', 'cap', 96, 24, { text: 'late' }),
        clip('early', 'cap', 0, 24, { text: 'early' }),
      ],
    })
    const srt = buildSrt(t)
    expect(srt.indexOf('early')).toBeLessThan(srt.indexOf('late'))
    expect(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\nearly')).toBe(true)
  })

  it('filters by language case-insensitively and renumbers from 1', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [
        clip('en1', 'cap', 0, 24, { text: 'hello', language: 'en' }),
        clip('es1', 'cap', 24, 24, { text: 'hola', language: 'es' }),
        clip('none', 'cap', 48, 24, { text: 'untagged' }),
      ],
    })
    const es = buildSrt(t, { language: 'ES' })
    expect(es).toContain('hola')
    expect(es).not.toContain('hello')
    expect(es).not.toContain('untagged')
    expect(es.startsWith('1\n')).toBe(true)
  })

  it('throws when the timeline has no caption clips at all', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [clip('c1', 'v', 0, 24)],
    })
    expect(() => buildSrt(t)).toThrow(/no caption clips/)
  })

  it('throws naming the language when no captions match the filter', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [clip('en1', 'cap', 0, 24, { text: 'hello', language: 'en' })],
    })
    expect(() => buildSrt(t, { language: 'fr' })).toThrow(/language 'fr'/)
  })

  it('ignores text-bearing clips that sit on non-caption tracks', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0), track('cap', 'caption', 1)],
      clips: [
        clip('v1', 'v', 0, 24, { text: 'not a caption' }),
        clip('c1', 'cap', 0, 24, { text: 'real caption' }),
      ],
    })
    const srt = buildSrt(t)
    expect(srt).toContain('real caption')
    expect(srt).not.toContain('not a caption')
  })
})

describe('buildVtt', () => {
  it('emits a WEBVTT header and dot-separated milliseconds', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [clip('c1', 'cap', 25, 48, { text: 'Hello world' })],
    })
    expect(buildVtt(t)).toBe(
      'WEBVTT\n'
      + '\n'
      + '1\n'
      + '00:00:01.042 --> 00:00:03.042\n'
      + 'Hello world\n',
    )
  })

  it('throws on a captionless timeline', () => {
    expect(() => buildVtt(timeline())).toThrow(/no caption clips/)
  })
})

describe('buildEdl', () => {
  it('emits CMX3600 events with source in/out from sourceInFrame and record in/out from startFrame', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [
        clip('opening shot', 'v', 24, 48, {
          label: 'opening shot',
          sourceInFrame: 12,
          media: { url: 'https://cdn.example/opening.mp4', kind: 'video' },
        }),
      ],
    })
    expect(buildEdl(t)).toBe(
      'TITLE: Launch Teaser\n'
      + 'FCM: NON-DROP FRAME\n'
      + '\n'
      + '001  AX       V     C        00:00:00:12 00:00:02:12 00:00:01:00 00:00:03:00\n'
      + '* FROM CLIP NAME: opening shot\n'
      + '* SOURCE FILE: https://cdn.example/opening.mp4\n',
    )
  })

  it('numbers video and audio events in record-start order with the right channel codes', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0), track('a', 'audio', 1)],
      clips: [
        clip('music', 'a', 0, 96),
        clip('shot', 'v', 24, 48),
      ],
    })
    const lines = buildEdl(t).split('\n')
    const events = lines.filter((line) => /^\d{3} {2}AX/.test(line))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatch(/^001 {2}AX {7}A {5}C/)
    expect(events[1]).toMatch(/^002 {2}AX {7}V {5}C/)
  })

  it('uses fps-aware frame fields in timecodes', () => {
    const t = timeline({
      sequence: meta({ fps: 30, durationFrames: 30 * 60 }),
      tracks: [track('v', 'video', 0)],
      clips: [clip('shot', 'v', 29, 31)],
    })
    // record in: frame 29 at 30fps = 00:00:00:29; record out: frame 60 = 00:00:02:00
    expect(buildEdl(t)).toContain('00:00:00:00 00:00:01:01 00:00:00:29 00:00:02:00')
  })

  it('excludes disabled clips and caption/reference/agent tracks', () => {
    const t = timeline({
      tracks: [
        track('v', 'video', 0),
        track('cap', 'caption', 1),
        track('ref', 'reference', 2),
        track('ag', 'agent', 3),
      ],
      clips: [
        clip('kept', 'v', 0, 24),
        clip('off', 'v', 24, 24, { disabled: true }),
        clip('cue', 'cap', 0, 24, { text: 'cue' }),
        clip('guide', 'ref', 0, 24),
        clip('marker', 'ag', 0, 24),
      ],
    })
    const edl = buildEdl(t)
    expect(edl).toContain('FROM CLIP NAME: kept')
    expect(edl).not.toContain('off')
    expect(edl).not.toContain('cue')
    expect(edl).not.toContain('guide')
    expect(edl).not.toContain('marker')
  })

  it('throws when there are no video or audio clips', () => {
    const t = timeline({
      tracks: [track('cap', 'caption', 0)],
      clips: [clip('cue', 'cap', 0, 24, { text: 'cue' })],
    })
    expect(() => buildEdl(t)).toThrow(/no enabled video or audio clips/)
  })
})

describe('buildOtio', () => {
  function fixture(): SequenceTimeline {
    return timeline({
      tracks: [
        track('v', 'video', 0, { name: 'Video 1' }),
        track('a', 'audio', 1, { name: 'Audio 1' }),
        track('cap', 'caption', 2, { name: 'Captions' }),
        track('ag', 'agent', 3, { name: 'Agent' }),
      ],
      clips: [
        clip('shot', 'v', 48, 72, {
          sourceInFrame: 10,
          media: { url: 'https://cdn.example/shot.mp4', kind: 'video', durationSeconds: 10 },
        }),
        clip('vo', 'a', 0, 96),
        clip('cue', 'cap', 48, 48, { text: 'hello', language: 'en' }),
        clip('marker', 'ag', 0, 24),
      ],
    })
  }

  it('survives a JSON round-trip as a Timeline.1 document', () => {
    const doc = JSON.parse(JSON.stringify(buildOtio(fixture()))) as OtioTimeline
    expect(doc.OTIO_SCHEMA).toBe('Timeline.1')
    expect(doc.name).toBe('Launch Teaser')
    expect(doc.tracks.OTIO_SCHEMA).toBe('Stack.1')
    expect(doc.global_start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 })
    expect(doc.metadata.fps).toBe(24)
    expect(doc.metadata.width).toBe(1920)
  })

  it('maps track kinds, preserves the original kind in metadata, and drops agent tracks', () => {
    const doc = buildOtio(fixture())
    expect(doc.tracks.children.map((t) => t.kind)).toEqual(['Video', 'Audio', 'Video'])
    expect(doc.tracks.children.map((t) => t.metadata.sequenceTrackKind)).toEqual(['video', 'audio', 'caption'])
    expect(doc.tracks.children.map((t) => t.name)).toEqual(['Video 1', 'Audio 1', 'Captions'])
  })

  it('inserts Gap children so clip record positions survive sequential layout', () => {
    const doc = buildOtio(fixture())
    const video = doc.tracks.children[0]
    expect(video).toBeDefined()
    const [gap, shot] = video!.children as [OtioGap, OtioClip]
    expect(gap.OTIO_SCHEMA).toBe('Gap.1')
    expect(gap.source_range.duration).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 48 })
    expect(shot.OTIO_SCHEMA).toBe('Clip.2')
    expect(shot.source_range.start_time.value).toBe(10)
    expect(shot.source_range.duration.value).toBe(72)
    expect(shot.source_range.duration.rate).toBe(24)
    // audio track starts at frame 0 — no leading gap
    expect(doc.tracks.children[1]!.children[0]!.OTIO_SCHEMA).toBe('Clip.2')
  })

  it('emits ExternalReference with available_range for resolved media, MissingReference otherwise', () => {
    const doc = buildOtio(fixture())
    const shot = doc.tracks.children[0]!.children[1] as OtioClip
    expect(shot.media_reference).toEqual({
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: 'https://cdn.example/shot.mp4',
      available_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 },
        duration: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 240 },
      },
    })
    const vo = doc.tracks.children[1]!.children[0] as OtioClip
    expect(vo.media_reference).toEqual({ OTIO_SCHEMA: 'MissingReference.1' })
  })

  it('carries caption text and language into clip metadata', () => {
    const doc = buildOtio(fixture())
    const cueTrack = doc.tracks.children[2]!
    const cue = cueTrack.children.find((child): child is OtioClip => child.OTIO_SCHEMA === 'Clip.2')
    expect(cue?.metadata.text).toBe('hello')
    expect(cue?.metadata.language).toBe('en')
  })

  it('throws on overlapping enabled clips — unrepresentable in a sequential track', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [
        clip('first', 'v', 0, 48),
        clip('second', 'v', 24, 48),
      ],
    })
    expect(() => buildOtio(t)).toThrow(/overlaps the previous clip/)
  })

  it('treats disabled clips as gaps rather than overlaps', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [
        clip('off', 'v', 0, 48, { disabled: true }),
        clip('on', 'v', 24, 48),
      ],
    })
    const doc = buildOtio(t)
    const children = doc.tracks.children[0]!.children
    expect(children).toHaveLength(2)
    expect(children[0]!.OTIO_SCHEMA).toBe('Gap.1')
    expect((children[0] as OtioGap).source_range.duration.value).toBe(24)
  })
})

describe('buildContactSheetManifest', () => {
  it('samples the midpoint of each enabled video clip with completed media', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [
        clip('shot-a', 'v', 0, 48, {
          sourceInFrame: 12,
          media: { url: 'https://cdn.example/a.mp4', kind: 'video', providerStatus: 'completed' },
        }),
        clip('still-b', 'v', 48, 24, {
          sourceInFrame: 99,
          media: { url: 'https://cdn.example/b.png', kind: 'image' },
        }),
      ],
    })
    const manifest = buildContactSheetManifest(t)
    expect(manifest.sequenceId).toBe('seq-1')
    expect(manifest.fps).toBe(24)
    expect(manifest.width).toBe(1920)
    expect(manifest.entries).toEqual([
      {
        clipId: 'shot-a',
        trackId: 'v',
        label: 'shot-a',
        frame: 24,
        timecode: '0:01.00',
        sourceFrame: 36,
        sourceSeconds: 1.5,
        url: 'https://cdn.example/a.mp4',
        mediaKind: 'video',
      },
      {
        clipId: 'still-b',
        trackId: 'v',
        label: 'still-b',
        frame: 60,
        timecode: '0:02.12',
        sourceFrame: 0,
        sourceSeconds: 0,
        url: 'https://cdn.example/b.png',
        mediaKind: 'image',
      },
    ])
  })

  it('excludes disabled clips, unresolved media, and in-flight provider jobs', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [
        clip('ready', 'v', 0, 24, { media: { url: 'https://cdn.example/ready.mp4', kind: 'video' } }),
        clip('off', 'v', 24, 24, {
          disabled: true,
          media: { url: 'https://cdn.example/off.mp4', kind: 'video' },
        }),
        clip('no-media', 'v', 48, 24),
        clip('rendering', 'v', 72, 24, {
          media: { url: 'https://cdn.example/rendering.mp4', kind: 'video', providerStatus: 'processing' },
        }),
      ],
    })
    const manifest = buildContactSheetManifest(t)
    expect(manifest.entries.map((entry) => entry.clipId)).toEqual(['ready'])
  })

  it('throws when nothing is sampleable', () => {
    const t = timeline({
      tracks: [track('v', 'video', 0)],
      clips: [clip('no-media', 'v', 0, 24)],
    })
    expect(() => buildContactSheetManifest(t)).toThrow(/no sampleable video clips/)
  })
})
