/**
 * Waveform rendering for audio clips: bucketed max-abs peaks computed once
 * per (media, zoom bucket count) and painted as mirrored bars around the
 * track lane's midline. `computeWaveform` is pure so peak math is testable
 * without Web Audio; `loadWaveform` is the browser edge that decodes real
 * media into it.
 */

import type { WaveformData } from '../contracts'

/** Structural slice of Web Audio's AudioBuffer so peak math runs on synthetic
 *  fixtures in tests and on real decoded buffers in the browser. */
export interface AudioBufferLike {
  numberOfChannels: number
  length: number
  sampleRate: number
  duration: number
  getChannelData(channel: number): Float32Array
}

/** One max-abs peak per bucket, taken across all channels. `peaks[b]` is the
 *  loudest absolute sample in bucket `b`; rendering mirrors it around the
 *  midline, which is what the contract's "peak pair" denotes. Buckets past
 *  the end of short audio hold 0. */
export function computeWaveform(buffer: AudioBufferLike, bucketCount: number): WaveformData {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new Error(`bucketCount must be a positive integer, got ${bucketCount}`)
  }
  if (!Number.isInteger(buffer.length) || buffer.length < 1) {
    throw new Error(`audio buffer is empty (length ${buffer.length}) — cannot compute a waveform`)
  }
  if (!Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) {
    throw new Error(`audio buffer must have at least one channel, got ${buffer.numberOfChannels}`)
  }
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    throw new Error(`audio buffer duration must be positive, got ${buffer.duration}`)
  }
  const samplesPerBucket = Math.ceil(buffer.length / bucketCount)
  const peaks = new Float32Array(bucketCount)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    if (data.length !== buffer.length) {
      throw new Error(`channel ${channel} has ${data.length} samples, expected ${buffer.length}`)
    }
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const start = bucket * samplesPerBucket
      if (start >= data.length) break
      let peak = peaks[bucket] as number
      for (const sample of data.subarray(start, Math.min(data.length, start + samplesPerBucket))) {
        const magnitude = Math.abs(sample)
        if (magnitude > peak) peak = magnitude
      }
      peaks[bucket] = peak
    }
  }
  return { peaks, samplesPerBucket, durationSeconds: buffer.duration }
}

/** Fetch + decode `mediaUrl` and bucket it. Pass `ctx` to reuse a shared
 *  AudioContext; otherwise one is created and closed around the decode. */
export async function loadWaveform(mediaUrl: string, bucketCount: number, ctx?: AudioContext): Promise<WaveformData> {
  const response = await fetch(mediaUrl)
  if (!response.ok) {
    throw new Error(`failed to fetch audio for waveform: ${response.status} ${response.statusText} from ${mediaUrl}`)
  }
  const bytes = await response.arrayBuffer()
  const ownsContext = ctx === undefined
  if (ctx === undefined) {
    if (typeof AudioContext === 'undefined') {
      throw new Error('loadWaveform requires Web Audio (AudioContext) — pass a ctx or call from a browser')
    }
    ctx = new AudioContext()
  }
  try {
    const decoded = await ctx.decodeAudioData(bytes)
    return computeWaveform(decoded, bucketCount)
  } finally {
    if (ownsContext) await ctx.close()
  }
}

/** Paint mirrored peak bars centered on the rect's midline. Silent buckets
 *  still paint a 1px hairline so the lane reads as audio, not as empty;
 *  peaks beyond ±1.0 (hot masters) clip to the full lane height. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  data: WaveformData,
  rect: { x: number; y: number; width: number; height: number },
  color: string,
): void {
  if (data.peaks.length === 0) {
    throw new Error('waveform has no peaks — compute it with a positive bucketCount')
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`drawWaveform requires positive rect dimensions, got ${rect.width}x${rect.height}`)
  }
  ctx.fillStyle = color
  const midline = rect.y + rect.height / 2
  const step = rect.width / data.peaks.length
  const barWidth = Math.max(1, step - 1)
  for (const [index, peak] of data.peaks.entries()) {
    const half = Math.min(1, Math.max(0, peak)) * (rect.height / 2)
    const barHeight = Math.max(1, half * 2)
    ctx.fillRect(rect.x + index * step, midline - barHeight / 2, barWidth, barHeight)
  }
}
