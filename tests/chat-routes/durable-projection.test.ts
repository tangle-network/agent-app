import { describe, expect, it } from 'vitest'
import {
  createDurableChatEventProjection,
  createDurableChatScope,
  InMemoryDurableChatStateStore,
  upsertDurableInteractionAsk,
  recordDurableInteractionAnswer,
} from '../../src/durable-chat/index'
import {
  createSandboxChatProducer,
  withDurableChatProjection,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import type { StreamEvent } from '../../src/stream/index'

async function* events(): AsyncGenerator<StreamEvent, void, unknown> {
  yield {
    type: 'interaction',
    data: { request: {
      id: 'ask-current', kind: 'question', title: 'Current?', answerSpec: { fields: [] },
    } },
  }
  yield { type: 'interaction.cancel', data: { id: 'ask-current', reason: 'timeout' } }
  yield {
    type: 'plan.submitted',
    data: { plan: {
      id: 'plan-1', revision: 1, body: 'Research',
      submittedAt: '2026-07-21T00:00:00.000Z',
    } },
  }
}

describe('withDurableChatProjection', () => {
  it('projects any producer lane and materializes only the current turn identities', async () => {
    const store = new InMemoryDurableChatStateStore()
    const scope = createDurableChatScope('workspace/thread')
    await upsertDurableInteractionAsk(store, scope, {
      id: 'ask-old', kind: 'question', title: 'Old?', answerSpec: { fields: [] },
    })
    const producer = createSandboxChatProducer({ events: events() })
    const wrapped = withDurableChatProjection(
      producer,
      createDurableChatEventProjection({ store, scope }),
    )
    for await (const _event of wrapped.stream) { /* drain */ }

    expect(wrapped.assistantParts?.()).toEqual([
      expect.objectContaining({
        type: 'interaction', id: 'ask-current', status: 'expired', cancelReason: 'timeout',
      }),
      expect.objectContaining({ type: 'plan', planId: 'plan-1', revision: 1, status: 'pending' }),
    ])
    expect(wrapped.assistantParts?.()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ask-old' }),
    ]))
  })

  it('does not let a stale projected revision replace a newer plan part', async () => {
    const producer: ChatTurnRouteProducer = {
      stream: (async function* () {})(),
      finalText: () => '',
      assistantParts: () => [{
        type: 'plan', planId: 'plan-1', revision: 2, status: 'pending', body: 'Newest',
        submittedAt: '2026-07-21T00:01:00.000Z',
      }],
    }
    const wrapped = withDurableChatProjection(producer, {
      observe: () => undefined,
      materialize: () => [{
        type: 'plan', planId: 'plan-1', revision: 1, status: 'pending', body: 'Stale',
        submittedAt: '2026-07-21T00:00:00.000Z',
      }],
    })
    for await (const _event of wrapped.stream) { /* drain */ }

    expect(wrapped.assistantParts?.()).toEqual([
      expect.objectContaining({ type: 'plan', planId: 'plan-1', revision: 2, body: 'Newest' }),
    ])
  })

  it('ignores malformed and stale lifecycle events without aborting the stream', async () => {
    const store = new InMemoryDurableChatStateStore()
    const scope = createDurableChatScope('workspace/thread')
    await upsertDurableInteractionAsk(store, scope, {
      id: 'ask-1', kind: 'question', title: 'Current?', answerSpec: { fields: [] },
    })
    await recordDurableInteractionAnswer(store, scope, 'ask-1', 'accepted', { confirmed: true })
    await store.putPlanProjection(scope, {
      planId: 'plan-1', revision: 1, status: 'approved', body: 'Research',
      submittedAt: '2026-07-21T00:00:00.000Z', decidedAt: '2026-07-21T00:01:00.000Z',
    })
    const projection = createDurableChatEventProjection({ store, scope })

    await expect(projection.observe({ type: 'interaction', data: { request: { id: 'bad' } } })).resolves.toBeUndefined()
    await expect(projection.observe({ type: 'interaction.cancel', data: { id: 'ask-1' } })).resolves.toBeUndefined()
    await expect(projection.observe({
      type: 'plan.submitted',
      data: { plan: {
        id: 'plan-1', revision: 1, status: 'pending', body: 'Research',
        submittedAt: '2026-07-21T00:00:00.000Z',
      } },
    })).resolves.toBeUndefined()
    expect(await projection.materialize()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'interaction', id: 'ask-1', status: 'answered' }),
      expect.objectContaining({ type: 'plan', planId: 'plan-1', status: 'approved' }),
    ]))
  })
})
