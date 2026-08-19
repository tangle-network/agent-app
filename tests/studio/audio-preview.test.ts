import { describe, expect, it } from 'vitest'

import {
  GRID_WAVEFORM_BARS,
  WIDE_WAVEFORM_BARS,
  hashSeed,
  previewWaveformBars,
} from '../../src/studio/audio-preview'

describe('audio preview waveform', () => {
  it('hashes and draws the same seed deterministically while different seeds differ', () => {
    expect(hashSeed('hello')).toBe(1_335_831_723)
    expect(hashSeed('clip-a')).toBe(hashSeed('clip-a'))
    expect(previewWaveformBars('clip-a', GRID_WAVEFORM_BARS)).toEqual(
      previewWaveformBars('clip-a', GRID_WAVEFORM_BARS),
    )
    expect(previewWaveformBars('clip-a', GRID_WAVEFORM_BARS)).not.toEqual(
      previewWaveformBars('clip-b', GRID_WAVEFORM_BARS),
    )
  })

  it('keeps every bar in the documented height and opacity ranges', () => {
    const bars = previewWaveformBars('range-check', WIDE_WAVEFORM_BARS)
    for (const bar of bars) {
      expect(bar.heightPct).toBeGreaterThanOrEqual(7)
      expect(bar.heightPct).toBeLessThanOrEqual(100)
      expect(bar.opacity).toBeGreaterThanOrEqual(0.5)
      expect(bar.opacity).toBeLessThanOrEqual(1)
    }
  })

  it('honours grid and wide counts, including one bar without division by zero', () => {
    expect(previewWaveformBars('grid', GRID_WAVEFORM_BARS)).toHaveLength(26)
    expect(previewWaveformBars('wide', WIDE_WAVEFORM_BARS)).toHaveLength(72)
    const single = previewWaveformBars('single', 1)
    expect(single).toHaveLength(1)
    expect(Number.isFinite(single[0]?.heightPct)).toBe(true)
    expect(Number.isFinite(single[0]?.opacity)).toBe(true)
  })
})
