/**
 * buildEnsembleJudge wraps the substrate reducer into a JudgeConfig. These
 * tests pin the contract the loop depends on: N reps fan out, a single rep
 * failing does not fail the cell, all-failed throws (failed cell, not a zero),
 * and the JudgeScore shape is exactly what runCampaign/selfImprove consume.
 */

import { describe, expect, it } from 'vitest'

import type { Scenario } from '@tangle-network/agent-eval/campaign'
import { buildEnsembleJudge } from './index'

type Dim = 'accuracy' | 'tone'
const RUBRIC = ['accuracy', 'tone'] as const

interface Art {
  text: string
}
const scenario: Scenario = { id: 's1', kind: 'test' }
const signal = new AbortController().signal

describe('buildEnsembleJudge', () => {
  it('fans out judgeReps calls and returns the JudgeScore shape', async () => {
    let calls = 0
    const judge = buildEnsembleJudge<Art, Scenario, Dim>({
      name: 'test',
      rubric: RUBRIC,
      judgeReps: 3,
      async scoreOne({ rep }) {
        calls++
        return { model: `m${rep}`, perDimension: { accuracy: 0.8, tone: 0.6 } }
      },
    })
    const score = await judge.score({ artifact: { text: 'x' }, scenario, signal })
    expect(calls).toBe(3)
    expect(score.dimensions.accuracy).toBeCloseTo(0.8, 5)
    expect(score.dimensions.tone).toBeCloseTo(0.6, 5)
    expect(score.composite).toBeCloseTo(0.7, 5)
    expect(typeof score.notes).toBe('string')
  })

  it('exposes the rubric as JudgeDimensions', () => {
    const judge = buildEnsembleJudge<Art, Scenario, Dim>({
      name: 'test',
      rubric: RUBRIC,
      describe: (d) => `desc:${d}`,
      async scoreOne() {
        return { model: 'm', perDimension: { accuracy: 1, tone: 1 } }
      },
    })
    expect(judge.dimensions).toEqual([
      { key: 'accuracy', description: 'desc:accuracy' },
      { key: 'tone', description: 'desc:tone' },
    ])
  })

  it('a single rep failing does NOT fail the cell — means over survivors', async () => {
    const judge = buildEnsembleJudge<Art, Scenario, Dim>({
      name: 'test',
      rubric: RUBRIC,
      judgeReps: 2,
      async scoreOne({ rep }) {
        if (rep === 0) throw new Error('judge 0 down')
        return { model: 'm1', perDimension: { accuracy: 0.9, tone: 0.9 } }
      },
    })
    const score = await judge.score({ artifact: { text: 'x' }, scenario, signal })
    expect(score.dimensions.accuracy).toBeCloseTo(0.9, 5) // survivor only, not (0.9+0)/2
  })

  it('throws (failed cell, not a zero) when every rep fails', async () => {
    const judge = buildEnsembleJudge<Art, Scenario, Dim>({
      name: 'test',
      rubric: RUBRIC,
      judgeReps: 2,
      async scoreOne() {
        throw new Error('all down')
      },
    })
    await expect(judge.score({ artifact: { text: 'x' }, scenario, signal })).rejects.toThrow(
      /all 2 judges failed/,
    )
  })

  it('rejects an empty rubric and judgeReps < 1', () => {
    expect(() =>
      buildEnsembleJudge<Art, Scenario, Dim>({ name: 't', rubric: [], scoreOne: async () => ({ model: 'm', perDimension: null }) }),
    ).toThrow(/rubric is empty/)
    expect(() =>
      buildEnsembleJudge<Art, Scenario, Dim>({
        name: 't',
        rubric: RUBRIC,
        judgeReps: 0,
        scoreOne: async () => ({ model: 'm', perDimension: { accuracy: 1, tone: 1 } }),
      }),
    ).toThrow(/judgeReps must be >= 1/)
  })
})
