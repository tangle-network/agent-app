import { describe, expect, it } from 'vitest'
import { durableChatCardsFromParts } from './durable-chat-cards'

const durablePlan = {
  type: 'plan',
  planId: 'plan-1',
  revision: 1,
  body: 'Same plan body',
  submittedAt: '2026-07-21T00:00:00.000Z',
  status: 'pending',
}

const legacyPlan = {
  type: 'interaction',
  id: 'legacy-plan',
  kind: 'plan',
  title: 'Plan',
  body: 'Same plan body',
  answerSpec: { fields: [] },
  status: 'pending',
}

describe('durableChatCardsFromParts', () => {
  it('does not suppress a content-identical legacy plan without provenance', () => {
    expect(durableChatCardsFromParts([legacyPlan, durablePlan])).toHaveLength(2)
  })

  it('suppresses a legacy plan only with matching canonical identity', () => {
    expect(durableChatCardsFromParts([
      { ...legacyPlan, planId: 'plan-1', revision: 1 },
      durablePlan,
    ])).toEqual([
      expect.objectContaining({ kind: 'plan', plan: expect.objectContaining({ planId: 'plan-1' }) }),
    ])
  })
})
