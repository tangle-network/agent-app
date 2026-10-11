import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectJourneyFiles, renderIndex, tallyTurns, type CriticResult, type JourneyFiles } from '../../src/journeys/report'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const turn = (outcome: JourneyFiles['turns'][number]['outcome'], error: string | null = null) => ({
  label: 'founder', outcome, firstTextS: 33.8, completeS: 300, replyChars: 4812, error, sentAt: '2026-10-11T12:47:03.000Z',
})

const JOURNEYS: JourneyFiles[] = [
  { dir: 'core-path', videos: [{ file: 'video/founder-full.mp4', seconds: 448 }, { file: 'video/founder-highlights.mp4', seconds: 72 }], turns: [turn('completed')] },
  { dir: 'failure', videos: [{ file: 'video/desktop-highlights.mp4', seconds: 108 }], turns: [turn('stopped', 'You stopped this turn.'), turn('failed', 'a Retry control appeared in the transcript')] },
]

const CRITIC: CriticResult = {
  headline: '2 of the 4 minimum-customer-path checks work end to end.',
  scorecard: [
    { journey: 'Failure and recovery', verifiedVerdict: 'partial', topIssue: 'Stop leaves no Retry', video: '/flows/failure/video/desktop-highlights.mp4' },
    { journey: 'Core path', verifiedVerdict: 'pass', topIssue: 'Rich Save disabled', video: '/flows/core-path/video/founder-highlights.mp4' },
  ],
  verifiedFailures: [
    { rank: 2, severity: 'P1', what: 'Stop leaves no Retry.\nThe card says Retry with no button.', evidence: 'frame j3-d-0133.png', fix: 'Show Retry', numberToBeat: '0 of 2', test: 'press Stop, assert Retry' },
    { rank: 1, severity: 'P1', what: 'Turns die on sandbox errors', journeys: ['J2', 'B1'], evidence: '6 of 39 executions', fix: 'Provision at creation', numberToBeat: '15.4%', test: 'burst of 5 first turns' },
  ],
  coverageGaps: ['No test inbox for sign-up'],
}

describe('renderIndex', () => {
  const md = renderIndex({ title: 'Journeys', critic: CRITIC, journeys: JOURNEYS })

  it('ranks the fixes by the critic’s rank, not their order in the file', () => {
    const one = md.indexOf('1. **Turns die on sandbox errors** (P1; J2, B1)')
    const two = md.indexOf('2. **Stop leaves no Retry.** (P1)')
    expect(one).toBeGreaterThan(0)
    expect(two).toBeGreaterThan(one)
    expect(md).toContain('   The card says Retry with no button.')
    expect(md).toContain('   - Number to beat: 15.4%')
  })

  it('opens with highlights in scorecard order and counts turns with their denominator', () => {
    expect(md).toContain('1. `failure/video/desktop-highlights.mp4` (108 s). Failure and recovery: Stop leaves no Retry')
    expect(md).toContain('2. `core-path/video/founder-highlights.mp4` (72 s). Core path: Rich Save disabled')
    expect(md).toContain('1 completed, 1 stopped, 1 failed, of 3 recorded turns')
    expect(md).toContain('| failure | founder | 12:47:03Z | stopped | 34 s | 300 s | 4,812 | You stopped this turn. |')
    expect(md).toContain('- No test inbox for sign-up')
  })

  it('counts outcomes across journeys', () => {
    expect(tallyTurns(JOURNEYS)).toEqual({ total: 3, byOutcome: { completed: 1, stopped: 1, failed: 1 } })
  })
})

describe('collectJourneyFiles', () => {
  it('finds journey folders at any depth by their timings or videos', () => {
    const root = mkdtempSync(join(tmpdir(), 'journeys-index-'))
    dirs.push(root)
    mkdirSync(join(root, 'j1', 'video'), { recursive: true })
    writeFileSync(join(root, 'j1', 'video', 'founder-highlights.mp4'), '')
    writeFileSync(join(root, 'j1', 'timings.json'), JSON.stringify({ turns: [turn('empty', 'the turn ended without any reply text')] }))
    mkdirSync(join(root, 'j1', 'r2', 'video'), { recursive: true })
    writeFileSync(join(root, 'j1', 'r2', 'video', 'stranger-full.mp4'), '')
    mkdirSync(join(root, 'notes'))
    const found = collectJourneyFiles(root, () => 12)
    expect(found.map((j) => [j.dir, j.videos.map((v) => v.file), j.turns.length])).toEqual([
      ['j1', ['video/founder-highlights.mp4'], 1],
      ['j1/r2', ['video/stranger-full.mp4'], 0],
    ])
  })
})
