import { describe, it, expect } from 'vitest'
import { nextRevealCount } from '../src/web-react/smooth-text'

describe('nextRevealCount', () => {
  it('advances at the base rate when nearly caught up', () => {
    // backlog 2: rate = 90 + 2*5 = 100 chars/s → 1 char in 10ms
    const next = nextRevealCount(98, 100, 10)
    expect(next).toBeCloseTo(99, 5)
  })

  it('accelerates with backlog so bursts still animate quickly', () => {
    // backlog 400: rate = min(2400, 90 + 2000) = 2090 chars/s
    const next = nextRevealCount(0, 400, 100)
    expect(next).toBeCloseTo(209, 0)
  })

  it('caps at maxCharsPerSecond', () => {
    const next = nextRevealCount(0, 100_000, 1000)
    expect(next).toBe(2400)
  })

  it('never overshoots the target and is stable at completion', () => {
    expect(nextRevealCount(99.9, 100, 1000)).toBe(100)
    expect(nextRevealCount(100, 100, 16)).toBe(100)
    expect(nextRevealCount(150, 100, 16)).toBe(100)
  })

  it('a typical stream catches up: 140-char slab fully revealed within ~1.5s of frames', () => {
    let shown = 0
    let elapsed = 0
    while (shown < 140 && elapsed < 5000) {
      shown = nextRevealCount(shown, 140, 16)
      elapsed += 16
    }
    expect(shown).toBe(140)
    expect(elapsed).toBeLessThan(1500)
  })
})
