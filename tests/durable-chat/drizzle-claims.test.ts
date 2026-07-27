/**
 * The four durability scenarios #262 requires, against a real SQLite driver:
 * concurrent cross-worker claims, restart mid-journal, lease expiry and
 * takeover, and repeated effect execution.
 *
 * Concurrency is exercised over a WAL-mode FILE with one connection per
 * simulated worker. That distinction is load-bearing: better-sqlite3 is a
 * synchronous driver, so two claims issued through a single shared handle
 * simply serialize and would prove nothing about racing. Separate connections
 * contend for real database locks, which is what the compare-and-set has to
 * survive.
 *
 * A note on scope: "repeated effect execution" here asserts STORE idempotency —
 * one completed effect row per key, settle calls that can be repeated safely.
 * It is not an exactly-once execution guarantee, and no store can offer one:
 * `afterDecision` is documented as a seam the product must make idempotent
 * (`plan-routes.ts`), because the side effect lives outside the database.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  createDurableChatScope,
  createDurablePlanRoutes,
  type DurablePlanAuthority,
  type DurablePlanCommandRecord,
  type DurablePlanEffectRecord,
  type DurablePlanProjection,
} from '../../src/durable-chat'
import {
  createDurableChatTables,
  createDrizzleDurableChatStore,
  type DurableChatTables,
} from '../../src/durable-chat/drizzle'
import { openDatabase, openWorkerDatabases, type WorkerDatabases } from './db-helper'

const scope = createDurableChatScope('workspace-a/thread-a')
const STALE_AFTER_MS = 60_000

const pendingPlan: DurablePlanProjection = {
  planId: 'plan-1', revision: 1, status: 'pending',
  body: 'Do the thing', submittedAt: '2026-01-01T00:00:00.000Z',
}

function commandFor(decision: 'approved' | 'rejected'): DurablePlanCommandRecord {
  return {
    scope, planId: 'plan-1', revision: 1, decision,
    commandKey: `plan:plan-1:1:${decision}`,
    authorityIdempotencyKey: `idem-${decision}`,
    state: 'claimed', claimedAt: '2026-01-01T00:00:01.000Z',
  }
}

const effect: DurablePlanEffectRecord = {
  effectKey: 'after-decision:plan-1:1:approved',
  scope, planId: 'plan-1', revision: 1, decision: 'approved',
  state: 'claimed', claimedAt: '2026-01-01T00:00:02.000Z',
}

let open: WorkerDatabases | null = null
afterEach(() => {
  open?.close()
  open = null
})

/** N stores, each on its own connection to one shared database file. */
function makeWorkers(count: number, clocks?: Array<() => number>) {
  const tables = createDurableChatTables()
  open = openWorkerDatabases(Object.values(tables), count)
  return {
    tables,
    stores: open.workers.map((db, index) => createDrizzleDurableChatStore({
      db,
      tables,
      staleAfterMs: STALE_AFTER_MS,
      ...(clocks?.[index] ? { now: clocks[index] } : {}),
    })),
  }
}

describe('drizzle durable chat store — concurrency and leases', () => {
  describe('concurrent cross-worker claims', () => {
    it('lets exactly one of two competing decisions win, repeatedly', async () => {
      const { stores } = makeWorkers(2)
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      for (let round = 0; round < 25; round++) {
        const planId = `plan-${round}`
        const approve = { ...commandFor('approved'), planId, commandKey: `plan:${planId}:1:approved` }
        const reject = { ...commandFor('rejected'), planId, commandKey: `plan:${planId}:1:rejected` }

        // Alternate which worker goes first so neither ordering is privileged.
        const [first, second] = round % 2 === 0
          ? await Promise.all([workerA.claimPlanCommand(scope, approve), workerB.claimPlanCommand(scope, reject)])
          : await Promise.all([workerB.claimPlanCommand(scope, reject), workerA.claimPlanCommand(scope, approve)])

        const statuses = [first.status, second.status].sort()
        expect(statuses).toEqual(['claimed', 'conflict'])
        const conflict = first.status === 'conflict' ? first : second
        expect(conflict.status === 'conflict' && conflict.reason).toMatch(/competing decision for plan revision/)
      }
    })

    it('gives the same decision to one claimant and reports the other as existing', async () => {
      const { stores } = makeWorkers(2)
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      for (let round = 0; round < 25; round++) {
        const planId = `plan-${round}`
        const command = { ...commandFor('approved'), planId, commandKey: `plan:${planId}:1:approved` }

        const results = await Promise.all([
          workerA.claimPlanCommand(scope, command),
          workerB.claimPlanCommand(scope, command),
        ])
        // Exactly one owner. The loser must NOT also hold a lease.
        expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1)
        expect(results.filter((r) => r.status === 'existing')).toHaveLength(1)
        const leases = results.map((r) => (r as { lease?: string }).lease).filter(Boolean)
        expect(leases).toHaveLength(1)
      }
    })

    it('claims an effect for exactly one worker', async () => {
      const { stores } = makeWorkers(2)
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      for (let round = 0; round < 25; round++) {
        const key = `after-decision:plan-${round}:1:approved`
        const results = await Promise.all([
          workerA.claimPlanEffect(scope, { ...effect, effectKey: key }),
          workerB.claimPlanEffect(scope, { ...effect, effectKey: key }),
        ])
        expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1)
        expect(results.filter((r) => r.status === 'existing')).toHaveLength(1)
      }
    })

    it('lets only one worker own an answer intent, and conflicts on a different answer', async () => {
      const { stores } = makeWorkers(2)
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      const intent = {
        scope, interactionId: 'ask-1', attemptKey: 'attempt-1',
        intentKey: 'interaction-answer:ask-1:attempt-1',
        outcome: 'accepted' as const, data: { status: 'single' },
        state: 'prepared' as const, createdAt: '2026-01-01T00:00:03.000Z',
      }

      const same = await Promise.all([
        workerA.claimAnswerIntent(scope, intent),
        workerB.claimAnswerIntent(scope, intent),
      ])
      expect(same.filter((r) => r.status === 'claimed')).toHaveLength(1)
      expect(same.filter((r) => r.status === 'existing')).toHaveLength(1)

      // A different payload under the same key is never a takeover.
      const divergent = await workerB.claimAnswerIntent(scope, { ...intent, outcome: 'declined', data: undefined })
      expect(divergent.status).toBe('conflict')
    })
  })

  describe('restart mid-journal', () => {
    it('replays a committed decision after the claiming worker dies', async () => {
      const tables = createDurableChatTables()
      const db = openDatabase(Object.values(tables))
      const build = () => createDrizzleDurableChatStore({ db, tables, staleAfterMs: STALE_AFTER_MS })

      // Worker 1 claims, calls the authority, records the result — then dies
      // before finalizing.
      const worker1 = build()
      await worker1.putPlanProjection(scope, pendingPlan)
      const claim = await worker1.claimPlanCommand(scope, commandFor('approved'))
      expect(claim.status).toBe('claimed')
      const receipt = {
        receiptId: 'receipt-1', planId: 'plan-1', revision: 1, decision: 'approved' as const,
        turnId: 'follow-up-1', state: 'queued', authorityIdempotencyKey: 'idem-approved',
      }
      await worker1.recordPlanAuthorityResult(scope, 'plan:plan-1:1:approved', {
        plan: { ...pendingPlan, status: 'approved', decidedAt: '2026-01-01T00:01:00.000Z' },
        followUp: { turnId: 'follow-up-1', state: 'queued' },
      }, receipt)

      // Worker 2 starts cold against the same database. The committed decision
      // survives, so the retry is a lookup rather than a second agent run.
      const worker2 = build()
      const recovered = await worker2.getPlanCommand(scope, 'plan:plan-1:1:approved')
      expect(recovered).toMatchObject({ state: 'authority_committed' })
      expect(recovered?.receipt).toMatchObject({ receiptId: 'receipt-1' })

      let authorityDecisions = 0
      const authority: DurablePlanAuthority = {
        async current({ planId }) { return { plan: await worker2.getPlanProjection(scope, planId) } },
        async decide() {
          authorityDecisions++
          return {
            plan: { ...pendingPlan, status: 'approved', decidedAt: '2026-01-01T00:01:00.000Z' },
            followUp: { turnId: 'follow-up-1', state: 'queued' },
          }
        },
      }
      const effects: string[] = []
      const routes = createDurablePlanRoutes({
        store: worker2, authority, authorize: async () => scope,
        afterDecision: async ({ effectKey }) => { effects.push(effectKey) },
      })

      const response = await routes.decide(new Request('https://app.test/plans/plan-1', {
        method: 'POST',
        body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
        headers: { 'content-type': 'application/json' },
      }))
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body.replayed).toBe(true)
      expect(body.receipt).toMatchObject({ receiptId: 'receipt-1' })
      // The authority is never asked to decide twice.
      expect(authorityDecisions).toBe(0)
      expect(effects).toHaveLength(1)
    })

    it('completes an answer whose worker died between acknowledge and finalize', async () => {
      const tables = createDurableChatTables()
      const db = openDatabase(Object.values(tables))
      const build = () => createDrizzleDurableChatStore({ db, tables, staleAfterMs: STALE_AFTER_MS })
      const intentKey = 'interaction-answer:ask-1:attempt-1'
      const intent = {
        scope, interactionId: 'ask-1', attemptKey: 'attempt-1', intentKey,
        outcome: 'accepted' as const, data: { status: 'single' },
        state: 'prepared' as const, createdAt: '2026-01-01T00:00:03.000Z',
      }

      const worker1 = build()
      await worker1.upsertInteractionProjection(scope, {
        id: 'ask-1', kind: 'question', title: 'Which filing status?', fields: [], status: 'pending',
      })
      await worker1.claimAnswerIntent(scope, intent)
      await worker1.acknowledgeAnswerIntent(scope, intentKey, { acknowledged: true, at: '2026-01-01T00:00:04.000Z' })
      // Worker 1 dies here — the answer reached the sidecar but never settled.

      const worker2 = build()
      expect(await worker2.getAnswerIntent(scope, intentKey)).toMatchObject({ state: 'acknowledged' })
      await worker2.finalizeAnswerIntent(scope, intentKey, 'best-effort')

      expect(await worker2.getAnswerIntent(scope, intentKey)).toMatchObject({ state: 'finalized' })
      expect(await worker2.getInteractionProjection(scope, 'ask-1'))
        .toMatchObject({ status: 'answered', answers: { status: 'single' } })
    })
  })

  describe('lease expiry and takeover', () => {
    it('refuses takeover while the lease is live and allows it once stale', async () => {
      let clockA = 0
      let clockB = 0
      const { stores } = makeWorkers(2, [() => clockA, () => clockB])
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      const first = await workerA.claimPlanCommand(scope, commandFor('approved'))
      expect(first.status).toBe('claimed')
      const leaseA = (first as { lease?: string }).lease
      expect(leaseA).toBeTruthy()

      // Still inside the lease window: worker B must not steal a live claim.
      clockB = STALE_AFTER_MS - 1
      const tooEarly = await workerB.claimPlanCommand(scope, commandFor('approved'))
      expect(tooEarly.status).toBe('existing')
      expect((tooEarly as { lease?: string }).lease).toBeUndefined()

      // Past it: the claim is recoverable, and the takeover is flagged.
      clockB = STALE_AFTER_MS + 1
      const takeover = await workerB.claimPlanCommand(scope, commandFor('approved'))
      expect(takeover.status).toBe('claimed')
      const leaseB = (takeover as { lease?: string }).lease
      expect(leaseB).toBeTruthy()
      expect(leaseB).not.toBe(leaseA)
      expect((takeover as { takenOver?: boolean }).takenOver).toBe(true)

      // The original claimant waking up must NOT settle behind the new owner.
      await expect(workerA.finalizePlanCommand(scope, 'plan:plan-1:1:approved', leaseA))
        .rejects.toThrow(/lease was taken over/)
      // The new owner settles normally.
      await expect(workerB.finalizePlanCommand(scope, 'plan:plan-1:1:approved', leaseB)).resolves.toBeUndefined()
      expect(await workerB.getPlanCommand(scope, 'plan:plan-1:1:approved')).toMatchObject({ state: 'finalized' })
    })

    it('takes over a stale effect claim and locks out the previous holder', async () => {
      let clockA = 0
      let clockB = 0
      const { stores } = makeWorkers(2, [() => clockA, () => clockB])
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      const first = await workerA.claimPlanEffect(scope, effect)
      const leaseA = (first as { lease?: string }).lease

      clockB = STALE_AFTER_MS - 1
      expect((await workerB.claimPlanEffect(scope, effect)).status).toBe('existing')

      clockB = STALE_AFTER_MS + 1
      const takeover = await workerB.claimPlanEffect(scope, effect)
      expect(takeover.status).toBe('claimed')
      expect((takeover as { takenOver?: boolean }).takenOver).toBe(true)
      const leaseB = (takeover as { lease?: string }).lease

      await expect(workerA.completePlanEffect(scope, effect.effectKey, leaseA))
        .rejects.toThrow(/lease was taken over/)
      await workerB.completePlanEffect(scope, effect.effectKey, leaseB)
      expect(await workerB.getPlanEffect(scope, effect.effectKey)).toMatchObject({ state: 'completed' })
    })

    it('settles the route decision under the lease its claim issued', async () => {
      // A slow authority can outlive the lease. When that happens the route must
      // NOT overwrite whoever took the decision over — it degrades to
      // `projectionPending` and still returns the receipt, because the authority
      // did commit. Without the route threading the lease this is silent
      // last-writer-wins, which is why the lease has to reach the settle call.
      let clock = 0
      const { stores } = makeWorkers(2, [() => clock, () => clock])
      const [routeStore, rival] = stores as [typeof stores[0], typeof stores[0]]
      await routeStore.putPlanProjection(scope, pendingPlan)

      const authority: DurablePlanAuthority = {
        async current({ planId }) { return { plan: await routeStore.getPlanProjection(scope, planId) } },
        async decide() {
          // While the authority is working, the lease goes stale and a rival
          // worker legitimately takes the decision over.
          clock = STALE_AFTER_MS + 1
          await rival.claimPlanCommand(scope, commandFor('approved'))
          return {
            plan: { ...pendingPlan, status: 'approved', decidedAt: '2026-01-01T00:01:00.000Z' },
            followUp: { turnId: 'follow-up-1', state: 'queued' },
          }
        },
      }
      const routes = createDurablePlanRoutes({
        store: routeStore, authority, authorize: async () => scope,
        afterDecision: async () => {},
        logger: { warn: () => {}, error: () => {} },
      })

      const response = await routes.decide(new Request('https://app.test/plans/plan-1', {
        method: 'POST',
        body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
        headers: { 'content-type': 'application/json' },
      }))
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body.receipt).toMatchObject({ planId: 'plan-1', decision: 'approved' })
      // The rival still owns the command: our stale settle was refused, not applied.
      expect(body.projectionPending).toBe(true)
      expect(await routeStore.getPlanCommand(scope, 'plan:plan-1:1:approved')).toMatchObject({ state: 'claimed' })
    })

    it('settles unconditionally when no lease is passed', async () => {
      // Every pre-lease caller omits the token, and must keep working exactly as
      // before — this is what makes the lease extension additive.
      let clock = 0
      const { stores } = makeWorkers(2, [() => clock, () => clock])
      const [workerA, workerB] = stores as [typeof stores[0], typeof stores[0]]

      await workerA.claimPlanEffect(scope, effect)
      clock = STALE_AFTER_MS + 1
      await workerB.claimPlanEffect(scope, effect)
      await expect(workerA.completePlanEffect(scope, effect.effectKey)).resolves.toBeUndefined()
    })
  })

  describe('repeated effect execution', () => {
    it('keeps one effect row per key and makes settlement idempotent', async () => {
      const tables = createDurableChatTables()
      const store = createDrizzleDurableChatStore({
        db: openDatabase(Object.values(tables)), tables, staleAfterMs: STALE_AFTER_MS,
      })

      expect((await store.claimPlanEffect(scope, effect)).status).toBe('claimed')
      expect((await store.claimPlanEffect(scope, effect)).status).toBe('existing')

      await store.completePlanEffect(scope, effect.effectKey)
      await store.completePlanEffect(scope, effect.effectKey)
      expect(await store.getPlanEffect(scope, effect.effectKey)).toMatchObject({ state: 'completed' })

      // A completed effect is never re-claimed, however many times it is retried.
      expect((await store.claimPlanEffect(scope, effect)).status).toBe('existing')
    })

    it('re-claims a failed effect and clears the previous error', async () => {
      const tables = createDurableChatTables()
      const store = createDrizzleDurableChatStore({
        db: openDatabase(Object.values(tables)), tables, staleAfterMs: STALE_AFTER_MS,
      })

      await store.claimPlanEffect(scope, effect)
      await store.failPlanEffect(scope, effect.effectKey, 'effect down')
      expect(await store.getPlanEffect(scope, effect.effectKey)).toMatchObject({ state: 'error', error: 'effect down' })

      const retry = await store.claimPlanEffect(scope, effect)
      expect(retry.status).toBe('claimed')
      expect((retry as { takenOver?: boolean }).takenOver).toBe(true)
      const recleaned = await store.getPlanEffect(scope, effect.effectKey)
      expect(recleaned).toMatchObject({ state: 'claimed' })
      expect(recleaned?.error).toBeUndefined()
    })

    it('retries a failed product effect through the plan route until it lands', async () => {
      const tables = createDurableChatTables()
      const store = createDrizzleDurableChatStore({
        db: openDatabase(Object.values(tables)), tables, staleAfterMs: STALE_AFTER_MS,
      })
      await store.putPlanProjection(scope, pendingPlan)

      let authorityDecisions = 0
      const authority: DurablePlanAuthority = {
        async current({ planId }) { return { plan: await store.getPlanProjection(scope, planId) } },
        async decide() {
          authorityDecisions++
          return {
            plan: { ...pendingPlan, status: 'approved', decidedAt: '2026-01-01T00:01:00.000Z' },
            followUp: { turnId: 'follow-up-1', state: 'queued' },
          }
        },
      }

      let effectAttempts = 0
      let failNext = true
      const routes = createDurablePlanRoutes({
        store, authority, authorize: async () => scope,
        afterDecision: async () => {
          effectAttempts++
          if (failNext) { failNext = false; throw new Error('effect down') }
        },
        logger: { warn: () => {}, error: () => {} },
      })
      const request = () => new Request('https://app.test/plans/plan-1', {
        method: 'POST',
        body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
        headers: { 'content-type': 'application/json' },
      })

      const first = await routes.decide(request())
      const firstBody = await first.json() as Record<string, unknown>
      expect(firstBody.effectPending).toBe(true)

      const second = await routes.decide(request())
      const secondBody = await second.json() as Record<string, unknown>
      expect(secondBody.effectPending).toBeUndefined()
      // Same receipt, one authority decision, and the effect ran until it landed.
      expect(secondBody.receipt).toEqual(firstBody.receipt)
      expect(authorityDecisions).toBe(1)
      expect(effectAttempts).toBe(2)
      expect(await store.getPlanEffect(scope, 'after-decision:workspace-a%2Fthread-a:plan-1:1:approved'))
        .toMatchObject({ state: 'completed' })
    })
  })
})

/** Keeps `DurableChatTables` referenced for the type-only import check. */
export type _Tables = DurableChatTables
