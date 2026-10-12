import { describe, expect, it } from 'vitest'
import { chapterCues, frameTimes, highlightPlan, MAX_HIGHLIGHTS_S, type Chapter } from '../../src/journeys/video'

const T0 = 1_000_000
const at = (s: number) => T0 + s * 1000

describe('highlightPlan', () => {
  const chapters: Chapter[] = [
    { at: at(0), caption: 'Founder opens the workspace', label: 'founder', kind: 'step' },
    { at: at(5), caption: 'Waiting for the agent', label: 'founder', kind: 'wait', until: at(46) },
    { at: at(28), caption: 'First text after 23 s', label: 'founder', kind: 'step' },
    { at: at(46), caption: 'Turn complete after 41 s', label: 'founder', kind: 'step' },
  ]

  it('speeds up a long wait and says how long it really took', () => {
    const plan = highlightPlan(chapters, T0, 60)
    const inWait = plan.find((s) => s.a === 28)!
    expect(inWait.k).toBeGreaterThan(1)
    expect(inWait.text).toBe(`[00:28] First text after 23 s   » ${Math.round(inWait.k * 10) / 10}x, 18 s real (whole wait 41 s)`)
    expect(plan.find((s) => s.a === 0)!.k).toBe(1)
  })

  it('fits a long recording into the highlights budget', () => {
    const long: Chapter[] = Array.from({ length: 40 }, (_, i) => ({ at: at(i * 60), caption: `Step ${i}`, label: null, kind: 'step' as const }))
    const plan = highlightPlan(long, T0, 2400)
    const shown = plan.reduce((n, s) => n + (s.b - s.a) / s.k, 0)
    expect(shown).toBeLessThanOrEqual(MAX_HIGHLIGHTS_S + 0.001)
    expect(shown).toBeGreaterThan(MAX_HIGHLIGHTS_S - 1)
  })
})

describe('chapterCues and frameTimes', () => {
  it('holds each caption until the next and labels a wait with its real length', () => {
    const cues = chapterCues([
      { at: at(0), caption: 'Opens', label: null, kind: 'step' },
      { at: at(10), caption: 'Waiting for the agent', label: null, kind: 'wait', until: at(130) },
      { at: at(130), caption: 'Done', label: null, kind: 'step' },
    ], T0, 140)
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 10, 'Opens'],
      [10, 130, 'Waiting for the agent (real wait 2 min 0 s)'],
      [130, 140, 'Done'],
    ])
  })

  it('takes one frame per caption, at most the maximum, evenly spread', () => {
    const srt = Array.from({ length: 20 }, (_, i) => `${i + 1}\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 1).padStart(2, '0')},000\nc${i}\n`).join('\n')
    const times = frameTimes(srt, [], 5)
    expect(times).toEqual([1.5, 9.5, 17.5, 25.5, 33.5])
    expect(frameTimes(null, [12, 47.5], 5)).toEqual([12, 47.5])
  })
})
