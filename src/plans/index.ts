/**
 * Durable-plan application-shell contract.
 *
 * The sandbox SDK owns the authoritative plan lifecycle and decision APIs.
 * This module only projects that substrate state into chat events and
 * persisted message parts that products can render and restore.
 */

export const PLAN_SUBMITTED_EVENT = 'plan.submitted' as const

/** Sandbox plan lifecycle. `preparing` is the transient submission state and
 * is retained in the projection even though the chat card normally starts at
 * `pending`. */
export type ChatPlanStatus = 'preparing' | 'pending' | 'approved' | 'rejected' | 'superseded' | 'withdrawn'

type ChatPlanBase = {
  /** The sandbox SDK calls this field `id`; the transcript projection names
   * it explicitly so it cannot collide with a message-part id. */
  planId: string
  revision: number
  title?: string
  body: string
  submittedAt: string
  /** Provider/Sandbox metadata is deliberately opaque to this package. */
  metadata?: Record<string, unknown>
  decidedBy?: string
}

/** Browser/persisted projection of the sandbox SDK's durable-plan union. */
export type ChatPlan = ChatPlanBase & (
  | { status: 'preparing' }
  | { status: 'pending' }
  | { status: 'approved'; decidedAt: string }
  | { status: 'rejected'; decidedAt: string; feedback: string }
  | { status: 'superseded'; supersededAt: string; supersededByPlanId: string }
  | { status: 'withdrawn'; withdrawnAt: string; withdrawnReason: string }
)

/** Canonical transcript part for one durable plan. */
export type ChatPlanPersistedPart = ChatPlan & { type: 'plan' }

/** Resolve the result of parsing a plan submission into success with value or failure with error */
export type ParsePlanSubmittedResult =
  | { succeeded: true; value: ChatPlan }
  | { succeeded: false; error: string }

const PLAN_STATUSES: ReadonlySet<string> = new Set([
  'preparing',
  'pending',
  'approved',
  'rejected',
  'superseded',
  'withdrawn',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

function parsePlan(record: Record<string, unknown>, defaultStatus?: ChatPlanStatus): ChatPlan | null {
  const planId = requiredString(record, 'planId') ?? requiredString(record, 'id')
  const revision = record.revision
  const body = requiredString(record, 'body')
  const submittedAt = requiredString(record, 'submittedAt')
  const status = typeof record.status === 'string' ? record.status : defaultStatus
  if (
    !planId ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    !body ||
    !submittedAt ||
    !status ||
    !PLAN_STATUSES.has(status)
  ) {
    return null
  }

  const common = {
    planId,
    revision,
    ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
    body,
    submittedAt,
    ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    ...(typeof record.decidedBy === 'string' && record.decidedBy ? { decidedBy: record.decidedBy } : {}),
  }

  if (status === 'preparing') return { ...common, status: 'preparing' }
  if (status === 'pending') return { ...common, status: 'pending' }
  if (status === 'approved') {
    const decidedAt = requiredString(record, 'decidedAt')
    return decidedAt ? { ...common, status, decidedAt } : null
  }
  if (status === 'rejected') {
    const decidedAt = requiredString(record, 'decidedAt')
    const feedback = requiredString(record, 'feedback')
    return decidedAt && feedback ? { ...common, status, decidedAt, feedback } : null
  }
  if (status === 'superseded') {
    const supersededAt = requiredString(record, 'supersededAt')
    const supersededByPlanId = requiredString(record, 'supersededByPlanId')
    return supersededAt && supersededByPlanId
      ? { ...common, status, supersededAt, supersededByPlanId }
      : null
  }

  const withdrawnAt = requiredString(record, 'withdrawnAt')
  const withdrawnReason = requiredString(record, 'withdrawnReason') ?? requiredString(record, 'reason')
  return withdrawnAt && withdrawnReason
    ? { ...common, status: 'withdrawn', withdrawnAt, withdrawnReason }
    : null
}

/** Generate a unique key string for a given plan identifier */
export function planPartKey(planId: string): string {
  return `plan:${planId}`
}

/** Generate a unique key string for a plan based on its ID and revision number */
export function planRevisionKey(planId: string, revision: number): string {
  return `plan:${planId}:revision:${revision}`
}

/** Generate a unique follow-up turn ID based on the plan ID and its outcome */
export function planFollowUpTurnId(planId: string, outcome: 'approved' | 'rejected'): string {
  return `plan:${planId}:${outcome}`
}

/** Plan status is monotonic: only a pending plan can settle. */
export function canTransitionPlanStatus(from: ChatPlanStatus, to: ChatPlanStatus): boolean {
  if (from === to) return true
  if (from === 'preparing') return to === 'pending' || to === 'superseded' || to === 'withdrawn'
  if (from === 'pending') return to === 'approved' || to === 'rejected' || to === 'superseded' || to === 'withdrawn'
  return false
}

/** Resolve a ChatPlan into its persisted part representation for storage or transmission */
export function planToPersistedPart(plan: ChatPlan): ChatPlanPersistedPart {
  return { type: 'plan', ...plan }
}

/** Resolve a persisted part object into a ChatPlan or return null if the type is not 'plan */
export function persistedPartToPlan(part: Record<string, unknown>): ChatPlan | null {
  if (String(part.type ?? '') !== 'plan') return null
  return parsePlan(part)
}

/** Parses both direct sandbox events (`data.plan`) and session envelopes
 * (`properties.plan`). Session identity is carried by the surrounding stream
 * and is deliberately not required in the payload. */
export function parsePlanSubmittedEvent(event: unknown): ParsePlanSubmittedResult {
  const root = asRecord(event)
  if (!root || root.type !== PLAN_SUBMITTED_EVENT) {
    return { succeeded: false, error: 'event is not plan.submitted' }
  }
  const plan = asRecord(asRecord(root.properties)?.plan) ?? asRecord(asRecord(root.data)?.plan)
  if (!plan) {
    return { succeeded: false, error: 'plan.submitted event carried no plan' }
  }
  const parsed = parsePlan(plan, 'pending')
  return parsed
    ? { succeeded: true, value: parsed }
    : { succeeded: false, error: 'plan.submitted event carried a malformed plan' }
}
