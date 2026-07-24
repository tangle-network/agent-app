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

/** Create a durable chat scope from a non-empty string value */
export function createDurableChatScope(value: string): DurableChatScope {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('durable chat scope must be a non-empty string')
  return value as DurableChatScope
}

/** Resolve a valid durable chat scope key from the given scope input */
export function durableChatScopeKey(scope: DurableChatScope): string {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('durable chat scope is required')
  return scope
}

/** Represent durable plan outcomes as either approved or rejected */
export type DurablePlanDecision = 'approved' | 'rejected'
/** Resolve durable plan authority decisions including approval, rejection, or predefined durable decisions */
export type DurablePlanAuthorityDecision = DurablePlanDecision | 'approve' | 'reject'

/** Projection retained by a durable store.  It is intentionally compatible
 * with the browser `/plans` projection and adds no product-specific fields. */
export type DurablePlanProjection = ChatPlan & {
  metadata?: Record<string, unknown>
  decidedBy?: string
}

/** Represent a unique identifier key for durable plan commands */
export type DurablePlanCommandKey = string

/** Define possible states for a durable plan command in its lifecycle */
export type DurablePlanCommandState =
  | 'claimed'
  | 'authority_committed'
  | 'finalized'
  | 'conflicted'

/** Define the structure for recording durable plan commands with associated metadata and state information */
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

/** Represent the current authoritative state and optional receipt of a durable plan authority */
export interface DurablePlanAuthorityCurrentResult {
  /** Authoritative state. `null` means the authority has forgotten the plan. */
  plan: DurablePlanProjection | null
  receipt?: DurableFollowUpReceipt
}

/** Define a durable receipt capturing stable identifiers and state for follow-up decisions */
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

/** Describe the outcome of an authority's durable plan decision including follow-up and metadata */
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

/** Define the structure for recording the state and metadata of a durable plan effect */
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

/** Manage durable storage and retrieval of plan projections, commands, and effects within a scoped context */
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
/** Represent durable storage for plan state management with persistence and reliability guarantees */
export type DurablePlanStateStore = DurablePlanStore
/** Pick essential methods to manage and record durable plan command operations */
export type DurablePlanCommandJournal = Pick<DurablePlanStore, 'getPlanCommand' | 'claimPlanCommand' | 'recordPlanAuthorityResult' | 'finalizePlanCommand'>
/** Provide durable methods to manage the lifecycle of answer intents in a plan store */
export type DurableAnswerIntentJournal = Pick<DurablePlanStore, 'getAnswerIntent' | 'claimAnswerIntent' | 'acknowledgeAnswerIntent' | 'finalizeAnswerIntent' | 'abortAnswerIntent'>

/** Define a durable chat interaction projection with idempotent event tracking and optional tombstone flag */
export interface DurableInteractionProjection extends ChatInteraction {
  /** Sequence/event identity used to make ask replays idempotent. */
  eventId?: string
  semanticKey?: string
  /** A cancel-before-ask row is a terminal tombstone. */
  tombstone?: boolean
  updatedAt?: string
}

/** Define possible states for a durable answer intent lifecycle */
export type DurableAnswerIntentState = 'prepared' | 'acknowledged' | 'finalized' | 'aborted'

/** Define the structure for recording durable answer intent details and their states */
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

/** Represent durable acknowledgement of an interaction with optional authority, status, and timestamp fields */
export interface DurableInteractionAcknowledgement {
  acknowledged: true
  authorityId?: string
  status?: string
  at?: string
}

/** Define interaction durability levels to specify reconciliation or best-effort guarantees */
export type DurableInteractionGuarantee = 'reconciled' | 'best-effort'

/** Define options for durable interaction settlement including attempt key, guarantee, and timestamp provider */
export interface DurableInteractionSettlementOptions {
  /** Caller-created and stable across retries/reconnects. */
  attemptKey: string
  guarantee?: DurableInteractionGuarantee
  now?: () => string
}

/** Manage durable interaction lifecycles by preparing, acknowledging, finalizing, aborting, and reconciling intents */
export interface DurableInteractionSettlement {
  prepare(scope: DurableChatScope, interactionId: string, outcome: 'accepted' | 'declined', data?: Record<string, InteractionAnswerValue>): Promise<DurableAnswerIntentRecord>
  acknowledge(scope: DurableChatScope, intentKey: string, acknowledgement?: Omit<DurableInteractionAcknowledgement, 'acknowledged'>): Promise<DurableAnswerIntentRecord>
  finalize(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord>
  abort(scope: DurableChatScope, intentKey: string, error: string): Promise<DurableAnswerIntentRecord>
  reconcile(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null>
}

/** Normalize input value to a standardized DurablePlanDecision or return null for invalid inputs */
export function normalizePlanDecision(value: unknown): DurablePlanDecision | null {
  if (value === 'approved' || value === 'approve') return 'approved'
  if (value === 'rejected' || value === 'reject') return 'rejected'
  return null
}

/** Generate a unique key string for a plan command using plan ID, revision, and decision */
export function planCommandKey(planId: string, revision: number, decision: DurablePlanDecision): string {
  return `plan:${encodeURIComponent(planId)}:${revision}:${decision}`
}

/** Generate a unique idempotency key for a plan authority based on scope, plan, revision, and decision */
export function planAuthorityIdempotencyKey(scope: DurableChatScope, planId: string, revision: number, decision: DurablePlanDecision): string {
  return `durable-plan:${encodeURIComponent(durableChatScopeKey(scope))}:${encodeURIComponent(planId)}:${revision}:${decision}`
}

/** Generate a unique string key representing the effect of a plan decision within a given scope and revision */
export function planEffectKey(scope: DurableChatScope, planId: string, revision: number, decision: DurablePlanDecision): string {
  return `after-decision:${encodeURIComponent(durableChatScopeKey(scope))}:${encodeURIComponent(planId)}:${revision}:${decision}`
}

/** Resolve a durable follow-up receipt ensuring idempotency for a given plan decision and revision */
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
