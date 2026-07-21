import { describe, expect, it } from 'vitest'

import {
  canTransitionPlanStatus,
  parsePlanSubmittedEvent,
  persistedPartToPlan,
  planFollowUpTurnId,
  planPartKey,
  planToPersistedPart,
  type ChatPlan,
} from '../src/plans/index'

const pendingPlan: ChatPlan = {
  planId: 'plan-1',
  revision: 1,
  title: 'Launch plan',
  body: '1. Research\n2. Execute',
  submittedAt: '2026-07-21T00:00:00.000Z',
  status: 'pending',
}

describe('durable plan contract', () => {
  it('parses live and session-wrapped plan.submitted events without requiring a session id', () => {
    const sdkPlan = {
      id: 'plan-1',
      revision: 1,
      title: 'Launch plan',
      body: '1. Research\n2. Execute',
      submittedAt: '2026-07-21T00:00:00.000Z',
    }
    expect(parsePlanSubmittedEvent({ type: 'plan.submitted', data: { plan: sdkPlan } }))
      .toEqual({ succeeded: true, value: pendingPlan })
    expect(parsePlanSubmittedEvent({
      type: 'plan.submitted',
      properties: { sessionId: 'session-1', plan: sdkPlan },
    })).toEqual({ succeeded: true, value: pendingPlan })
    expect(parsePlanSubmittedEvent({
      type: 'plan.submitted',
      properties: { sessionId: 'session-1' },
      data: { plan: sdkPlan },
    })).toEqual({ succeeded: true, value: pendingPlan })
  })

  it('fails loud on malformed or unrelated events', () => {
    expect(parsePlanSubmittedEvent({ type: 'done', data: { plan: pendingPlan } }))
      .toEqual({ succeeded: false, error: 'event is not plan.submitted' })
    expect(parsePlanSubmittedEvent({ type: 'plan.submitted', data: { plan: { id: 'plan-1' } } }))
      .toEqual({ succeeded: false, error: 'plan.submitted event carried a malformed plan' })
  })

  it('round-trips every durable terminal projection through persisted parts', () => {
    const plans: ChatPlan[] = [
      pendingPlan,
      { ...pendingPlan, status: 'approved', decidedAt: '2026-07-21T00:01:00.000Z' },
      { ...pendingPlan, status: 'rejected', decidedAt: '2026-07-21T00:01:00.000Z', feedback: 'Revise it' },
      { ...pendingPlan, status: 'superseded', supersededAt: '2026-07-21T00:01:00.000Z', supersededByPlanId: 'plan-2' },
      { ...pendingPlan, status: 'withdrawn', withdrawnAt: '2026-07-21T00:01:00.000Z', withdrawnReason: 'run failed' },
    ]
    for (const plan of plans) {
      const part = planToPersistedPart(plan)
      expect(persistedPartToPlan(part)).toEqual(plan)
    }
  })

  it('accepts the SDK withdrawn reason when restoring a plan part', () => {
    expect(persistedPartToPlan({
      type: 'plan',
      planId: 'plan-1',
      revision: 1,
      body: 'Plan',
      submittedAt: '2026-07-21T00:00:00.000Z',
      status: 'withdrawn',
      withdrawnAt: '2026-07-21T00:01:00.000Z',
      reason: 'run failed',
    })).toMatchObject({ status: 'withdrawn', withdrawnReason: 'run failed' })
  })

  it('keeps stable keys and monotonic status transitions', () => {
    expect(planPartKey('plan-1')).toBe('plan:plan-1')
    expect(planFollowUpTurnId('plan-1', 'approved')).toBe('plan:plan-1:approved')
    expect(canTransitionPlanStatus('pending', 'approved')).toBe(true)
    expect(canTransitionPlanStatus('approved', 'pending')).toBe(false)
    expect(canTransitionPlanStatus('approved', 'rejected')).toBe(false)
  })
})
