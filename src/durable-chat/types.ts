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

/** Ownership fields returned by a successful claim. Both are OPTIONAL: a store
 * with no lease concept (the in-memory reference) omits them, and a caller that
 * ignores them keeps the pre-lease behavior exactly. A store that DOES issue
 * leases expects the token back on the matching settle call, so a stalled
 * predecessor that wakes up cannot settle behind the worker that took over. */
export interface DurableClaimLease {
  /** Opaque token proving this caller currently owns the claim. */
  lease?: string
  /** True when this claim took over a lease whose holder went stale. */
  takenOver?: boolean
}

/** Outcome of claiming a plan decision command. */
export type DurablePlanCommandClaim =
  | ({ status: 'claimed'; record: DurablePlanCommandRecord } & DurableClaimLease)
  | ({ status: 'existing'; record: DurablePlanCommandRecord } & DurableClaimLease)
  | { status: 'conflict'; record?: DurablePlanCommandRecord; reason: string }

/** Outcome of claiming an after-decision effect. */
export type DurablePlanEffectClaim =
  | ({ status: 'claimed'; record: DurablePlanEffectRecord } & DurableClaimLease)
  | ({ status: 'existing'; record: DurablePlanEffectRecord } & DurableClaimLease)

/** Outcome of claiming an answer intent. */
export type DurableAnswerIntentClaim =
  | ({ status: 'claimed'; record: DurableAnswerIntentRecord } & DurableClaimLease)
  | ({ status: 'existing'; record: DurableAnswerIntentRecord } & DurableClaimLease)
  | { status: 'conflict'; record?: DurableAnswerIntentRecord; reason: string }

/** Plan-side durable port: revision projections, the decision-command journal,
 * and the after-decision effect journal. A product that wants durable plans and
 * no durable questions implements THIS and nothing else — `createDurablePlanRoutes`
 * asks for no more than this. `lease` is optional on every settle method: omit
 * it to settle unconditionally (what every pre-lease implementation does). */
export interface DurablePlanStore {
  getPlanProjection(scope: DurableChatScope, planId: string, revision?: number): Promise<DurablePlanProjection | null>
  putPlanProjection(scope: DurableChatScope, projection: DurablePlanProjection): Promise<void>
  listPlanProjections?(scope: DurableChatScope, planId?: string): Promise<DurablePlanProjection[]>
  getPlanCommand(scope: DurableChatScope, commandKey: DurablePlanCommandKey): Promise<DurablePlanCommandRecord | null>
  claimPlanCommand(scope: DurableChatScope, command: DurablePlanCommandRecord): Promise<DurablePlanCommandClaim>
  recordPlanAuthorityResult(scope: DurableChatScope, commandKey: DurablePlanCommandKey, result: DurablePlanAuthorityResult, receipt: DurableFollowUpReceipt, lease?: string): Promise<void>
  finalizePlanCommand(scope: DurableChatScope, commandKey: DurablePlanCommandKey, lease?: string): Promise<void>
  getPlanEffect(scope: DurableChatScope, effectKey: string): Promise<DurablePlanEffectRecord | null>
  claimPlanEffect(scope: DurableChatScope, effect: DurablePlanEffectRecord): Promise<DurablePlanEffectClaim>
  completePlanEffect(scope: DurableChatScope, effectKey: string, lease?: string): Promise<void>
  failPlanEffect(scope: DurableChatScope, effectKey: string, error: string, lease?: string): Promise<void>
}

/** Interaction-side durable port: ask projections (with semantic dedupe and
 * duplicate-id aliases) and the answer-intent journal. A product that wants
 * durable questions and no durable plans implements THIS and nothing else. */
export interface DurableInteractionStore {
  getInteractionProjection(scope: DurableChatScope, interactionId: string): Promise<DurableInteractionProjection | null>
  upsertInteractionProjection(scope: DurableChatScope, projection: DurableInteractionProjection): Promise<DurableInteractionProjection>
  listInteractionProjections?(scope: DurableChatScope): Promise<DurableInteractionProjection[]>
  getAnswerIntent(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null>
  claimAnswerIntent(scope: DurableChatScope, intent: DurableAnswerIntentRecord): Promise<DurableAnswerIntentClaim>
  acknowledgeAnswerIntent(scope: DurableChatScope, intentKey: string, acknowledgement: DurableInteractionAcknowledgement, lease?: string): Promise<void>
  /** Atomically settle the interaction projection (including semantic aliases)
   * from the acknowledged intent and mark the intent finalized. */
  finalizeAnswerIntent(scope: DurableChatScope, intentKey: string, guarantee?: DurableInteractionGuarantee, lease?: string): Promise<void>
  abortAnswerIntent(scope: DurableChatScope, intentKey: string, error: string, lease?: string): Promise<void>
}

/** Both ports. What a product wiring plan cards AND question cards passes, what
 * `createDurableChatEventProjection` needs, and what the reference in-memory
 * store implements. */
export interface DurableChatStore extends DurablePlanStore, DurableInteractionStore {}

/** Alias used by adapters that store all durable chat state in one port. */
export type DurableChatStateStore = DurableChatStore
/**
 * @deprecated Ambiguous name. This resolves to the PLAN-side port only; use
 * `DurablePlanStore` for that, or `DurableChatStore` for both halves.
 */
export type DurablePlanStateStore = DurablePlanStore
/** Pick essential methods to manage and record durable plan command operations */
export type DurablePlanCommandJournal = Pick<DurablePlanStore, 'getPlanCommand' | 'claimPlanCommand' | 'recordPlanAuthorityResult' | 'finalizePlanCommand'>
/** Pick the methods that claim and settle one after-decision effect. */
export type DurablePlanEffectJournal = Pick<DurablePlanStore, 'getPlanEffect' | 'claimPlanEffect' | 'completePlanEffect' | 'failPlanEffect'>
/** Provide durable methods to manage the lifecycle of answer intents in a store */
export type DurableAnswerIntentJournal = Pick<DurableInteractionStore, 'getAnswerIntent' | 'claimAnswerIntent' | 'acknowledgeAnswerIntent' | 'finalizeAnswerIntent' | 'abortAnswerIntent'>

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

/**
 * How thoroughly an answer's delivery was confirmed before the intent was marked
 * finalized. It is a record of what actually happened, not a request — the
 * settlement stamps what it verified.
 *
 * - `best-effort` — the answer POST returned success and the intent was settled
 *   on that basis. **The default**, because it is the only level that is always
 *   true.
 * - `reconciled` — an authority lookup independently confirmed the answer before
 *   the intent settled. Requires a product-supplied `reconcileAuthority`; the
 *   route persistence type will not let you select it without one.
 *
 * ## What every adopter already gets for free
 *
 * Crash recovery does NOT require `reconciled`. The answer-intent journal is
 * itself durable evidence: an attempt that reached `acknowledged` or `finalized`
 * proves the sidecar accepted that exact payload, because the settlement only
 * writes those states after a successful POST. A retry carrying the same
 * `attemptKey` therefore resolves from local state with no upstream call and no
 * product code — see `createDurableInteractionRoutePersistence`.
 *
 * ## The gap that remains
 *
 * One window is not locally recoverable: the POST succeeded but the process died
 * before the acknowledgement was written, leaving the intent at `prepared`. The
 * sidecar (`/interactions`) exposes only "list the asks still outstanding" and
 * "submit an answer" — there is no lookup that reports whether a SPECIFIC
 * payload committed, so nothing can distinguish that case from a POST that never
 * landed. Closing it needs an acknowledgement/history endpoint upstream.
 *
 * `createSidecarAbsenceReconciler` (`./reconcile`) narrows that window with the
 * one signal that does exist, and documents precisely where it is evidence and
 * where it is not.
 */
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
