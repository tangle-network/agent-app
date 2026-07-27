/**
 * The reconciliation ceiling (#262).
 *
 * Three claims, in order of how much they matter:
 *
 *  1. A settled intent records the guarantee that was actually achieved. The old
 *     default stamped `reconciled` on settlements where nothing reconciled, and
 *     that wrong value persisted in the database rather than merely misleading a
 *     log line.
 *  2. Crash recovery needs no product code and no upstream lookup — the durable
 *     intent journal is itself the evidence. This is the part the issue assumed
 *     was missing.
 *  3. `reconciled` cannot be selected without something to reconcile against.
 */

import { describe, expect, it } from 'vitest'

import {
  InMemoryDurableChatStateStore,
  createDurableChatScope,
  createDurableInteractionRoutePersistence,
  createDurableInteractionSettlement,
  createSidecarAbsenceReconciler,
  upsertDurableInteractionAsk,
  type DurableInteractionProjection,
} from '../../src/durable-chat'
import type { DurableInteractionRouteArgs } from '../../src/interactions/route'

const scope = createDurableChatScope('workspace-a/thread-a')
const askRequest = { id: 'ask-1', kind: 'question', title: 'Continue?', answerSpec: { fields: [] } }

async function seededStore() {
  const store = new InMemoryDurableChatStateStore()
  await upsertDurableInteractionAsk(store, scope, askRequest)
  return store
}

/**
 * Minimal stand-in for the route args the persistence adapter consumes. Only
 * `attemptKey` and `answer` are read on these paths; the rest of the real shape
 * (request, connection, outstanding snapshot) is the route's business.
 */
function routeArgs(
  attemptKey: string,
  outcome: 'accepted' | 'declined' = 'accepted',
): DurableInteractionRouteArgs {
  return {
    attemptKey,
    answer: { ok: true, id: 'ask-1', outcome, data: { confirmed: true } },
  } as unknown as DurableInteractionRouteArgs
}

describe('durable interaction guarantee', () => {
  it('records best-effort when nothing reconciled', async () => {
    const store = await seededStore()
    const settlement = createDurableInteractionSettlement({ store, attemptKey: 'attempt-1' })

    const intent = await settlement.prepare(scope, 'ask-1', 'accepted', { confirmed: true })
    // The PREPARED record must not claim a reconciliation up front either — it
    // is persisted, and a crash leaves that claim behind.
    expect(intent.guarantee).toBe('best-effort')

    await settlement.acknowledge(scope, intent.intentKey)
    const finalized = await settlement.finalize(scope, intent.intentKey)
    expect(finalized.state).toBe('finalized')
    expect(finalized.guarantee).toBe('best-effort')
  })

  it('keeps an explicitly selected guarantee', async () => {
    const store = await seededStore()
    const settlement = createDurableInteractionSettlement({
      store,
      attemptKey: 'attempt-1',
      guarantee: 'reconciled',
      reconcileAuthority: async () => ({ acknowledged: true, status: 'confirmed' }),
    })
    const intent = await settlement.prepare(scope, 'ask-1', 'accepted', { confirmed: true })
    expect(intent.guarantee).toBe('reconciled')
  })
})

describe('crash recovery without a reconcileAuthority', () => {
  it('settles a retry whose earlier attempt was acknowledged but never finalized', async () => {
    const store = await seededStore()
    const persistence = createDurableInteractionRoutePersistence({
      store, guarantee: 'best-effort', scope: async () => scope,
    })

    // Attempt 1: the answer POST succeeded and was acknowledged, then the
    // process died before finalizing.
    const first = await persistence.prepare(routeArgs('attempt-1'))
    await persistence.acknowledge({ ...routeArgs('attempt-1'), prepared: first, duplicateIds: [] } as never)

    // Attempt 2 carries the SAME attemptKey. With no authority wired at all, the
    // journal alone proves the answer landed.
    const retry = await persistence.prepare(routeArgs('attempt-1'))
    const outcome = await persistence.reconcile({ ...routeArgs('attempt-1'), prepared: retry } as never)
    expect(outcome).toEqual({ settled: true })

    // ...and the transcript row settled with it.
    expect(await store.getInteractionProjection(scope, 'ask-1'))
      .toMatchObject({ status: 'answered', answers: { confirmed: true } })
  })

  it('reports an already-finalized attempt as settled', async () => {
    const store = await seededStore()
    const persistence = createDurableInteractionRoutePersistence({
      store, guarantee: 'best-effort', scope: async () => scope,
    })
    const prepared = await persistence.prepare(routeArgs('attempt-1'))
    await persistence.acknowledge({ ...routeArgs('attempt-1'), prepared, duplicateIds: [] } as never)
    await persistence.finalize({ ...routeArgs('attempt-1'), prepared, duplicateIds: [] } as never)

    const retry = await persistence.prepare(routeArgs('attempt-1'))
    expect(await persistence.reconcile({ ...routeArgs('attempt-1'), prepared: retry } as never))
      .toEqual({ settled: true })
  })

  it('does not claim settlement for an attempt that never got past prepare', async () => {
    // This is the residual gap the upstream endpoint would close: a POST may
    // have succeeded and been lost before acknowledgement. Reporting it settled
    // would be a guess, so the route must keep it unsettled and retryable.
    const store = await seededStore()
    const persistence = createDurableInteractionRoutePersistence({
      store, guarantee: 'best-effort', scope: async () => scope,
    })
    const prepared = await persistence.prepare(routeArgs('attempt-1'))
    expect(await persistence.reconcile({ ...routeArgs('attempt-1'), prepared } as never))
      .toEqual({ settled: false })
  })
})

describe('reconciled requires something to reconcile against', () => {
  it('refuses to construct without an authority', () => {
    const store = new InMemoryDurableChatStateStore()
    expect(() => createDurableInteractionRoutePersistence({
      store, guarantee: 'reconciled', scope: async () => scope,
    } as never)).toThrow(/requires a reconcileAuthority/)
  })

  it('constructs when an authority is supplied', () => {
    const store = new InMemoryDurableChatStateStore()
    expect(() => createDurableInteractionRoutePersistence({
      store,
      guarantee: 'reconciled',
      scope: async () => scope,
      reconcileAuthority: async () => null,
    })).not.toThrow()
  })
})

describe('createSidecarAbsenceReconciler', () => {
  const intent = {
    scope, interactionId: 'ask-1', attemptKey: 'attempt-1',
    intentKey: 'interaction-answer:ask-1:attempt-1',
    outcome: 'accepted' as const, state: 'prepared' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  it('returns null while the ask is still outstanding', async () => {
    const reconcile = createSidecarAbsenceReconciler({ now: () => '2026-01-01T00:00:05.000Z' })
    expect(await reconcile({ scope, intent, outstanding: [{ id: 'ask-1' }] })).toBeNull()
  })

  it('acknowledges an ask that has left the registry, labelled for what it proves', async () => {
    const reconcile = createSidecarAbsenceReconciler({ now: () => '2026-01-01T00:00:05.000Z' })
    // `absent-from-registry`, not "confirmed": the ask is settled, but this
    // signal cannot attribute the settlement to THIS answer.
    expect(await reconcile({ scope, intent, outstanding: [{ id: 'other' }] }))
      .toEqual({ acknowledged: true, status: 'absent-from-registry', at: '2026-01-01T00:00:05.000Z' })
  })

  it('re-reads the registry when a fresh snapshot is available', async () => {
    let calls = 0
    const reconcile = createSidecarAbsenceReconciler({
      now: () => '2026-01-01T00:00:05.000Z',
      listOutstanding: async () => { calls++; return [{ id: 'ask-1' }] },
    })
    // A stale pre-answer snapshot must not decide this: the caller's list says
    // the ask is gone, the live list says it is still pending, and the live one
    // is the one that counts.
    expect(await reconcile({ scope, intent, outstanding: [] })).toBeNull()
    expect(calls).toBe(1)
  })
})

/** Keeps the projection type referenced for the type-only import check. */
export type _Projection = DurableInteractionProjection
