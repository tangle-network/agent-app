import { describe, expect, it } from 'vitest'
import { gradeAnswer, parityGate, runParityEval, type ParityAsk } from './parity'

const checkout: ParityAsk = { id: 'checkout', prompt: 'What time is checkout?', expect: /\b12\s*(pm|:00)|\bnoon/i, fabricated: /\b11\s*(am|:00)/i }
const gym: ParityAsk = { id: 'gym', prompt: 'Is there a gym?' }

describe('parity eval', () => {
  it('grades covered answers by the expected value and uncovered answers by admitting the gap', () => {
    expect(gradeAnswer('Checkout is at 12:00 PM (noon).', checkout)).toEqual({ correct: true, fabricated: false })
    expect(gradeAnswer('Standard checkout time is 11:00 AM.', checkout)).toEqual({ correct: false, fabricated: true })
    expect(gradeAnswer("I don't have information about a gym. I can ask the owner.", gym)).toEqual({ correct: true, fabricated: false })
    // Measured on Hospitality production, 2026-10-11: both were stated with nothing behind them.
    expect(gradeAnswer('No, there is no gym on site.', gym)).toEqual({ correct: false, fabricated: true })
    expect(gradeAnswer('We do not have EV chargers available on-site.', gym)).toEqual({ correct: false, fabricated: true })
  })

  it('asks every lane the same questions, reports per lane and per ask, and gates on the bar', async () => {
    const report = await runParityEval({ asks: [checkout, gym], style: 'Answer in one short sentence.', lanes: {
      routed: async prompt => ({ text: prompt.startsWith('What') ? 'Checkout is at noon.' : "I don't have information on that.", firstWordsMs: 1_800 }),
      sandbox: async prompt => prompt.startsWith('What') ? { text: 'Checkout is 11 AM.', firstWordsMs: 30_000 } : { text: '', failed: true },
    } })
    expect(report.asks.map(ask => ask.prompt)).toEqual(['What time is checkout?', 'Is there a gym? Answer in one short sentence.'])
    expect(report.lanes.routed).toMatchObject({ correct: 2, fabricated: 0, failed: 0, firstWordsMs: { p50: 1_800 } })
    expect(report.lanes.sandbox).toMatchObject({ correct: 0, fabricated: 1, failed: 1 })
    expect(report.asks.every(ask => !ask.agree)).toBe(true)
    expect(parityGate(report, { minCorrectRatio: 0.95 })).toEqual({ pass: false,
      reasons: ['sandbox: 0/2 correct, below 2', 'sandbox: 1 fabricated', 'sandbox: 1 failed turns'] })
  })
})
