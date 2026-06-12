import { describe, it, expect } from 'vitest'
import {
  buildCaptionChunks,
  captionCoverage,
  normalizeLanguageTag,
  planLanguageFanout,
  type TranscriptSegment,
} from '../../src/sequences/captions'
import type { SequenceClip, SequenceTimeline, SequenceTrack } from '../../src/sequences/model'

const FPS = 30

function segment(text: string, startSeconds: number, endSeconds: number): TranscriptSegment {
  return { text, startSeconds, endSeconds }
}

describe('buildCaptionChunks', () => {
  it('apportions segment time by word count across chunks', () => {
    // 10 words over 5s: chunk 1 carries 8/10 of the time, chunk 2 the rest
    const segments = [segment('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10', 0, 5)]
    const chunks = buildCaptionChunks(segments, { fps: FPS })
    expect(chunks).toEqual([
      { text: 'w1 w2 w3 w4 w5 w6 w7 w8', startFrame: 0, durationFrames: 120 },
      { text: 'w9 w10', startFrame: 120, durationFrames: 30 },
    ])
  })

  it('produces contiguous chunks at natural boundaries (no 1-frame gaps)', () => {
    const segments = [segment('a b c d e f g h i j k l m n o p', 0, 8)]
    const chunks = buildCaptionChunks(segments, { fps: FPS })
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.startFrame + chunks[0]!.durationFrames).toBe(chunks[1]!.startFrame)
  })

  it('clamps a short segment tail to the min duration, extending past segment end by at most the clamp', () => {
    // chunk 2 is 1 word: natural span [80, 90) = 10 frames < 24-frame clamp
    const segments = [segment('w1 w2 w3 w4 w5 w6 w7 w8 w9', 0, 3)]
    const chunks = buildCaptionChunks(segments, { fps: FPS })
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toEqual({ text: 'w9', startFrame: 80, durationFrames: 24 })
    const segmentEndFrame = 3 * FPS
    const overhang = chunks[1]!.startFrame + chunks[1]!.durationFrames - segmentEndFrame
    expect(overhang).toBeGreaterThan(0)
    expect(overhang).toBeLessThanOrEqual(24)
  })

  it('pushes following chunks forward instead of overlapping when the clamp extends a chunk', () => {
    const segments = [
      segment('one two', 0, 0.5),
      segment('three four', 0.5, 1.0),
      segment('five six', 1.0, 1.5),
    ]
    const chunks = buildCaptionChunks(segments, { fps: FPS })
    expect(chunks.map((chunk) => chunk.text)).toEqual(['one two', 'three four', 'five six'])
    // each natural span is 15 frames; the 24-frame clamp chains the pushes
    expect(chunks).toEqual([
      { text: 'one two', startFrame: 0, durationFrames: 24 },
      { text: 'three four', startFrame: 24, durationFrames: 24 },
      { text: 'five six', startFrame: 48, durationFrames: 24 },
    ])
  })

  it('keeps starts strictly increasing and chunks disjoint on unsorted, overlapping segments', () => {
    const segments = [
      segment('later words here now', 2.0, 2.4),
      segment('first short bit', 0, 0.3),
      segment('overlapping middle words', 0.2, 0.6),
    ]
    const chunks = buildCaptionChunks(segments, { fps: FPS, minDurationSeconds: 0.8 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.text).toBe('first short bit')
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]!
      const current = chunks[i]!
      expect(current.startFrame).toBeGreaterThan(prev.startFrame)
      expect(current.startFrame).toBeGreaterThanOrEqual(prev.startFrame + prev.durationFrames)
    }
  })

  it('skips whitespace-only segments and normalizes internal whitespace', () => {
    const segments = [
      segment('   ', 0, 1),
      segment('  hello   spaced\tworld  ', 1, 2),
    ]
    const chunks = buildCaptionChunks(segments, { fps: FPS })
    expect(chunks).toEqual([{ text: 'hello spaced world', startFrame: 30, durationFrames: 30 }])
  })

  it('honors maxWordsPerChunk overrides', () => {
    const segments = [segment('a b c d', 0, 4)]
    const chunks = buildCaptionChunks(segments, { fps: FPS, maxWordsPerChunk: 2 })
    expect(chunks.map((chunk) => chunk.text)).toEqual(['a b', 'c d'])
  })

  it('guarantees at least one frame per chunk even with minDurationSeconds 0', () => {
    const segments = [segment('instant', 1, 1)]
    const chunks = buildCaptionChunks(segments, { fps: FPS, minDurationSeconds: 0 })
    expect(chunks).toEqual([{ text: 'instant', startFrame: 30, durationFrames: 1 }])
  })

  it('rejects invalid options and malformed segments with precise errors', () => {
    expect(() => buildCaptionChunks([], { fps: 29.97 })).toThrow('fps must be a positive integer')
    expect(() => buildCaptionChunks([], { fps: FPS, maxWordsPerChunk: 0 })).toThrow('maxWordsPerChunk must be a positive integer')
    expect(() => buildCaptionChunks([], { fps: FPS, minDurationSeconds: -1 })).toThrow('minDurationSeconds must be a non-negative finite number')
    expect(() => buildCaptionChunks([segment('hi', -1, 2)], { fps: FPS })).toThrow('segment 0 startSeconds must be a non-negative finite number')
    expect(() => buildCaptionChunks([segment('ok', 0, 1), segment('hi', 3, 2)], { fps: FPS })).toThrow('segment 1 endSeconds must be a finite number >= startSeconds')
  })
})

describe('normalizeLanguageTag', () => {
  it('applies conventional BCP-47 casing', () => {
    expect(normalizeLanguageTag('EN')).toBe('en')
    expect(normalizeLanguageTag('pt-br')).toBe('pt-BR')
    expect(normalizeLanguageTag('zh-hans')).toBe('zh-Hans')
    expect(normalizeLanguageTag('ZH-HANS-CN')).toBe('zh-Hans-CN')
    expect(normalizeLanguageTag(' fil ')).toBe('fil')
  })

  it('rejects structurally invalid tags', () => {
    expect(() => normalizeLanguageTag('')).toThrow('language tag must be a non-empty string')
    expect(() => normalizeLanguageTag('   ')).toThrow('language tag must be a non-empty string')
    expect(() => normalizeLanguageTag('e')).toThrow("invalid BCP-47 language tag 'e'")
    expect(() => normalizeLanguageTag('english')).toThrow("invalid BCP-47 language tag 'english'")
    expect(() => normalizeLanguageTag('en_US')).toThrow("invalid BCP-47 language tag 'en_US'")
    expect(() => normalizeLanguageTag('en-')).toThrow("invalid BCP-47 language tag 'en-'")
    expect(() => normalizeLanguageTag('en-x')).toThrow("invalid BCP-47 language tag 'en-x'")
  })
})

describe('planLanguageFanout', () => {
  it('normalizes, dedupes (first occurrence wins), and excludes the source', () => {
    const planned = planLanguageFanout({
      languages: ['ES', 'en', 'pt-br', 'es', 'ja', 'PT-BR'],
      sourceLanguage: 'EN',
    })
    expect(planned).toEqual(['es', 'pt-BR', 'ja'])
  })

  it('does not exclude regional variants of the source', () => {
    expect(planLanguageFanout({ languages: ['en-US'], sourceLanguage: 'en' })).toEqual(['en-US'])
  })

  it('returns [] when every requested language is the source', () => {
    expect(planLanguageFanout({ languages: ['en', 'EN'], sourceLanguage: 'en' })).toEqual([])
  })

  it('throws on an empty request or any invalid tag', () => {
    expect(() => planLanguageFanout({ languages: [] })).toThrow('languages must contain at least one BCP-47 tag')
    expect(() => planLanguageFanout({ languages: ['es', 'not a tag'] })).toThrow('invalid BCP-47 language tag')
    expect(() => planLanguageFanout({ languages: ['es'], sourceLanguage: 'x' })).toThrow("invalid BCP-47 language tag 'x'")
  })
})

function track(id: string, kind: SequenceTrack['kind'], sortOrder: number): SequenceTrack {
  return { id, kind, name: id, sortOrder, locked: false, muted: false, metadata: {} }
}

function clip(input: {
  id: string
  trackId: string
  startFrame: number
  durationFrames: number
  text?: string
  language?: string
  disabled?: boolean
}): SequenceClip {
  return {
    id: input.id,
    trackId: input.trackId,
    label: input.id,
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    sourceInFrame: 0,
    sourceOutFrame: null,
    disabled: input.disabled ?? false,
    text: input.text,
    language: input.language,
    metadata: {},
  }
}

function timelineFixture(clips: SequenceClip[], durationFrames = 300): SequenceTimeline {
  return {
    sequence: {
      id: 'seq-1',
      title: 'fixture',
      fps: FPS,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames,
      status: 'active',
      metadata: {},
    },
    tracks: [track('v1', 'video', 0), track('c1', 'caption', 1), track('c2', 'caption', 2)],
    clips,
  }
}

describe('captionCoverage', () => {
  it('merges overlaps, counts covered frames once, and reports gaps per language', () => {
    const timeline = timelineFixture([
      clip({ id: 'en-1', trackId: 'c1', startFrame: 0, durationFrames: 100, text: 'a', language: 'en' }),
      clip({ id: 'en-2', trackId: 'c1', startFrame: 80, durationFrames: 70, text: 'b', language: 'en' }),
      clip({ id: 'en-3', trackId: 'c1', startFrame: 200, durationFrames: 50, text: 'c', language: 'en' }),
      clip({ id: 'es-1', trackId: 'c2', startFrame: 0, durationFrames: 300, text: 'hola', language: 'es' }),
    ])
    const coverage = captionCoverage(timeline)
    expect(coverage).toEqual([
      {
        language: 'en',
        coveredFrames: 200,
        totalFrames: 300,
        gaps: [
          { startFrame: 150, endFrame: 200 },
          { startFrame: 250, endFrame: 300 },
        ],
      },
      { language: 'es', coveredFrames: 300, totalFrames: 300, gaps: [] },
    ])
  })

  it('ignores disabled clips, empty-text clips, and text on non-caption tracks; groups untagged clips under null first', () => {
    const timeline = timelineFixture([
      clip({ id: 'dead', trackId: 'c1', startFrame: 0, durationFrames: 100, text: 'x', language: 'en', disabled: true }),
      clip({ id: 'blank', trackId: 'c1', startFrame: 100, durationFrames: 100, text: '', language: 'en' }),
      clip({ id: 'video-text', trackId: 'v1', startFrame: 0, durationFrames: 300, text: 'not a caption' }),
      clip({ id: 'untagged', trackId: 'c1', startFrame: 290, durationFrames: 10, text: 'tail' }),
      clip({ id: 'en-live', trackId: 'c1', startFrame: 200, durationFrames: 50, text: 'live', language: 'en' }),
    ])
    const coverage = captionCoverage(timeline)
    expect(coverage.map((entry) => entry.language)).toEqual([null, 'en'])
    expect(coverage[0]).toEqual({
      language: null,
      coveredFrames: 10,
      totalFrames: 300,
      gaps: [{ startFrame: 0, endFrame: 290 }],
    })
    expect(coverage[1]).toEqual({
      language: 'en',
      coveredFrames: 50,
      totalFrames: 300,
      gaps: [
        { startFrame: 0, endFrame: 200 },
        { startFrame: 250, endFrame: 300 },
      ],
    })
  })

  it('returns [] for a timeline with no caption clips', () => {
    const timeline = timelineFixture([
      clip({ id: 'video-only', trackId: 'v1', startFrame: 0, durationFrames: 300 }),
    ])
    expect(captionCoverage(timeline)).toEqual([])
  })

  it('rejects a non-positive sequence duration', () => {
    const timeline = timelineFixture([], 0)
    expect(() => captionCoverage(timeline)).toThrow('sequence durationFrames must be a positive integer')
  })
})
