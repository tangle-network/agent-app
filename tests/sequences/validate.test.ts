import { describe, expect, it } from 'vitest'
import type { SequenceOperation } from '../../src/sequences/operations'
import {
  assertSequenceMediaUrl,
  captionTrackNameForLanguage,
  lastClipEndFrame,
  resolveCaptionTarget,
  validateSequenceOperations,
} from '../../src/sequences/validate'
import { makeClip, makeTimeline, makeTrack } from './fixtures'

const ctx = { playheadFrame: 0 }

function baseTimeline() {
  return makeTimeline({
    fps: 30,
    durationFrames: 600,
    tracks: [
      makeTrack({ id: 'v1', kind: 'video', sortOrder: 0 }),
      makeTrack({ id: 'a1', kind: 'audio', sortOrder: 1 }),
      makeTrack({ id: 'c1', kind: 'caption', sortOrder: 2 }),
      makeTrack({ id: 'r1', kind: 'reference', sortOrder: 3 }),
      makeTrack({ id: 'vl', kind: 'video', sortOrder: 4, locked: true }),
    ],
    clips: [
      makeClip({ id: 'clip-a', trackId: 'v1', startFrame: 100, durationFrames: 80, sourceInFrame: 10, generationId: 'gen-1' }),
      makeClip({ id: 'clip-cap', trackId: 'c1', startFrame: 100, durationFrames: 60, text: 'hello' }),
      makeClip({ id: 'clip-locked', trackId: 'vl', startFrame: 0, durationFrames: 30 }),
    ],
  })
}

function check(operations: SequenceOperation[], playheadFrame = 0) {
  return () => validateSequenceOperations(baseTimeline(), operations, { playheadFrame })
}

describe('validateSequenceOperations error shape', () => {
  it('prefixes errors with the 1-based operation index and type', () => {
    expect(check([
      { type: 'place_clip', trackId: 'v1', label: 'ok', startFrame: 0, durationFrames: 30 },
      { type: 'move_clip', clipId: 'missing', startFrame: 0 },
    ])).toThrow('operation 2 (move_clip): references unknown clip missing')
  })

  it('rejects runtime-junk operation types', () => {
    const junk = { type: 'explode' } as unknown as SequenceOperation
    expect(check([junk])).toThrow('operation 1 (explode): unsupported operation type "explode"')
  })

  it('rejects a non-integer playhead', () => {
    expect(check([{ type: 'add_caption', text: 'hi' }], 1.5)).toThrow('playheadFrame must be a non-negative integer')
  })
})

describe('place_clip', () => {
  it('accepts an explicit video track with video media', () => {
    expect(check([{
      type: 'place_clip',
      trackId: 'v1',
      label: 'shot',
      startFrame: 0,
      durationFrames: 150,
      media: { url: 'https://cdn.example.com/v.mp4', kind: 'video' },
    }])).not.toThrow()
  })

  it('accepts an explicit reference track for guide media', () => {
    expect(check([{
      type: 'place_clip',
      trackId: 'r1',
      label: 'guide',
      startFrame: 0,
      durationFrames: 30,
      media: { url: 'https://cdn.example.com/g.mp4', kind: 'video' },
    }])).not.toThrow()
  })

  it('auto-picks the first unlocked track matching the media kind', () => {
    const timeline = makeTimeline({
      tracks: [
        makeTrack({ id: 'vl', kind: 'video', sortOrder: 0, locked: true }),
        makeTrack({ id: 'v2', kind: 'video', sortOrder: 1 }),
      ],
    })
    expect(() => validateSequenceOperations(timeline, [{
      type: 'place_clip',
      label: 'shot',
      startFrame: 0,
      durationFrames: 30,
      media: { url: 'https://cdn.example.com/v.mp4', kind: 'video' },
    }], ctx)).not.toThrow()
  })

  it('rejects when no unlocked track matches the media kind', () => {
    const timeline = makeTimeline({ tracks: [makeTrack({ id: 'vl', kind: 'video', locked: true })] })
    expect(() => validateSequenceOperations(timeline, [{
      type: 'place_clip',
      label: 'shot',
      startFrame: 0,
      durationFrames: 30,
      media: { url: 'https://cdn.example.com/v.mp4', kind: 'video' },
    }], ctx)).toThrow('operation 1 (place_clip): requires an unlocked video track and the sequence has none')
  })

  it('rejects a locked explicit track', () => {
    expect(check([{ type: 'place_clip', trackId: 'vl', label: 'shot', startFrame: 0, durationFrames: 30 }]))
      .toThrow('targets locked track')
  })

  it('rejects unknown trackId', () => {
    expect(check([{ type: 'place_clip', trackId: 'nope', label: 'shot', startFrame: 0, durationFrames: 30 }]))
      .toThrow('references unknown track nope')
  })

  it('rejects media-kind / track-kind mismatch', () => {
    expect(check([{
      type: 'place_clip',
      trackId: 'v1',
      label: 'vo',
      startFrame: 0,
      durationFrames: 30,
      media: { url: 'https://cdn.example.com/vo.mp3', kind: 'audio' },
    }])).toThrow('media kind audio requires a audio or reference track; track v1 is video')
  })

  it('rejects caption tracks', () => {
    expect(check([{ type: 'place_clip', trackId: 'c1', label: 'x', startFrame: 0, durationFrames: 30 }]))
      .toThrow('cannot target caption track c1; use add_caption')
  })

  it('rejects omitted trackId with no media to infer from', () => {
    expect(check([{ type: 'place_clip', label: 'x', startFrame: 0, durationFrames: 30 }]))
      .toThrow('requires trackId when media is omitted')
  })

  it('rejects clips extending beyond the sequence', () => {
    expect(check([{ type: 'place_clip', trackId: 'v1', label: 'x', startFrame: 590, durationFrames: 30 }]))
      .toThrow('operation 1 (place_clip): clip [start=590 duration=30] in a 600-frame sequence: extends beyond the sequence duration')
  })

  it('rejects a negative sourceInFrame', () => {
    expect(check([{ type: 'place_clip', trackId: 'v1', label: 'x', startFrame: 0, durationFrames: 30, sourceInFrame: -1 }]))
      .toThrow('sourceInFrame must be a non-negative integer')
  })

  it('rejects an empty label', () => {
    expect(check([{ type: 'place_clip', trackId: 'v1', label: '  ', startFrame: 0, durationFrames: 30 }]))
      .toThrow('label must be non-empty')
  })
})

describe('place_clip media url boundary', () => {
  it.each([
    'file:///sandbox/out.mp4',
    'data:video/mp4;base64,AAAA',
    '/tmp/render.mp4',
    '/home/agent/render.mp4',
  ])('rejects local sandbox reference %s', (url) => {
    expect(() => assertSequenceMediaUrl(url)).toThrow('not a local sandbox file')
  })

  it('rejects relative paths', () => {
    expect(() => assertSequenceMediaUrl('clips/out.mp4')).toThrow('media url must be http(s) or a rooted /api/ path')
  })

  it.each([
    'https://cdn.example.com/v.mp4',
    'http://localhost:8787/v.mp4',
    '/api/media/abc123',
  ])('accepts %s', (url) => {
    expect(() => assertSequenceMediaUrl(url)).not.toThrow()
  })
})

describe('add_caption', () => {
  it('accepts auto placement on the caption track', () => {
    expect(check([{ type: 'add_caption', text: 'hello world' }], 45)).not.toThrow()
  })

  it('rejects empty text', () => {
    expect(check([{ type: 'add_caption', text: '   ' }])).toThrow('text must be non-empty')
  })

  it('rejects a non-caption explicit track', () => {
    expect(check([{ type: 'add_caption', text: 'hi', trackId: 'v1' }]))
      .toThrow('targets video track v1; captions require a caption track')
  })

  it('rejects when no caption track exists and no language is given', () => {
    const timeline = makeTimeline({ tracks: [makeTrack({ id: 'v1', kind: 'video' })] })
    expect(() => validateSequenceOperations(timeline, [{ type: 'add_caption', text: 'hi' }], ctx))
      .toThrow('requires an unlocked caption track and the sequence has none')
  })

  it('accepts a missing per-language track because apply auto-creates it', () => {
    const timeline = makeTimeline({ tracks: [makeTrack({ id: 'v1', kind: 'video' })] })
    expect(() => validateSequenceOperations(timeline, [{ type: 'add_caption', text: 'hola', language: 'es' }], ctx))
      .not.toThrow()
  })

  it('rejects a locked per-language track instead of creating a duplicate', () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'ces', kind: 'caption', name: captionTrackNameForLanguage('es'), locked: true })],
    })
    expect(() => validateSequenceOperations(timeline, [{ type: 'add_caption', text: 'hola', language: 'es' }], ctx))
      .toThrow('caption track for language "es" is locked')
  })

  it('rejects malformed language tags', () => {
    expect(check([{ type: 'add_caption', text: 'hi', language: 'not a tag!' }]))
      .toThrow('language must be a BCP-47-style tag')
  })

  it('rejects explicit placement beyond the sequence', () => {
    expect(check([{ type: 'add_caption', text: 'hi', startFrame: 580, durationFrames: 90 }]))
      .toThrow('extends beyond the sequence duration')
  })

  it('matches existing language tracks via metadata.language', () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'cja', kind: 'caption', name: 'Japanese subs', metadata: { language: 'ja' } })],
    })
    const target = resolveCaptionTarget(timeline, { type: 'add_caption', text: 'こんにちは', language: 'ja' })
    expect(target).toEqual({ kind: 'existing', track: timeline.tracks[0] })
  })
})

describe('move_clip', () => {
  it('rejects unknown clip', () => {
    expect(check([{ type: 'move_clip', clipId: 'nope', startFrame: 0 }])).toThrow('references unknown clip nope')
  })

  it('rejects when the clip sits on a locked track', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-locked', startFrame: 10 }]))
      .toThrow('clip clip-locked sits on locked track')
  })

  it('rejects unknown destination track', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-a', startFrame: 0, trackId: 'nope' }]))
      .toThrow('references unknown track nope')
  })

  it('rejects a locked destination track', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-a', startFrame: 0, trackId: 'vl' }]))
      .toThrow('targets locked track')
  })

  it('rejects cross-kind moves', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-a', startFrame: 0, trackId: 'a1' }]))
      .toThrow('moves a video clip to a audio track (a1)')
  })

  it('rejects moves that push the clip past the sequence end', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-a', startFrame: 560 }]))
      .toThrow('extends beyond the sequence duration')
  })

  it('accepts an in-bounds same-kind move', () => {
    expect(check([{ type: 'move_clip', clipId: 'clip-a', startFrame: 200 }])).not.toThrow()
  })
})

describe('trim_clip', () => {
  it('rejects unknown clip', () => {
    expect(check([{ type: 'trim_clip', clipId: 'nope', startFrame: 0, durationFrames: 10 }]))
      .toThrow('references unknown clip nope')
  })

  it('rejects out-of-bounds start+duration', () => {
    expect(check([{ type: 'trim_clip', clipId: 'clip-a', startFrame: 590, durationFrames: 20 }]))
      .toThrow('extends beyond the sequence duration')
  })

  it('rejects zero duration', () => {
    expect(check([{ type: 'trim_clip', clipId: 'clip-a', startFrame: 100, durationFrames: 0 }]))
      .toThrow('durationFrames must be a positive integer')
  })

  it('rejects a negative sourceInFrame', () => {
    expect(check([{ type: 'trim_clip', clipId: 'clip-a', startFrame: 100, durationFrames: 40, sourceInFrame: -3 }]))
      .toThrow('sourceInFrame must be a non-negative integer')
  })

  it('accepts a valid trim', () => {
    expect(check([{ type: 'trim_clip', clipId: 'clip-a', startFrame: 110, durationFrames: 40, sourceInFrame: 20 }]))
      .not.toThrow()
  })
})

describe('split_clip', () => {
  it('rejects atFrame at the clip start', () => {
    expect(check([{ type: 'split_clip', clipId: 'clip-a', atFrame: 100 }]))
      .toThrow('atFrame 100 must fall strictly inside clip clip-a (valid range 101..179)')
  })

  it('rejects atFrame at the clip end', () => {
    expect(check([{ type: 'split_clip', clipId: 'clip-a', atFrame: 180 }])).toThrow('must fall strictly inside')
  })

  it('rejects atFrame outside the clip', () => {
    expect(check([{ type: 'split_clip', clipId: 'clip-a', atFrame: 50 }])).toThrow('must fall strictly inside')
  })

  it('rejects splitting a 1-frame clip', () => {
    const timeline = makeTimeline({
      tracks: [makeTrack({ id: 'v1', kind: 'video' })],
      clips: [makeClip({ id: 'tiny', trackId: 'v1', startFrame: 0, durationFrames: 1 })],
    })
    expect(() => validateSequenceOperations(timeline, [{ type: 'split_clip', clipId: 'tiny', atFrame: 1 }], ctx))
      .toThrow('tiny is 1 frame(s) long; splitting needs at least 2 frames')
  })

  it('accepts a strictly interior cut', () => {
    expect(check([{ type: 'split_clip', clipId: 'clip-a', atFrame: 130 }])).not.toThrow()
  })
})

describe('set_clip_text', () => {
  it('rejects clips on non-caption tracks', () => {
    expect(check([{ type: 'set_clip_text', clipId: 'clip-a', text: 'nope' }]))
      .toThrow('targets a clip on a video track; text edits apply only to caption clips')
  })

  it('rejects empty text', () => {
    expect(check([{ type: 'set_clip_text', clipId: 'clip-cap', text: ' ' }]))
      .toThrow('text must be non-empty; use delete_clip to remove a caption')
  })

  it('accepts caption-clip text updates', () => {
    expect(check([{ type: 'set_clip_text', clipId: 'clip-cap', text: 'updated', language: 'en' }])).not.toThrow()
  })
})

describe('set_clip_disabled / delete_clip', () => {
  it('rejects unknown clips', () => {
    expect(check([{ type: 'set_clip_disabled', clipId: 'nope', disabled: true }])).toThrow('references unknown clip nope')
    expect(check([{ type: 'delete_clip', clipId: 'nope' }])).toThrow('references unknown clip nope')
  })

  it('rejects clips on locked tracks', () => {
    expect(check([{ type: 'delete_clip', clipId: 'clip-locked' }])).toThrow('sits on locked track')
  })

  it('accepts valid targets', () => {
    expect(check([
      { type: 'set_clip_disabled', clipId: 'clip-a', disabled: true },
      { type: 'delete_clip', clipId: 'clip-cap' },
    ])).not.toThrow()
  })
})

describe('create_track', () => {
  it('rejects runtime-junk kinds', () => {
    const junk = { type: 'create_track', kind: 'subtitle', name: 'Subs' } as unknown as SequenceOperation
    expect(check([junk])).toThrow('unsupported track kind "subtitle"')
  })

  it('rejects empty names', () => {
    expect(check([{ type: 'create_track', kind: 'caption', name: '  ' }])).toThrow('name must be non-empty')
  })

  it('accepts every model track kind', () => {
    expect(check([
      { type: 'create_track', kind: 'video', name: 'B-roll' },
      { type: 'create_track', kind: 'audio', name: 'VO' },
      { type: 'create_track', kind: 'caption', name: 'Subs' },
      { type: 'create_track', kind: 'reference', name: 'Guide' },
      { type: 'create_track', kind: 'agent', name: 'Decisions' },
    ])).not.toThrow()
  })
})

describe('extend_sequence', () => {
  it('rejects non-positive durations', () => {
    expect(check([{ type: 'extend_sequence', durationFrames: 0 }])).toThrow('durationFrames must be a positive integer')
    expect(check([{ type: 'extend_sequence', durationFrames: 1.5 }])).toThrow('durationFrames must be a positive integer')
  })

  it('rejects durations below the last clip end', () => {
    expect(check([{ type: 'extend_sequence', durationFrames: 100 }]))
      .toThrow('durationFrames 100 is below the last clip end (frame 180)')
  })

  it('accepts shrinking exactly to the last clip end, and growing', () => {
    expect(check([{ type: 'extend_sequence', durationFrames: 180 }])).not.toThrow()
    expect(check([{ type: 'extend_sequence', durationFrames: 1200 }])).not.toThrow()
  })

  it('computes the last clip end across tracks', () => {
    expect(lastClipEndFrame(baseTimeline())).toBe(180)
  })
})

describe('queue_export', () => {
  it('rejects runtime-junk formats', () => {
    const junk = { type: 'queue_export', format: 'gif' } as unknown as SequenceOperation
    expect(check([junk])).toThrow('unsupported export format "gif"')
  })

  it('accepts every model export format', () => {
    expect(check([
      { type: 'queue_export', format: 'mp4' },
      { type: 'queue_export', format: 'otio' },
      { type: 'queue_export', format: 'xml' },
      { type: 'queue_export', format: 'edl' },
      { type: 'queue_export', format: 'vtt' },
      { type: 'queue_export', format: 'srt' },
      { type: 'queue_export', format: 'contact_sheet' },
    ])).not.toThrow()
  })
})
