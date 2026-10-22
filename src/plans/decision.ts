/**
 * The product half of deciding a durable plan: validate what the user clicked,
 * project the sandbox SDK's plan snapshot onto the chat projection, and
 * classify a 409 as a decision that already happened. Pure; no I/O.
 */
import type { ChatPlan, ChatPlanStatus } from './index'

/** The SDK's plan snapshot, as the fields the projection reads. */
export interface DurablePlanLike {
  id: string
  revision: number
  title?: string
  body: string
  submittedAt: string
  status: ChatPlan['status']
  decidedAt?: string
  feedback?: string
  supersededAt?: string
  supersededByPlanId?: string
  withdrawnAt?: string
  reason?: string
}

export type PlanDecisionOutcome = 'approved' | 'rejected'

export type PlanDecisionBody =
  | {
      ok: true
      workspaceId: string
      threadId: string
      planId: string
      revision: number
      outcome: PlanDecisionOutcome
      feedback?: string
    }
  | { ok: false; error: string }

/** Validate a plan-decision request body. Rejection requires feedback: without
 *  it the agent has nothing to revise against. */
export function parsePlanDecisionBody(body: Record<string, unknown>): PlanDecisionBody {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
  const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
  const revision = body.revision
  const outcome = body.outcome
  if (!workspaceId) return { ok: false, error: 'Missing workspaceId' }
  if (!threadId) return { ok: false, error: 'Missing threadId' }
  if (!planId) return { ok: false, error: 'Missing planId' }
  if (!Number.isInteger(revision) || Number(revision) < 1) {
    return { ok: false, error: 'Invalid revision: expected a positive integer' }
  }
  if (outcome !== 'approved' && outcome !== 'rejected') {
    return { ok: false, error: 'Invalid outcome: expected approved or rejected' }
  }
  if (outcome === 'rejected') {
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
    if (!feedback) return { ok: false, error: 'Plan rejection feedback is required' }
    return { ok: true, workspaceId, threadId, planId, revision: Number(revision), outcome, feedback }
  }
  return { ok: true, workspaceId, threadId, planId, revision: Number(revision), outcome }
}

/** Project the SDK's plan onto the chat projection. A status whose required
 *  fields are missing is a broken projection, not a plan to render. */
export function toChatPlan(plan: DurablePlanLike): ChatPlan {
  const common = {
    planId: plan.id,
    revision: plan.revision,
    ...(plan.title ? { title: plan.title } : {}),
    body: plan.body,
    submittedAt: plan.submittedAt,
  }
  if (plan.status === 'preparing') return { ...common, status: 'preparing' }
  if (plan.status === 'pending') return { ...common, status: 'pending' }
  if (plan.status === 'approved' && plan.decidedAt) {
    return { ...common, status: 'approved', decidedAt: plan.decidedAt }
  }
  if (plan.status === 'rejected' && plan.decidedAt && plan.feedback) {
    return { ...common, status: 'rejected', decidedAt: plan.decidedAt, feedback: plan.feedback }
  }
  if (plan.status === 'superseded' && plan.supersededAt && plan.supersededByPlanId) {
    return {
      ...common,
      status: 'superseded',
      supersededAt: plan.supersededAt,
      supersededByPlanId: plan.supersededByPlanId,
    }
  }
  if (plan.status === 'withdrawn' && plan.withdrawnAt && plan.reason) {
    return { ...common, status: 'withdrawn', withdrawnAt: plan.withdrawnAt, withdrawnReason: plan.reason }
  }
  throw new Error(`Sandbox returned an incomplete ${plan.status} plan projection`)
}

/** A 409 from the sandbox is a decision that already happened; classify which
 *  one so the caller can reconcile instead of reporting a failure. */
export function durablePlanConflictCode(error: {
  status?: number
  code?: string
  message: string
}): 'plan_already_decided' | 'plan_superseded' | 'plan_withdrawn' | null {
  if (error.status !== 409) return null
  if (error.code === 'PLAN_ALREADY_DECIDED' || /already (approved|rejected|decided)/i.test(error.message)) {
    return 'plan_already_decided'
  }
  if (error.code === 'PLAN_SUPERSEDED' || /superseded/i.test(error.message)) return 'plan_superseded'
  if (error.code === 'PLAN_WITHDRAWN' || /withdrawn/i.test(error.message)) return 'plan_withdrawn'
  return null
}

const TERMINAL_PLAN_STATUSES: readonly ChatPlanStatus[] = ['approved', 'rejected', 'superseded', 'withdrawn']

export function isTerminalPlanStatus(status: ChatPlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status)
}
