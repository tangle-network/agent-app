import { describe, it, expect } from 'vitest'
import {
  producedFromToolEvents,
  verifyCompletion,
  tokenRecallChecker,
  weightedScore,
  type CompletionRequirement,
  type ProducedItem,
} from '../src/eval/index'
import type { AppToolProducedEvent } from '../src/tools/index'

describe('producedFromToolEvents', () => {
  it('maps proposal_created → proposal item (content = title) and artifact → artifact item (content = body)', () => {
    const events: AppToolProducedEvent[] = [
      { type: 'proposal_created', proposalId: 'p1', title: 'Swap recommendation — Cohen', status: 'pending' },
      { type: 'artifact', path: 'ui/view.json', content: '{"title":"Swap comparison"}' },
    ]
    expect(producedFromToolEvents(events)).toEqual([
      { kind: 'proposal', title: 'Swap recommendation — Cohen', content: 'Swap recommendation — Cohen' },
      { kind: 'artifact', title: 'ui/view.json', content: '{"title":"Swap comparison"}' },
    ])
  })
})

describe('verifyCompletion', () => {
  const produced: ProducedItem[] = [
    { kind: 'proposal', title: 'Swap recommendation Cohen', content: 'Swap recommendation Cohen' },
    { kind: 'artifact', title: 'clients/cohen/note.md', content: 'Detailed transcript note for the Cohen call covering coverage gaps.' },
  ]

  it('passes when every requirement is satisfied by a matching kind + content', () => {
    const reqs: CompletionRequirement[] = [
      { reqId: 'r1', title: 'Swap recommendation', satisfiedBy: 'proposal' },
      { reqId: 'r2', title: 'transcript note', satisfiedBy: 'artifact' },
    ]
    const v = verifyCompletion(reqs, produced)
    expect(v.complete).toBe(true)
    expect(v.satisfied.map((s) => s.reqId).sort()).toEqual(['r1', 'r2'])
    expect(v.missing).toHaveLength(0)
  })

  it('flags no_matching_kind when a regulated requirement has no proposal', () => {
    const reqs: CompletionRequirement[] = [{ reqId: 'r1', title: 'Swap recommendation', satisfiedBy: 'proposal' }]
    const artifactOnly: ProducedItem[] = [{ kind: 'artifact', title: 'note', content: 'a swap recommendation described in prose only, at length and in detail' }]
    const v = verifyCompletion(reqs, artifactOnly)
    expect(v.complete).toBe(false)
    expect(v.missing).toEqual([{ reqId: 'r1', title: 'Swap recommendation', reason: 'no_matching_kind' }])
  })

  it('flags no_content_match when the right kind exists but content does not recall the requirement', () => {
    const reqs: CompletionRequirement[] = [{ reqId: 'r1', title: 'B2B employer outreach to Acme', satisfiedBy: 'proposal' }]
    const v = verifyCompletion(reqs, [{ kind: 'proposal', title: 'Unrelated lead first-touch', content: 'Unrelated lead first-touch' }])
    expect(v.complete).toBe(false)
    expect(v.missing[0]!.reason).toBe('no_content_match')
  })

  it('accepts any kind when satisfiedBy is omitted', () => {
    const reqs: CompletionRequirement[] = [{ reqId: 'r1', title: 'transcript note' }]
    expect(verifyCompletion(reqs, produced).complete).toBe(true)
  })

  it('throws on an empty requirement set (no vacuous pass)', () => {
    expect(() => verifyCompletion([], produced)).toThrow(/empty requirement set/)
  })
})

describe('tokenRecallChecker', () => {
  it('rejects thin content even on a token match', () => {
    const check = tokenRecallChecker(0.5, 20)
    expect(check({ reqId: 'r', title: 'swap recommendation' }, { kind: 'proposal', title: 'swap', content: 'swap' })).toBe(false)
  })
  it('honors a custom recall threshold', () => {
    const strict = tokenRecallChecker(1.0)
    // Mentions 'swap' but NOT 'recommendation' → recall 0.5 < 1.0 → fails strict.
    const item: ProducedItem = { kind: 'artifact', title: 't', content: 'a long enough body mentioning the swap economics in detail here' }
    expect(strict({ reqId: 'r', title: 'swap recommendation', satisfiedBy: 'artifact' }, item)).toBe(false)
  })
})

describe('weightedScore', () => {
  it('normalizes by the weight of scored dimensions (a missing dim does not zero the score)', () => {
    const score = weightedScore({ a: 1, b: 0.5 }, { a: 0.5, b: 0.5 })
    expect(score).toBeCloseTo(0.75, 5)
    // 'c' weighted but unscored → ignored, not treated as 0
    const partial = weightedScore({ a: 1 }, { a: 0.5, c: 0.5 })
    expect(partial).toBe(1)
  })
  it('clamps individual scores to 0..1 and returns 0 with no overlapping weights', () => {
    expect(weightedScore({ a: 5 }, { a: 1 })).toBe(1)
    expect(weightedScore({ a: -3 }, { a: 1 })).toBe(0)
    expect(weightedScore({ a: 1 }, { z: 1 })).toBe(0)
  })
})
