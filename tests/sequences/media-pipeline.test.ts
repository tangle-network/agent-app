import { describe, expect, it, vi } from 'vitest'

import {
  classifyMediaUrl,
  containFitRect,
  createMediaElementPool,
  DEFAULT_MAX_MEDIA_ELEMENTS,
  needsSeek,
  SEEK_TOLERANCE_SECONDS,
} from '../../src/sequences-react/media/frame-provider'
import { computeWaveform, drawWaveform, type AudioBufferLike } from '../../src/sequences-react/media/waveform'
import {
  createWhisperTranscriptionProvider,
  mapWhisperOutput,
  mixdownToMono,
} from '../../src/sequences-react/media/transcription'

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  const first = channels[0]
  if (first === undefined) throw new Error('fixture needs at least one channel')
  return {
    numberOfChannels: channels.length,
    length: first.length,
    sampleRate,
    duration: first.length / sampleRate,
    getChannelData: (channel) => {
      const data = channels[channel]
      if (data === undefined) throw new Error(`fixture has no channel ${channel}`)
      return data
    },
  }
}

function sineChannel(length: number, sampleRate: number, frequency: number, amplitude: number): Float32Array {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return data
}

describe('computeWaveform', () => {
  it('buckets a sine at its amplitude', () => {
    const sampleRate = 48_000
    const buffer = makeBuffer([sineChannel(sampleRate, sampleRate, 440, 0.5)], sampleRate)
    const data = computeWaveform(buffer, 100)
    expect(data.peaks.length).toBe(100)
    expect(data.samplesPerBucket).toBe(480)
    expect(data.durationSeconds).toBeCloseTo(1, 6)
    for (const peak of data.peaks) {
      expect(peak).toBeGreaterThan(0.49)
      expect(peak).toBeLessThanOrEqual(0.5)
    }
  })

  it('takes the max-abs across channels', () => {
    const quiet = new Float32Array(8).fill(0.25)
    const loud = new Float32Array(8).fill(-0.75)
    const data = computeWaveform(makeBuffer([quiet, loud], 8), 4)
    expect(Array.from(data.peaks)).toEqual([0.75, 0.75, 0.75, 0.75])
  })

  it('localizes loud and quiet regions to their buckets', () => {
    const channel = new Float32Array(16)
    channel.fill(0.8, 0, 8)
    channel.fill(0.1, 8, 16)
    const data = computeWaveform(makeBuffer([channel], 16), 4)
    expect(Array.from(data.peaks).map((p) => Number(p.toFixed(4)))).toEqual([0.8, 0.8, 0.1, 0.1])
  })

  it('leaves buckets past the end of short audio at zero', () => {
    const data = computeWaveform(makeBuffer([new Float32Array(10).fill(0.5)], 10), 20)
    expect(data.samplesPerBucket).toBe(1)
    expect(Array.from(data.peaks.subarray(0, 10)).every((p) => p === 0.5)).toBe(true)
    expect(Array.from(data.peaks.subarray(10)).every((p) => p === 0)).toBe(true)
  })

  it('rejects invalid bucket counts, empty buffers, and ragged channels', () => {
    const buffer = makeBuffer([new Float32Array(8)], 8)
    expect(() => computeWaveform(buffer, 0)).toThrow('bucketCount must be a positive integer')
    expect(() => computeWaveform(buffer, 2.5)).toThrow('bucketCount must be a positive integer')
    expect(() => computeWaveform(makeBuffer([new Float32Array(0)], 8), 4)).toThrow('audio buffer is empty')
    const ragged: AudioBufferLike = {
      numberOfChannels: 2,
      length: 8,
      sampleRate: 8,
      duration: 1,
      getChannelData: (channel) => new Float32Array(channel === 0 ? 8 : 4),
    }
    expect(() => computeWaveform(ragged, 4)).toThrow('channel 1 has 4 samples, expected 8')
  })
})

describe('drawWaveform', () => {
  function mockCtx() {
    return { fillStyle: '', fillRect: vi.fn() } as unknown as CanvasRenderingContext2D & { fillRect: ReturnType<typeof vi.fn> }
  }

  it('paints mirrored bars around the midline', () => {
    const ctx = mockCtx()
    const peaks = Float32Array.from([1, 0.5, 0])
    drawWaveform(ctx, { peaks, samplesPerBucket: 10, durationSeconds: 1 }, { x: 0, y: 0, width: 30, height: 100 }, '#0f0')
    expect(ctx.fillStyle).toBe('#0f0')
    expect(ctx.fillRect).toHaveBeenCalledTimes(3)
    expect(ctx.fillRect).toHaveBeenNthCalledWith(1, 0, 0, 9, 100)
    expect(ctx.fillRect).toHaveBeenNthCalledWith(2, 10, 25, 9, 50)
    // silent bucket still paints a 1px hairline on the midline
    expect(ctx.fillRect).toHaveBeenNthCalledWith(3, 20, 49.5, 9, 1)
  })

  it('rejects empty peaks and degenerate rects', () => {
    const data = { peaks: Float32Array.from([0.5]), samplesPerBucket: 1, durationSeconds: 1 }
    expect(() => drawWaveform(mockCtx(), { ...data, peaks: new Float32Array(0) }, { x: 0, y: 0, width: 10, height: 10 }, '#fff'))
      .toThrow('waveform has no peaks')
    expect(() => drawWaveform(mockCtx(), data, { x: 0, y: 0, width: 0, height: 10 }, '#fff'))
      .toThrow('positive rect dimensions')
  })
})

describe('containFitRect', () => {
  it('letterboxes a wide source vertically', () => {
    const fit = containFitRect({ width: 1920, height: 1080 }, { x: 10, y: 20, width: 100, height: 100 })
    expect(fit.width).toBeCloseTo(100, 6)
    expect(fit.height).toBeCloseTo(56.25, 6)
    expect(fit.x).toBeCloseTo(10, 6)
    expect(fit.y).toBeCloseTo(20 + (100 - 56.25) / 2, 6)
  })

  it('pillarboxes a tall source horizontally', () => {
    const fit = containFitRect({ width: 1080, height: 1920 }, { x: 0, y: 0, width: 100, height: 100 })
    expect(fit.height).toBeCloseTo(100, 6)
    expect(fit.width).toBeCloseTo(56.25, 6)
    expect(fit.x).toBeCloseTo((100 - 56.25) / 2, 6)
    expect(fit.y).toBeCloseTo(0, 6)
  })

  it('scales an exact-ratio source to fill the rect', () => {
    expect(containFitRect({ width: 50, height: 50 }, { x: 5, y: 5, width: 100, height: 100 }))
      .toEqual({ x: 5, y: 5, width: 100, height: 100 })
  })

  it('rejects non-positive dimensions', () => {
    expect(() => containFitRect({ width: 0, height: 100 }, { x: 0, y: 0, width: 10, height: 10 }))
      .toThrow('positive source dimensions')
    expect(() => containFitRect({ width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 0 }))
      .toThrow('positive destination dimensions')
  })
})

describe('needsSeek', () => {
  it('skips seeks within half a frame at 30fps', () => {
    expect(needsSeek(0.5, 0.5 + SEEK_TOLERANCE_SECONDS / 2)).toBe(false)
    expect(needsSeek(0.5, 0.5)).toBe(false)
    expect(needsSeek(0, 1 / 30)).toBe(true)
    expect(needsSeek(0.5, 0.5 + SEEK_TOLERANCE_SECONDS)).toBe(true)
  })
})

describe('createMediaElementPool', () => {
  function trackedPool(maxElements: number) {
    const created: string[] = []
    const destroyed: string[] = []
    const pool = createMediaElementPool<{ url: string }>({
      maxElements,
      create: (url) => {
        created.push(url)
        return { url }
      },
      destroy: (_element, url) => {
        destroyed.push(url)
      },
    })
    return { pool, created, destroyed }
  }

  it('defaults to four elements', () => {
    expect(DEFAULT_MAX_MEDIA_ELEMENTS).toBe(4)
  })

  it('evicts the least recently used idle entry', () => {
    const { pool, destroyed } = trackedPool(2)
    pool.acquire('a').release()
    pool.acquire('b').release()
    pool.acquire('c').release()
    expect(destroyed).toEqual(['a'])
    expect(pool.has('a')).toBe(false)
    expect(pool.has('b')).toBe(true)
    expect(pool.has('c')).toBe(true)
    expect(pool.size()).toBe(2)
  })

  it('bumps recency on re-acquire and reuses the element', () => {
    const { pool, created, destroyed } = trackedPool(2)
    const first = pool.acquire('a')
    first.release()
    pool.acquire('b').release()
    const again = pool.acquire('a')
    again.release()
    expect(again.element).toBe(first.element)
    expect(created).toEqual(['a', 'b'])
    pool.acquire('c').release()
    expect(destroyed).toEqual(['b'])
  })

  it('never evicts pinned entries, even over budget', () => {
    const { pool, destroyed } = trackedPool(1)
    const leaseA = pool.acquire('a')
    const leaseB = pool.acquire('b')
    expect(pool.size()).toBe(2)
    expect(destroyed).toEqual([])
    leaseA.release()
    expect(destroyed).toEqual(['a'])
    expect(pool.size()).toBe(1)
    leaseB.release()
    expect(pool.has('b')).toBe(true)
  })

  it('treats double release as a no-op', () => {
    const { pool, destroyed } = trackedPool(1)
    const lease = pool.acquire('a')
    lease.release()
    lease.release()
    const pinned = pool.acquire('a')
    pool.acquire('b').release()
    // 'a' is still pinned: the stale releases must not have unpinned it
    expect(destroyed).toEqual(['b'])
    pinned.release()
  })

  it('destroys everything on dispose and refuses new acquires', () => {
    const { pool, destroyed } = trackedPool(4)
    pool.acquire('a')
    pool.acquire('b').release()
    pool.dispose()
    expect(destroyed.sort()).toEqual(['a', 'b'])
    expect(pool.size()).toBe(0)
    expect(() => pool.acquire('c')).toThrow('disposed')
  })

  it('rejects non-positive maxElements', () => {
    expect(() => createMediaElementPool({ maxElements: 0, create: () => ({}), destroy: () => undefined }))
      .toThrow('maxElements must be a positive integer')
  })
})

describe('classifyMediaUrl', () => {
  it('classifies by extension, ignoring query/hash and case', () => {
    expect(classifyMediaUrl('https://cdn.example.com/clip.mp4')).toBe('video')
    expect(classifyMediaUrl('https://cdn.example.com/clip.WEBM#t=5')).toBe('video')
    expect(classifyMediaUrl('https://cdn.example.com/still.PNG?sig=abc')).toBe('image')
    expect(classifyMediaUrl('/relative/path/photo.jpeg')).toBe('image')
    expect(classifyMediaUrl('https://cdn.example.com/blob-no-extension')).toBe('unknown')
    expect(classifyMediaUrl('https://cdn.example.com/data.bin')).toBe('unknown')
  })
})

describe('mixdownToMono', () => {
  it('returns single-channel data directly', () => {
    const channel = Float32Array.from([0.1, -0.2, 0.3])
    expect(mixdownToMono(makeBuffer([channel], 3))).toBe(channel)
  })

  it('averages multi-channel data', () => {
    const left = Float32Array.from([1, 0, -1])
    const right = Float32Array.from([0, 0.5, -0.5])
    expect(Array.from(mixdownToMono(makeBuffer([left, right], 3)))).toEqual([0.5, 0.25, -0.75])
  })
})

describe('mapWhisperOutput', () => {
  it('maps chunks, resolving null end timestamps to the audio duration', () => {
    const segments = mapWhisperOutput(
      {
        text: ' hello world',
        chunks: [
          { text: ' hello', timestamp: [0, 1.2] },
          { text: '  ', timestamp: [1.2, 2] },
          { text: ' world', timestamp: [2.4, null] },
        ],
      },
      3.5,
      'https://cdn.example.com/audio.mp3',
    )
    expect(segments).toEqual([
      { text: 'hello', startSeconds: 0, endSeconds: 1.2 },
      { text: 'world', startSeconds: 2.4, endSeconds: 3.5 },
    ])
  })

  it('falls back to one full-duration segment only when whisper omits chunks entirely', () => {
    expect(mapWhisperOutput({ text: ' all of it ' }, 2, 'u')).toEqual([
      { text: 'all of it', startSeconds: 0, endSeconds: 2 },
    ])
    expect(mapWhisperOutput({ text: '   ' }, 2, 'u')).toEqual([])
  })

  it('fails loud on empty batched output and non-numeric timestamps', () => {
    expect(() => mapWhisperOutput([], 1, 'u')).toThrow('whisper produced no output')
    expect(() => mapWhisperOutput(
      { text: 'x', chunks: [{ text: 'x', timestamp: [Number.NaN, 1] }] },
      1,
      'u',
    )).toThrow('non-numeric start timestamp')
  })
})

describe('createWhisperTranscriptionProvider', () => {
  it('constructs without DOM and reports availability as a boolean', () => {
    const provider = createWhisperTranscriptionProvider()
    expect(typeof provider.available).toBe('boolean')
  })

  it('throws the peer-missing message when @huggingface/transformers is absent', async () => {
    const provider = createWhisperTranscriptionProvider()
    await expect(provider.transcribe('https://cdn.example.com/audio.mp3'))
      .rejects.toThrow('transcription requires optional peer @huggingface/transformers')
  })
})
