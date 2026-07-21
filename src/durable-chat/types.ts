import type {
  ChatInteraction,
  ChatInteractionField,
  ChatInteractionStatus,
  InteractionAnswerValue,
  InteractionAnswers,
} from '../interactions/contract'
import type { ChatPlan, ChatPlanStatus } from '../plans/index'

/** An authorization-derived tenant/thread scope.  Consumers should only
 * create this value after authenticating the request; the route never accepts
 * an identity or scope from the request body. */
export type DurableChatScope = string & { readonly __durableChatScope: unique symbol }

export function createDurableChatScope(value: string): DurableChatScope {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('durable chat scope must be a non-empty string')
  return value as DurableChatScope
}

export function durableChatScopeKey(scope: DurableChatScope): string {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('durable chat scope is required')
  return scope
}

export type DurablePlanDecision = 'approved' | 'rejected'
export type DurablePlanAuthorityDecision = DurablePlanDecision | 'approve' | 'reject'

/** Projection retained by a durable store.  It is intentionally compatible
 * with the browser `/plans` projection and adds no product-specific fields. */
export type DurablePlanProjection = ChatPlan & {
  metadata?: Record<string, unknown>
  decidedBy?: string
}

export type DurablePlanCommandKey = string

export type DurablePlanCommandState =
  | 'claimed'
  | 'authority_committed'
  | 'finalized'
  | 'conflicted'

export interface DurablePlanCommandRecord {
  scope: DurableChatScope
  planId: string
  revision: number
  decision: DurablePlanDecision
  commandKey: DurablePlanCommandKey
  authorityIdempotencyKey: string
  state: DurablePlanCommandState
  claimedAt: string
  authorityResult?: DurablePlanAuthorityResult
  receipt?: DurableFollowUpReceipt
  conflict?: string
}

export interface DurablePlanAuthorityCurrentResult {
  /** Authoritative state. `null` means the authority has forgotten the plan. */
  plan: DurablePlanProjection | null
  receipt?: DurableFollowUpReceipt
}

export interface DurableFollowUpReceipt {
  /** Stable for a scope + plan + revision + decision. */
  receiptId: string
  planId: string
  revision: number
  decision: DurablePlanDecision
  turnId: string
  state: string
  /** Authority's stable idempotency key, useful when reconciling. */
  authorityIdempotencyKey: string
}

export interface DurablePlanAuthorityResult {
  /** Authority's final plan projection. */
  plan: DurablePlanProjection
  /** Sandbox-style follow-up result. */
  followUp: { turnId: string; state: string }
  /** True when the authority served a previously committed decision. */
  idempotent?: boolean
  /** Stable authority operation id, if the provider has one. */
  authorityId?: string
  receipt?: DurableFollowUpReceipt
}

/** Structural port to Sandbox (or another durable plan authority). */
export interface DurablePlanAuthority {
  current(args: {
    scope: DurableChatScope
    planId: string
    revision?: number
  }): Promise<DurablePlanAuthorityCurrentResult | DurablePlanProjection | null>
  decide(args: {
    scope: DurableChatScope
    planId: string
    revision: number
    decision: DurablePlanDecision
    feedback?: string
    idempotencyKey: string
  }): Promise<DurablePlanAuthorityResult>
}

export interface DurablePlanEffectRecord {
  effectKey: string
  scope: DurableChatScope
  planId: string
  revision: number
  decision: DurablePlanDecision
  state: 'claimed' | 'completed' | 'error'
  claimedAt: string
  completedAt?: string
  error?: string
}

export interface DurablePlanStore {
  getPlanProjection(scope: DurableChatScope, planId: string, revision?: number): Promise<DurablePlanProjection | null>
  putPlanProjection(scope: DurableChatScope, projection: DurablePlanProjection): Promise<void>
  listPlanProjections?(scope: DurableChatScope, planId?: string): Promise<DurablePlanProjection[]>
  getPlanCommand(scope: DurableChatScope, commandKey: DurablePlanCommandKey): Promise<DurablePlanCommandRecord | null>
  claimPlanCommand(scope: DurableChatScope, command: DurablePlanCommandRecord): Promise<
    | { status: 'claimed'; record: DurablePlanCommandRecord }
    | { status: 'existing'; record: DurablePlanCommandRecord }
    | { status: 'conflict'; record?: DurablePlanCommandRecord; reason: string }
  >
  recordPlanAuthorityResult(scope: DurableChatScope, commandKey: DurablePlanCommandKey, result: DurablePlanAuthorityResult, receipt: DurableFollowUpReceipt): Promise<void>
  finalizePlanCommand(scope: DurableChatScope, commandKey: DurablePlanCommandKey): Promise<void>
  getPlanEffect(scope: DurableChatScope, effectKey: string): Promise<DurablePlanEffectRecord | null>
  claimPlanEffect(scope: DurableChatScope, effect: DurablePlanEffectRecord): Promise<
    | { status: 'claimed'; record: DurablePlanEffectRecord }
    | { status: 'existing'; record: DurablePlanEffectRecord }
  >
  completePlanEffect(scope: DurableChatScope, effectKey: string): Promise<void>
  failPlanEffect(scope: DurableChatScope, effectKey: string, error: string): Promise<void>

  getInteractionProjection(scope: DurableChatScope, interactionId: string): Promise<DurableInteractionProjection | null>
  upsertInteractionProjection(scope: DurableChatScope, projection: DurableInteractionProjection): Promise<DurableInteractionProjection>
  listInteractionProjections?(scope: DurableChatScope): Promise<DurableInteractionProjection[]>
  getAnswerIntent(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null>
  claimAnswerIntent(scope: DurableChatScope, intent: DurableAnswerIntentRecord): Promise<
    | { status: 'claimed'; record: DurableAnswerIntentRecord }
    | { status: 'existing'; record: DurableAnswerIntentRecord }
    | { status: 'conflict'; record?: DurableAnswerIntentRecord; reason: string }
  >
  acknowledgeAnswerIntent(scope: DurableChatScope, intentKey: string, acknowledgement: DurableInteractionAcknowledgement): Promise<void>
  /** Atomically settle the interaction projection (including semantic aliases)
   * from the acknowledged intent and mark the intent finalized. */
  finalizeAnswerIntent(scope: DurableChatScope, intentKey: string, guarantee?: DurableInteractionGuarantee): Promise<void>
  abortAnswerIntent(scope: DurableChatScope, intentKey: string, error: string): Promise<void>
}

/** Alias used by adapters that store all durable chat state in one port. */
export type DurableChatStateStore = DurablePlanStore
export type DurablePlanStateStore = DurablePlanStore
export type DurablePlanCommandJournal = Pick<DurablePlanStore, 'getPlanCommand' | 'claimPlanCommand' | 'recordPlanAuthorityResult' | 'finalizePlanCommand'>
export type DurableAnswerIntentJournal = Pick<DurablePlanStore, 'getAnswerIntent' | 'claimAnswerIntent' | 'acknowledgeAnswerIntent' | 'finalizeAnswerIntent' | 'abortAnswerIntent'>

export interface DurableInteractionProjection extends ChatInteraction {
  /** Sequence/event identity used to make ask replays idempotent. */
  eventId?: string
  semanticKey?: string
  /** A cancel-before-ask row is a terminal tombstone. */
  tombstone?: boolean
  updatedAt?: string
}

export type DurableAnswerIntentState = 'prepared' | 'acknowledged' | 'finalized' | 'aborted'

export interface DurableAnswerIntentRecord {
  scope: DurableChatScope
  interactionId: string
  attemptKey: string
  intentKey: string
  outcome: 'accepted' | 'declined'
  data?: Record<string, InteractionAnswerValue>
  state: DurableAnswerIntentState
  guarantee?: DurableInteractionGuarantee
  acknowledgement?: DurableInteractionAcknowledgement
  createdAt: string
  finalizedAt?: string
  error?: string
}

export interface DurableInteractionAcknowledgement {
  acknowledged: true
  authorityId?: string
  status?: string
  at?: string
}

export type DurableInteractionGuarantee = 'reconciled' | 'best-effort'

export interface DurableInteractionSettlementOptions {
  /** Caller-created and stable across retries/reconnects. */
  attemptKey: string
  guarantee?: DurableInteractionGuarantee
  now?: () => string
}

export interface DurableInteractionSettlement {
  prepare(scope: DurableChatScope, interactionId: string, outcome: 'accepted' | 'declined', data?: Record<string, InteractionAnswerValue>): Promise<DurableAnswerIntentRecord>
  acknowledge(scope: DurableChatScope, intentKey: string, acknowledgement?: Omit<DurableInteractionAcknowledgement, 'acknowledged'>): Promise<DurableAnswerIntentRecord>
  finalize(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord>
  abort(scope: DurableChatScope, intentKey: string, error: string): Promise<DurableAnswerIntentRecord>
  reconcile(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null>
}

export function normalizePlanDecision(value: unknown): DurablePlanDecision | null {
  if (value === 'approved' || value === 'approve') return 'approved'
  if (value === 'rejected' || value === 'reject') return 'rejected'
  return null
}

export function planCommandKey(planId: string, revision: number, decision: DurablePlanDecision): string {
  return `plan:${encodeURIComponent(planId)}:${revision}:${decision}`
}

export function planAuthorityIdempotencyKey(scope: DurableChatScope, planId: string, revision: number, decision: DurablePlanDecision): string {
  return `durable-plan:${encodeURIComponent(durableChatScopeKey(scope))}:${encodeURIComponent(planId)}:${revision}:${decision}`
}

export function planEffectKey(scope: DurableChatScope, planId: string, revision: number, decision: DurablePlanDecision): string {
  return `after-decision:${encodeURIComponent(durableChatScopeKey(scope))}:${encodeURIComponent(planId)}:${revision}:${decision}`
}

export function stablePlanReceipt(
  scope: DurableChatScope,
  planId: string,
  revision: number,
  decision: DurablePlanDecision,
  result: Pick<DurablePlanAuthorityResult, 'followUp'>,
): DurableFollowUpReceipt {
  const authorityIdempotencyKey = planAuthorityIdempotencyKey(scope, planId, revision, decision)
  return {
    receiptId: `receipt:${authorityIdempotencyKey}`,
    planId,
    revision,
    decision,
    turnId: result.followUp.turnId,
    state: result.followUp.state,
    authorityIdempotencyKey,
  }
}
