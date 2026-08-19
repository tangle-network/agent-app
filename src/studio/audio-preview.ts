/** A deterministic waveform bar used when decoded audio is unavailable. */
export interface WaveformBar {
  /** 7–100, % of tile height. */
  heightPct: number
  opacity: number
}

export const GRID_WAVEFORM_BARS = 26
export const WIDE_WAVEFORM_BARS = 72

/** Hash a string with FNV-1a into an unsigned 32-bit seed. */
export function hashSeed(value: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/** Build stable pseudo-waveform bars for a media preview. */
export function previewWaveformBars(seed: string, count: number): readonly WaveformBar[] {
  const rnd = mulberry32(hashSeed(seed))
  return Array.from({ length: count }, (_, index) => {
    const t = count > 1 ? index / (count - 1) : 0
    const env = Math.sin(Math.PI * t) * 0.55 + 0.45
    const heightPct = +Math.max(7, (0.22 + rnd() * 0.78) * env * 92).toFixed(1)
    const opacity = +(0.5 + rnd() * 0.5).toFixed(2)
    return { heightPct, opacity }
  })
}
