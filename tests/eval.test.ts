import { describe, it, expect } from 'vitest'
import {
  producedFromToolEvents,
  createTokenRecallChecker,
  extractProducedState,
  verifyCompletion,
  type TaskGold,
} from '../src/eval/index'
import type { AppToolProducedEvent } from '../src/tools/index'

const events: AppToolProducedEvent[] = [
  { type: 'proposal_created', proposalId: 'p1', title: 'Swap recommendation — Cohen', status: 'pending' },
  { type: 'artifact', path: 'clients/cohen/note.md', content: 'Detailed transcript note for the Cohen call covering coverage gaps and the renewal timeline in depth.' },
]

describe('producedFromToolEvents (the app-shell bridge)', () => {
  it('maps tool produced-events into agent-eval RuntimeEventLike shape', () => {
    const mapped = producedFromToolEvents(events)
    expect(mapped[0]).toEqual({ type: 'proposal_created', proposalId: 'p1', title: 'Swap recommendation — Cohen', status: 'pending' })
    expect(mapped[1]).toMatchObject({ type: 'artifact', name: 'clients/cohen/note.md', content: expect.stringContaining('transcript note') })
  })

  it('the bridge feeds agent-eval extractProducedState → verifyCompletion (real engine)', async () => {
    // What agent-app OWNS is the bridge: it must yield the proposal + artifact
    // the real engine's extractProducedState recognizes.
    const produced = extractProducedState(producedFromToolEvents(events))
    expect(produced.proposals.map((p) => p.title)).toEqual(['Swap recommendation — Cohen'])
    expect(produced.artifacts[0]!.path).toBe('clients/cohen/note.md')
    expect(produced.artifacts[0]!.content).toContain('transcript note')

    // And the engine's verifyCompletion runs on it: the content-rich artifact
    // requirement is credited (the proposal is gated by presence in the engine).
    const gold: TaskGold = { taskId: 't1', requirements: [{ reqId: 'r2', title: 'transcript note', satisfiedBy: 'artifact' }] }
    const verdict = await verifyCompletion(gold, produced, createTokenRecallChecker({ minContentLength: 8 }))
    expect(verdict.requirements).toHaveLength(1)
    expect(verdict.fullyComplete).toBe(true)
  })
})

describe('createTokenRecallChecker (the additive no-LLM checker)', () => {
  it('rejects thin content, accepts substantive token-recall match', async () => {
    const check = createTokenRecallChecker({ minContentLength: 20 })
    expect(await check({ reqId: 'r', title: 'swap recommendation' }, 'swap')).toMatchObject({ correct: false })
    const ok = await check({ reqId: 'r', title: 'swap recommendation' }, 'A full swap recommendation with the two-sided economics and verdict laid out.')
    expect(ok.correct).toBe(true)
  })
  it('honors a custom recall threshold', async () => {
    const strict = createTokenRecallChecker({ minRecall: 1.0, minContentLength: 8 })
    const r = await strict({ reqId: 'r', title: 'swap recommendation' }, 'a long enough body mentioning the swap economics in detail here')
    expect(r.correct).toBe(false) // 'recommendation' absent → recall 0.5 < 1.0
  })
})
