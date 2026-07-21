import { describe, expect, it } from 'vitest'

import {
  InMemoryDurableChatStateStore,
  createDurableChatScope,
  createDurableInteractionProjectionAdapter,
  createDurableInteractionRoutePersistence,
  createDurableInteractionSettlement,
  createDurablePlanRoutes,
  recordDurableInteractionAnswer,
  recordDurableInteractionCancel,
  upsertDurableInteractionAsk,
  type DurablePlanAuthority,
  type DurablePlanProjection,
} from '../src/durable-chat'

const scope = createDurableChatScope('workspace-a/thread-a')
const otherScope = createDurableChatScope('workspace-b/thread-a')
const pending: DurablePlanProjection = {
  planId: 'plan-1', revision: 1, status: 'pending', body: 'Do it', submittedAt: '2026-01-01T00:00:00.000Z',
}

function authorityFor(store: InMemoryDurableChatStateStore): DurablePlanAuthority {
  return {
    async current({ scope: currentScope, planId }) {
      return { plan: await store.getPlanProjection(currentScope, planId) }
    },
    async decide({ scope: currentScope, planId, revision, decision, idempotencyKey }) {
      const plan = {
        ...(await store.getPlanProjection(currentScope, planId, revision))!,
        status: decision,
        decidedAt: '2026-01-01T00:01:00.000Z',
        ...(decision === 'rejected' ? { feedback: 'no' } : {}),
      } as DurablePlanProjection
      return { plan, followUp: { turnId: 'follow-up-1', state: 'queued' }, idempotent: idempotencyKey.endsWith(decision) }
    },
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('durable chat server contracts', () => {
  it('requires a submitted projection, returns stable receipts, and retries effects', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    let effects = 0
    let fail = true
    const routes = createDurablePlanRoutes({
      store, authority: authorityFor(store), authorize: async () => scope,
      afterDecision: async () => { effects++; if (fail) { fail = false; throw new Error('effect down') } },
    })
    const request = () => new Request('https://app.test/plans/plan-1', {
      method: 'POST', body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
      headers: { 'content-type': 'application/json' },
    })
    const first = await routes.decide(request())
    expect(first.status).toBe(200)
    const firstBody = await json(first)
    expect(firstBody.receipt).toMatchObject({ planId: 'plan-1', decision: 'approved', turnId: 'follow-up-1' })
    expect(firstBody.effectPending).toBe(true)
    const second = await routes.decide(request())
    expect(second.status).toBe(200)
    const secondBody = await json(second)
    expect(secondBody.receipt).toEqual(firstBody.receipt)
    expect(secondBody.effectPending).toBeUndefined()
    expect(effects).toBe(2)
  })

  it('isolates scopes and rejects competing decisions', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    const routes = createDurablePlanRoutes({
      store, authority: authorityFor(store), authorize: async () => scope, afterDecision: () => undefined,
    })
    const decide = (decision: string) => routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST', body: JSON.stringify({ planId: 'plan-1', revision: 1, decision }), headers: { 'content-type': 'application/json' },
    }))
    expect((await decide('approved')).status).toBe(200)
    expect((await decide('rejected')).status).toBe(409)
    expect(await store.getPlanProjection(otherScope, 'plan-1')).toBeNull()
  })

  it('reconciles an ambiguous authority commit and returns a deterministic attachment receipt', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    let authoritative: DurablePlanProjection = pending
    const authority: DurablePlanAuthority = {
      current: async () => ({ plan: authoritative }),
      decide: async () => {
        authoritative = {
          ...pending,
          status: 'approved',
          decidedAt: '2026-01-01T00:01:00.000Z',
        }
        throw new Error('response lost after commit')
      },
    }
    const routes = createDurablePlanRoutes({
      store, authority, authorize: async () => scope, afterDecision: () => undefined,
    })
    const response = await routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
    }))
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      plan: { status: 'approved' },
      receipt: { turnId: 'plan:plan-1:approved', planId: 'plan-1', revision: 1 },
    })
  })

  it('returns the committed receipt even when projection persistence fails', async () => {
    class FailingProjectionStore extends InMemoryDurableChatStateStore {
      fail = false
      override async recordPlanAuthorityResult(): Promise<void> {
        if (this.fail) throw new Error('command store down')
      }
      override async putPlanProjection(nextScope: typeof scope, plan: DurablePlanProjection): Promise<void> {
        if (this.fail) throw new Error('projection store down')
        await super.putPlanProjection(nextScope, plan)
      }
    }
    const store = new FailingProjectionStore()
    await store.putPlanProjection(scope, pending)
    store.fail = true
    const routes = createDurablePlanRoutes({
      store, authority: authorityFor(store), authorize: async () => scope,
      afterDecision: () => undefined,
      logger: { warn: () => {}, error: () => {} },
    })
    const response = await routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
    }))
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      receipt: { turnId: 'follow-up-1' },
      projectionPending: true,
    })
  })

  it('keeps cancel tombstones and settles duplicate answers idempotently', async () => {
    const store = new InMemoryDurableChatStateStore()
    const ask = { id: 'ask-1', kind: 'question', title: 'Name?', answerSpec: { fields: [] } }
    const tombstone = await recordDurableInteractionCancel(store, scope, ask.id, 'timeout')
    expect(tombstone.status).toBe('expired')
    const late = await upsertDurableInteractionAsk(store, scope, ask)
    expect(late.status).toBe('expired')
    expect(late.kind).toBe('question')

    const ask2 = await upsertDurableInteractionAsk(store, scope, { ...ask, id: 'ask-2', title: 'Age?' })
    const answered = await recordDurableInteractionAnswer(store, scope, ask2.id, 'accepted', { count: 3 })
    expect(answered.answers).toEqual({ count: 3 })
    await expect(recordDurableInteractionCancel(store, scope, ask2.id, 'agent')).rejects.toThrow()
  })

  it('allows a later turn to ask the same question after the prior ask settles', async () => {
    const store = new InMemoryDurableChatStateStore()
    const request = { kind: 'question', title: 'Continue?', answerSpec: { fields: [] } }
    await upsertDurableInteractionAsk(store, scope, { ...request, id: 'ask-first' })
    await recordDurableInteractionAnswer(store, scope, 'ask-first', 'accepted', { confirmed: true })

    const later = await upsertDurableInteractionAsk(store, scope, { ...request, id: 'ask-later' })
    expect(later).toMatchObject({ id: 'ask-later', status: 'pending' })
  })

  it('rejects a stale preparing snapshot after a plan is pending', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    await expect(store.putPlanProjection(scope, { ...pending, status: 'preparing' })).rejects.toThrow(
      'conflicting plan projection',
    )
    expect(await store.getPlanProjection(scope, pending.planId, pending.revision)).toEqual(pending)
  })

  it('rejects same-revision plan content mutation', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    await expect(store.putPlanProjection(scope, { ...pending, body: 'Different' })).rejects.toThrow(
      'plan content changed without a new revision',
    )
  })

  it('prefers a local terminal plan over a stale authority snapshot', async () => {
    const store = new InMemoryDurableChatStateStore()
    const approved = { ...pending, status: 'approved', decidedAt: '2026-01-01T00:01:00.000Z' } as DurablePlanProjection
    await store.putPlanProjection(scope, pending)
    await store.putPlanProjection(scope, approved)
    const routes = createDurablePlanRoutes({
      store,
      authority: { current: async () => ({ plan: pending }), decide: async () => { throw new Error('unused') } },
      authorize: async () => scope,
      afterDecision: () => undefined,
    })

    const response = await routes.current(new Request('https://app.test/plans/plan-1'))
    expect(await json(response)).toMatchObject({ plan: { status: 'approved' } })
  })

  it('heals a pending decision effect from local state while authority is unavailable', async () => {
    const store = new InMemoryDurableChatStateStore()
    await store.putPlanProjection(scope, pending)
    let authorityDown = false
    let effects = 0
    const authority: DurablePlanAuthority = {
      current: async () => {
        if (authorityDown) throw new Error('authority down')
        return { plan: await store.getPlanProjection(scope, pending.planId) }
      },
      decide: async ({ decision }) => ({
        plan: {
          ...pending,
          status: decision,
          decidedAt: '2026-01-01T00:01:00.000Z',
          ...(decision === 'rejected' ? { feedback: 'no' } : {}),
        } as DurablePlanProjection,
        followUp: { turnId: 'follow-up-1', state: 'running' },
      }),
    }
    const routes = createDurablePlanRoutes({
      store,
      authority,
      authorize: async () => scope,
      afterDecision: async () => {
        effects += 1
        if (effects === 1) throw new Error('effect down')
      },
      logger: { warn: () => {}, error: () => {} },
    })
    const decided = await routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
    }))
    expect(await json(decided)).toMatchObject({ effectPending: true })

    authorityDown = true
    const restored = await routes.current(new Request('https://app.test/plans/plan-1'))
    expect(restored.status).toBe(200)
    expect((await json(restored)).effectPending).toBeUndefined()
    expect(effects).toBe(2)
  })

  it('keeps delimiter-bearing scopes and ids isolated', async () => {
    const store = new InMemoryDurableChatStateStore()
    const firstScope = createDurableChatScope('tenant\u0000thread')
    const secondScope = createDurableChatScope('tenant')
    await store.putPlanProjection(firstScope, { ...pending, planId: 'plan' })
    await store.putPlanProjection(secondScope, { ...pending, planId: 'thread\u0000plan' })

    expect(await store.getPlanProjection(firstScope, 'plan')).toMatchObject({ planId: 'plan' })
    expect(await store.getPlanProjection(secondScope, 'thread\u0000plan')).toMatchObject({ planId: 'thread\u0000plan' })
  })

  it('projects lifecycle state into transcript parts and bridges acknowledged route answers', async () => {
    const store = new InMemoryDurableChatStateStore()
    const request = {
      id: 'ask-route', kind: 'question', title: 'Confirm?', answerSpec: { fields: [] },
    }
    const projection = createDurableInteractionProjectionAdapter({ store, scope })
    await projection.upsertAsk(request)
    expect(await projection.materialize()).toEqual([expect.objectContaining({
      type: 'interaction', id: 'ask-route', status: 'pending',
    })])

    const persistence = createDurableInteractionRoutePersistence({
      store,
      guarantee: 'reconciled',
      scope: async () => scope,
      reconcileAuthority: async () => ({ acknowledged: true, status: 'accepted' }),
    })
    const routeArgs = {
      request: new Request('https://app.test/interactions'),
      body: { attemptKey: 'attempt-route' },
      answer: { ok: true as const, id: 'ask-route', outcome: 'accepted' as const, data: { confirmed: true } },
      connection: { runtimeUrl: 'https://runtime.test', sessionId: 'session-1' },
      outstanding: [request],
      answeredRequest: request,
      duplicateRequests: [],
      attemptKey: 'attempt-route',
    }
    const prepared = await persistence.prepare(routeArgs)
    await persistence.acknowledge({ ...routeArgs, prepared, duplicateIds: [] })
    await persistence.finalize({ ...routeArgs, prepared, duplicateIds: [] })
    expect(await projection.materialize()).toEqual([expect.objectContaining({
      type: 'interaction', id: 'ask-route', status: 'answered', answers: { confirmed: true },
    })])
  })

  it('persists caller-created answer attempts and reconciles them', async () => {
    const store = new InMemoryDurableChatStateStore()
    await upsertDurableInteractionAsk(store, scope, {
      id: 'ask-3', kind: 'question', title: 'Confirm?', answerSpec: { fields: [] },
    })
    const settlement = createDurableInteractionSettlement({ store, attemptKey: 'attempt-1', guarantee: 'reconciled' })
    const prepared = await settlement.prepare(scope, 'ask-3', 'accepted', { answer: true })
    const retry = await settlement.prepare(scope, 'ask-3', 'accepted', { answer: true })
    expect(retry.intentKey).toBe(prepared.intentKey)
    await settlement.acknowledge(scope, prepared.intentKey, { status: 'accepted' })
    const final = await settlement.finalize(scope, prepared.intentKey)
    expect(final.state).toBe('finalized')
    expect(final.guarantee).toBe('reconciled')
    expect(await store.getInteractionProjection(scope, 'ask-3')).toMatchObject({
      status: 'answered',
      answers: { answer: true },
    })
  })
})
