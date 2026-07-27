/**
 * The adoptability guarantee behind the port split (#262): a product that wants
 * durable PLANS must not be forced to implement the answer-intent journal, and
 * a product that wants durable QUESTIONS must not be forced to implement the
 * plan-command journal.
 *
 * These are compile-time claims first and runtime claims second. `PlanOnlyStore`
 * and `InteractionOnlyStore` declare `implements` against the narrow ports and
 * define EXACTLY the methods that port names — nothing more. If either port ever
 * regains a method from the other half, `pnpm typecheck` fails here before any
 * assertion runs. The `satisfies` checks at the bottom pin the negative: neither
 * narrow store is assignable to the composed `DurableChatStore`.
 *
 * Storage is delegated to the reference in-memory store on purpose. What is
 * under test is the SHAPE of the port, not a second implementation of the
 * protocol — `store-contract.ts` covers the semantics.
 */

import { describe, expect, it } from 'vitest'

import {
  InMemoryDurableChatStateStore,
  createDurableChatScope,
  createDurableInteractionSettlement,
  createDurablePlanRoutes,
  upsertDurableInteractionAsk,
  type DurableAnswerIntentClaim,
  type DurableAnswerIntentRecord,
  type DurableChatScope,
  type DurableChatStore,
  type DurableFollowUpReceipt,
  type DurableInteractionAcknowledgement,
  type DurableInteractionGuarantee,
  type DurableInteractionProjection,
  type DurableInteractionStore,
  type DurablePlanAuthority,
  type DurablePlanAuthorityResult,
  type DurablePlanCommandClaim,
  type DurablePlanCommandKey,
  type DurablePlanCommandRecord,
  type DurablePlanEffectClaim,
  type DurablePlanEffectRecord,
  type DurablePlanProjection,
  type DurablePlanStore,
} from '../../src/durable-chat'

const scope = createDurableChatScope('workspace-a/thread-a')

/** ELEVEN methods. A plan-only adopter writes this much and no more. */
class PlanOnlyStore implements DurablePlanStore {
  private readonly inner = new InMemoryDurableChatStateStore()

  getPlanProjection(s: DurableChatScope, planId: string, revision?: number): Promise<DurablePlanProjection | null> {
    return this.inner.getPlanProjection(s, planId, revision)
  }
  putPlanProjection(s: DurableChatScope, projection: DurablePlanProjection): Promise<void> {
    return this.inner.putPlanProjection(s, projection)
  }
  listPlanProjections(s: DurableChatScope, planId?: string): Promise<DurablePlanProjection[]> {
    return this.inner.listPlanProjections(s, planId)
  }
  getPlanCommand(s: DurableChatScope, key: DurablePlanCommandKey): Promise<DurablePlanCommandRecord | null> {
    return this.inner.getPlanCommand(s, key)
  }
  claimPlanCommand(s: DurableChatScope, command: DurablePlanCommandRecord): Promise<DurablePlanCommandClaim> {
    return this.inner.claimPlanCommand(s, command)
  }
  recordPlanAuthorityResult(s: DurableChatScope, key: DurablePlanCommandKey, result: DurablePlanAuthorityResult, receipt: DurableFollowUpReceipt): Promise<void> {
    return this.inner.recordPlanAuthorityResult(s, key, result, receipt)
  }
  finalizePlanCommand(s: DurableChatScope, key: DurablePlanCommandKey): Promise<void> {
    return this.inner.finalizePlanCommand(s, key)
  }
  getPlanEffect(s: DurableChatScope, effectKey: string): Promise<DurablePlanEffectRecord | null> {
    return this.inner.getPlanEffect(s, effectKey)
  }
  claimPlanEffect(s: DurableChatScope, effect: DurablePlanEffectRecord): Promise<DurablePlanEffectClaim> {
    return this.inner.claimPlanEffect(s, effect)
  }
  completePlanEffect(s: DurableChatScope, effectKey: string): Promise<void> {
    return this.inner.completePlanEffect(s, effectKey)
  }
  failPlanEffect(s: DurableChatScope, effectKey: string, error: string): Promise<void> {
    return this.inner.failPlanEffect(s, effectKey, error)
  }
}

/** EIGHT methods. An interaction-only adopter writes this much and no more. */
class InteractionOnlyStore implements DurableInteractionStore {
  private readonly inner = new InMemoryDurableChatStateStore()

  getInteractionProjection(s: DurableChatScope, id: string): Promise<DurableInteractionProjection | null> {
    return this.inner.getInteractionProjection(s, id)
  }
  upsertInteractionProjection(s: DurableChatScope, projection: DurableInteractionProjection): Promise<DurableInteractionProjection> {
    return this.inner.upsertInteractionProjection(s, projection)
  }
  listInteractionProjections(s: DurableChatScope): Promise<DurableInteractionProjection[]> {
    return this.inner.listInteractionProjections(s)
  }
  getAnswerIntent(s: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null> {
    return this.inner.getAnswerIntent(s, intentKey)
  }
  claimAnswerIntent(s: DurableChatScope, intent: DurableAnswerIntentRecord): Promise<DurableAnswerIntentClaim> {
    return this.inner.claimAnswerIntent(s, intent)
  }
  acknowledgeAnswerIntent(s: DurableChatScope, intentKey: string, ack: DurableInteractionAcknowledgement): Promise<void> {
    return this.inner.acknowledgeAnswerIntent(s, intentKey, ack)
  }
  finalizeAnswerIntent(s: DurableChatScope, intentKey: string, guarantee?: DurableInteractionGuarantee): Promise<void> {
    return this.inner.finalizeAnswerIntent(s, intentKey, guarantee)
  }
  abortAnswerIntent(s: DurableChatScope, intentKey: string, error: string): Promise<void> {
    return this.inner.abortAnswerIntent(s, intentKey, error)
  }
}

function authorityFor(store: DurablePlanStore): DurablePlanAuthority {
  return {
    async current({ scope: s, planId }) {
      return { plan: await store.getPlanProjection(s, planId) }
    },
    async decide({ scope: s, planId, revision, decision }) {
      const plan = {
        ...(await store.getPlanProjection(s, planId, revision))!,
        status: decision,
        decidedAt: '2026-01-01T00:01:00.000Z',
      } as DurablePlanProjection
      return { plan, followUp: { turnId: 'follow-up-1', state: 'queued' } }
    },
  }
}

describe('durable-chat port split', () => {
  it('drives the full plan decision route from a store with no interaction methods', async () => {
    const store = new PlanOnlyStore()
    await store.putPlanProjection(scope, {
      planId: 'plan-1', revision: 1, status: 'pending', body: 'Do it', submittedAt: '2026-01-01T00:00:00.000Z',
    })

    const effects: string[] = []
    const routes = createDurablePlanRoutes({
      store,
      authority: authorityFor(store),
      authorize: async () => scope,
      afterDecision: async ({ effectKey }) => { effects.push(effectKey) },
    })

    const response = await routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST',
      body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
      headers: { 'content-type': 'application/json' },
    }))

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.plan).toMatchObject({ planId: 'plan-1', status: 'approved' })
    expect(body.receipt).toMatchObject({ planId: 'plan-1', decision: 'approved', turnId: 'follow-up-1' })
    expect(effects).toHaveLength(1)

    // Replay stays idempotent through the narrow port: same receipt, one decision.
    const replay = await routes.decide(new Request('https://app.test/plans/plan-1', {
      method: 'POST',
      body: JSON.stringify({ planId: 'plan-1', revision: 1, decision: 'approved' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(replay.status).toBe(200)
    expect((await replay.json() as Record<string, unknown>).receipt).toEqual(body.receipt)
  })

  it('settles an answer through a store with no plan methods', async () => {
    const store = new InteractionOnlyStore()
    await upsertDurableInteractionAsk(store, scope, {
      id: 'ask-1',
      kind: 'question',
      title: 'Which filing status?',
      answerSpec: { fields: [{ type: 'text', name: 'status', label: 'Status' }] },
    })

    const settlement = createDurableInteractionSettlement({ store, attemptKey: 'attempt-1' })
    const intent = await settlement.prepare(scope, 'ask-1', 'accepted', { status: 'single' })
    expect(intent.state).toBe('prepared')

    await settlement.acknowledge(scope, intent.intentKey, { status: 'accepted' })
    const finalized = await settlement.finalize(scope, intent.intentKey)
    expect(finalized.state).toBe('finalized')

    const projection = await store.getInteractionProjection(scope, 'ask-1')
    expect(projection).toMatchObject({ status: 'answered', answers: { status: 'single' } })
  })

  it('keeps the narrow ports genuinely narrow', () => {
    // Positive: each narrow store satisfies its own port.
    const plan = new PlanOnlyStore() satisfies DurablePlanStore
    const interaction = new InteractionOnlyStore() satisfies DurableInteractionStore

    // Negative: neither is assignable to the composed port. If the split ever
    // collapses back into one interface these `@ts-expect-error`s go unused and
    // the build fails — which is the whole point of asserting it here.
    // @ts-expect-error a plan-only store has no interaction methods
    const notComposedA: DurableChatStore = plan
    // @ts-expect-error an interaction-only store has no plan methods
    const notComposedB: DurableChatStore = interaction

    // Positive: the reference store still implements BOTH halves.
    const both = new InMemoryDurableChatStateStore() satisfies DurableChatStore

    expect([notComposedA, notComposedB, both].every(Boolean)).toBe(true)
  })
})
