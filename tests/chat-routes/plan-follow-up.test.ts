import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SandboxEvent, SandboxInstance } from '@tangle-network/sandbox'
import { describe, expect, it, vi } from 'vitest'
import {
  createD1PlanFollowUpGate,
  type D1LikeForPlanFollowUps,
  parsePlanFollowUpAttach,
  planFollowUpExecutionId,
  resolvePlanFollowUpRequest,
  streamPlanFollowUpEvents,
} from '../../src/chat-routes/plan-follow-up'
import { type ChatPlan, planFollowUpTurnId, planToPersistedPart } from '../../src/plans'
import { TURN_EVENTS_MIGRATION_SQL, TURN_STATUS_LEASE_MIGRATION_SQL } from '../../src/stream/turn-buffer'

const SESSION_ID = 'thread-1'
const PLAN_ID = 'plan-1'

const decided: ChatPlan = {
  planId: PLAN_ID,
  revision: 2,
  body: '1. File the certificate',
  submittedAt: '2026-07-23T00:00:00.000Z',
  status: 'approved',
  decidedAt: '2026-07-23T00:01:00.000Z',
}

function attach(outcome: 'approved' | 'rejected' = 'approved', revision = 2) {
  return { planId: PLAN_ID, revision, outcome, turnId: planFollowUpTurnId(PLAN_ID, revision, outcome) }
}

function d1(migration = TURN_EVENTS_MIGRATION_SQL): D1LikeForPlanFollowUps & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(migration)
  type Statement = { bind(...values: unknown[]): Statement; run(): Promise<unknown>; execute(): unknown }
  const statement = (query: string, bound: unknown[] = []): Statement => {
    const execute = () => /^\s*SELECT/i.test(query)
      ? { results: sqlite.prepare(query).all(...(bound as never[])) }
      : sqlite.prepare(query).run(...(bound as never[]))
    return { bind: (...values) => statement(query, values), run: async () => execute(), execute }
  }
  return {
    sqlite,
    prepare: (query) => statement(query),
    // Synchronous inside, like D1's single atomic request: no other batch interleaves.
    batch: async (statements) => {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((bound) => (bound as Statement).execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}

describe('plan follow-up identity', () => {
  it('matches the Platform turn id and the Sidecar execution id byte for byte', () => {
    const turnId = planFollowUpTurnId(PLAN_ID, 2, 'approved')
    expect(turnId).toBe('plan:plan-1:revision:2:approved')
    const digest = createHash('sha256').update(`${SESSION_ID}\0${turnId}`).digest('hex')
    expect(planFollowUpExecutionId(SESSION_ID, turnId)).toBe(`plan-followup-${digest}`)
  })

  it('gives each decided revision its own execution', () => {
    expect(planFollowUpExecutionId(SESSION_ID, attach('approved', 1).turnId))
      .not.toBe(planFollowUpExecutionId(SESSION_ID, attach('approved', 2).turnId))
  })

  it('refuses a descriptor whose turn id is not the derived one', () => {
    expect(parsePlanFollowUpAttach(attach())).toEqual(attach())
    expect(parsePlanFollowUpAttach({ ...attach(), turnId: 'plan:plan-1:approved' })).toBeNull()
    expect(parsePlanFollowUpAttach({ ...attach(), revision: 0 })).toBeNull()
    expect(parsePlanFollowUpAttach([attach()])).toBeNull()
  })
})

describe('resolvePlanFollowUpRequest', () => {
  const messages = [{ role: 'assistant', parts: [planToPersistedPart(decided)] }]

  it('resolves a decided plan to the Sidecar execution id', () => {
    expect(resolvePlanFollowUpRequest({ sessionId: SESSION_ID, planFollowUp: attach(), messages })).toEqual({
      ok: true,
      attach: attach(),
      executionId: planFollowUpExecutionId(SESSION_ID, attach().turnId),
    })
  })

  it('fails loud on an invalid, missing or undecided plan', () => {
    expect(resolvePlanFollowUpRequest({ sessionId: SESSION_ID, planFollowUp: { planId: PLAN_ID }, messages }))
      .toMatchObject({ ok: false, status: 400, code: 'invalid_plan_follow_up' })
    expect(resolvePlanFollowUpRequest({ sessionId: SESSION_ID, planFollowUp: attach(), messages: [] }))
      .toMatchObject({ ok: false, status: 409, code: 'plan_follow_up_missing' })
    expect(resolvePlanFollowUpRequest({ sessionId: SESSION_ID, planFollowUp: attach('rejected'), messages }))
      .toMatchObject({ ok: false, status: 409, code: 'plan_follow_up_not_decided' })
  })
})

function fakeBox(events: SandboxEvent[], capture: { options?: Record<string, unknown> }): SandboxInstance {
  return {
    streamPrompt: vi.fn(),
    session: () => ({
      events: (options: Record<string, unknown>) => {
        capture.options = options
        return (async function* () { for (const event of events) yield event })()
      },
    }),
  } as unknown as SandboxInstance
}

async function drain(stream: AsyncIterable<SandboxEvent>): Promise<SandboxEvent[]> {
  const out: SandboxEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

describe('streamPlanFollowUpEvents', () => {
  it('replays the exact execution from the start, unwraps live payloads and never prompts', async () => {
    const capture: { options?: Record<string, unknown> } = {}
    const box = fakeBox([
      { type: 'message.part.updated', data: { properties: { part: { type: 'text', text: 'live' } } } },
      { type: 'message.part.updated', data: { part: { type: 'text', text: 'replayed' } } },
      { type: 'message.part.updated', data: { type: 'message.part.updated', part: { type: 'text', text: 'typed' } } },
      { type: 'result', data: { finalText: 'ok' } },
    ] as SandboxEvent[], capture)
    const events = await drain(streamPlanFollowUpEvents(box, SESSION_ID, 'exec-1'))
    expect(box.streamPrompt).not.toHaveBeenCalled()
    expect(capture.options).toMatchObject({ executionId: 'exec-1', since: '0' })
    expect(events.map((event) => event.data)).toEqual([
      { part: { type: 'text', text: 'live' } },
      { part: { type: 'text', text: 'replayed' } },
      { part: { type: 'text', text: 'typed' } },
      { finalText: 'ok' },
    ])
  })

  it('fails instead of accepting a stream that ends without a terminal event', async () => {
    const box = fakeBox([{ type: 'message.part.updated', data: {} }] as SandboxEvent[], {})
    await expect(drain(streamPlanFollowUpEvents(box, SESSION_ID, 'exec-1'))).rejects.toThrow(/without a terminal event/)
  })

  it('fails when the execution emits nothing before the attach deadline', async () => {
    const box = {
      session: () => ({ events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) }),
    } as unknown as SandboxInstance
    await expect(drain(streamPlanFollowUpEvents(box, SESSION_ID, 'exec-1', { timeoutMs: 5 })))
      .rejects.toThrow(/did not start/)
  })
})

describe('createD1PlanFollowUpGate', () => {
  const executionId = planFollowUpExecutionId(SESSION_ID, attach().turnId)

  it('admits exactly one of two concurrent isolates and reports completion afterwards', async () => {
    const db = d1()
    const at = new Date('2026-07-27T00:00:00.000Z')
    const first = createD1PlanFollowUpGate(db, { now: () => at, createLease: () => 'lease-first' })
    const second = createD1PlanFollowUpGate(db, { now: () => at, createLease: () => 'lease-second' })
    const work = vi.fn(async () => undefined)
    const run = async (gate: typeof first) => {
      const admission = await gate.admit(executionId, SESSION_ID)
      if (!admission.admitted) return admission
      await work()
      await gate.settle(executionId, SESSION_ID, admission.lease)
      return admission
    }
    const results = await Promise.all([run(first), run(second)])
    expect(results.filter((result) => result.admitted)).toHaveLength(1)
    expect(results).toContainEqual({ admitted: false, reason: 'in_flight' })
    expect(work).toHaveBeenCalledTimes(1)
    await expect(second.admit(executionId, SESSION_ID)).resolves.toEqual({ admitted: false, reason: 'completed' })
  })

  it('reclaims a stale claim and fences the superseded lease', async () => {
    const db = d1()
    const start = new Date('2026-07-27T00:00:00.000Z')
    const original = createD1PlanFollowUpGate(db, { now: () => start, createLease: () => 'lease-original' })
    const claim = await original.admit(executionId, SESSION_ID)
    if (!claim.admitted) throw new Error('expected the original claim')
    const atBoundary = createD1PlanFollowUpGate(db, { now: () => new Date(start.getTime() + 3_600_000), createLease: () => 'lease-boundary' })
    await expect(atBoundary.admit(executionId, SESSION_ID)).resolves.toEqual({ admitted: false, reason: 'in_flight' })
    const recovery = createD1PlanFollowUpGate(db, { now: () => new Date(start.getTime() + 3_600_001), createLease: () => 'lease-recovered' })
    const recovered = await recovery.admit(executionId, SESSION_ID)
    expect(recovered).toEqual({ admitted: true, lease: 'lease-recovered' })
    await expect(original.abandon(executionId, SESSION_ID, claim.lease)).resolves.toEqual({ settled: false, reason: 'lease_lost' })
    if (!recovered.admitted) throw new Error('expected the recovered claim')
    await expect(recovery.settle(executionId, SESSION_ID, recovered.lease)).resolves.toEqual({ settled: true })
    await expect(recovery.admit(executionId, SESSION_ID)).resolves.toEqual({ admitted: false, reason: 'completed' })
  })

  it('admits a retry immediately after an abandoned attempt', async () => {
    const db = d1()
    const first = createD1PlanFollowUpGate(db, { createLease: () => 'lease-failed' })
    const claim = await first.admit(executionId, SESSION_ID)
    if (!claim.admitted) throw new Error('expected the first claim')
    await expect(first.abandon(executionId, SESSION_ID, claim.lease)).resolves.toEqual({ settled: true })
    await expect(createD1PlanFollowUpGate(db, { createLease: () => 'lease-retry' }).admit(executionId, SESSION_ID))
      .resolves.toEqual({ admitted: true, lease: 'lease-retry' })
  })

  it('upgrades a turn_status table created before the lease column', async () => {
    const legacy = TURN_EVENTS_MIGRATION_SQL.replace(',\n  leaseToken TEXT', '')
    expect(legacy).not.toContain('leaseToken')
    const db = d1(legacy)
    await expect(createD1PlanFollowUpGate(db).admit(executionId, SESSION_ID)).rejects.toThrow()
    db.sqlite.exec(TURN_STATUS_LEASE_MIGRATION_SQL)
    await expect(createD1PlanFollowUpGate(db, { createLease: () => 'lease' }).admit(executionId, SESSION_ID))
      .resolves.toEqual({ admitted: true, lease: 'lease' })
  })
})
