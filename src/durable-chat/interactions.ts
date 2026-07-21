import {
  cancelStatusFor,
  interactionFromWireRequest,
  isSafeInteractionFieldKey,
  parseInteractionAnswers,
  questionInteractionContentSignature,
  type InteractionAnswerValue,
  type InteractionAnswers,
  type InteractionRequestWire,
} from '../interactions/contract'
import { DurableChatConflictError } from './errors'
import type {
  DurableAnswerIntentRecord,
  DurableChatScope,
  DurableInteractionAcknowledgement,
  DurableInteractionGuarantee,
  DurableInteractionProjection,
  DurableInteractionSettlement,
  DurableInteractionSettlementOptions,
  DurablePlanStore,
} from './types'

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))()
}

function intentKey(scope: DurableChatScope, interactionId: string, attemptKey: string): string {
  return `interaction-answer:${encodeURIComponent(scope)}:${encodeURIComponent(interactionId)}:${encodeURIComponent(attemptKey)}`
}

function ensureAttemptKey(attemptKey: string): void {
  if (!attemptKey || typeof attemptKey !== 'string' || attemptKey.length > 512) throw new TypeError('attemptKey must be a non-empty string')
}

function safeAnswers(data: Record<string, InteractionAnswerValue> | undefined): InteractionAnswers | undefined {
  if (data === undefined) return undefined
  for (const key of Object.keys(data)) {
    if (!isSafeInteractionFieldKey(key)) throw new TypeError(`unsafe interaction answer key: ${key}`)
  }
  const parsed = parseInteractionAnswers(data)
  if (!parsed.succeeded) throw new TypeError(parsed.error)
  return parsed.value
}

/** Apply an ask event. Event ids and semantic signatures make replays safe;
 * a prior cancel creates a tombstone and cannot be resurrected by a late ask. */
export async function upsertDurableInteractionAsk(
  store: DurablePlanStore,
  scope: DurableChatScope,
  request: InteractionRequestWire,
  options: { eventId?: string; semanticKey?: string; now?: () => string } = {},
): Promise<DurableInteractionProjection> {
  const semanticKey = options.semanticKey ?? questionInteractionContentSignature(interactionFromWireRequest(request)) ?? undefined
  const incoming: DurableInteractionProjection = {
    ...interactionFromWireRequest(request),
    ...(options.eventId ? { eventId: options.eventId } : {}),
    ...(semanticKey ? { semanticKey } : {}),
    updatedAt: nowIso(options.now),
  }
  const prior = await store.getInteractionProjection(scope, request.id)
  if (prior?.tombstone) {
    return store.upsertInteractionProjection(scope, {
      ...incoming,
      status: prior.status,
      tombstone: true,
      ...(prior.cancelReason ? { cancelReason: prior.cancelReason } : {}),
    })
  }
  if (prior && prior.status !== 'pending') return prior
  return store.upsertInteractionProjection(scope, incoming)
}

/** Apply a cancel event. It is valid before the ask arrives and leaves a
 * terminal tombstone so a delayed ask cannot re-open the card. */
export async function recordDurableInteractionCancel(
  store: DurablePlanStore,
  scope: DurableChatScope,
  interactionId: string,
  reason?: string,
  options: { eventId?: string; now?: () => string } = {},
): Promise<DurableInteractionProjection> {
  if (!interactionId) throw new TypeError('interaction id is required')
  const status = cancelStatusFor(reason)
  const prior = await store.getInteractionProjection(scope, interactionId)
  if (prior) {
    if (prior.status === status) return prior
    if (prior.status !== 'pending') throw new DurableChatConflictError('interaction already has a conflicting terminal outcome')
    return store.upsertInteractionProjection(scope, {
      ...prior, status, tombstone: true, ...(reason ? { cancelReason: reason } : {}),
      ...(options.eventId ? { eventId: options.eventId } : {}), updatedAt: nowIso(options.now),
    })
  }
  return store.upsertInteractionProjection(scope, {
    id: interactionId, kind: 'unknown', title: '', fields: [], status,
    tombstone: true, ...(reason ? { cancelReason: reason } : {}),
    ...(options.eventId ? { eventId: options.eventId } : {}), updatedAt: nowIso(options.now),
  })
}

/** Record an accepted/declined answer in the projection. The terminal
 * transition is intentionally separate from answer-intent acknowledgement so
 * callers can choose reconciled or best-effort delivery. */
export async function recordDurableInteractionAnswer(
  store: DurablePlanStore,
  scope: DurableChatScope,
  interactionId: string,
  outcome: 'accepted' | 'declined',
  answers?: Record<string, InteractionAnswerValue>,
  options: { eventId?: string; now?: () => string } = {},
): Promise<DurableInteractionProjection> {
  const prior = await store.getInteractionProjection(scope, interactionId)
  if (!prior) throw new DurableChatConflictError('cannot answer an interaction before its ask projection')
  const status = outcome === 'accepted' ? 'answered' : 'declined'
  const parsed = safeAnswers(answers)
  if (prior.status === status && JSON.stringify(prior.answers) === JSON.stringify(parsed)) return prior
  if (prior.status !== 'pending') throw new DurableChatConflictError('interaction already has a conflicting terminal outcome')
  return store.upsertInteractionProjection(scope, {
    ...prior, status, ...(parsed ? { answers: parsed } : {}),
    ...(options.eventId ? { eventId: options.eventId } : {}), updatedAt: nowIso(options.now),
  })
}

export interface DurableInteractionSettlementFactoryOptions extends DurableInteractionSettlementOptions {
  store: DurablePlanStore
  /** Optional authority lookup used by `reconcile`; returning null leaves the
   * intent prepared for a later durable retry. */
  reconcileAuthority?: (args: {
    scope: DurableChatScope
    intent: DurableAnswerIntentRecord
  }) => Promise<DurableInteractionAcknowledgement | null>
}

/** Additive answer settlement primitive for wiring into `/interactions`.
 * `attemptKey` belongs to the caller and is never generated from user data. */
export function createDurableInteractionSettlement(
  options: DurableInteractionSettlementFactoryOptions,
): DurableInteractionSettlement {
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async prepare(scope, interactionId, outcome, data) {
      ensureAttemptKey(options.attemptKey)
      const parsed = safeAnswers(data)
      const record: DurableAnswerIntentRecord = {
        scope, interactionId, attemptKey: options.attemptKey,
        intentKey: intentKey(scope, interactionId, options.attemptKey),
        outcome, ...(parsed ? { data: parsed } : {}), state: 'prepared',
        guarantee: options.guarantee ?? 'reconciled', createdAt: now(),
      }
      const result = await options.store.claimAnswerIntent(scope, record)
      if (result.status === 'conflict') throw new DurableChatConflictError(result.reason)
      return result.record
    },
    async acknowledge(scope, key, acknowledgement = {}) {
      const existing = await options.store.getAnswerIntent(scope, key)
      if (!existing) throw new DurableChatConflictError('unknown answer intent')
      const value: DurableInteractionAcknowledgement = {
        acknowledged: true,
        ...(acknowledgement.authorityId ? { authorityId: acknowledgement.authorityId } : {}),
        ...(acknowledgement.status ? { status: acknowledgement.status } : {}),
        at: acknowledgement.at ?? now(),
      }
      await options.store.acknowledgeAnswerIntent(scope, key, value)
      return (await options.store.getAnswerIntent(scope, key))!
    },
    async finalize(scope, key) {
      const existing = await options.store.getAnswerIntent(scope, key)
      if (!existing) throw new DurableChatConflictError('unknown answer intent')
      await options.store.finalizeAnswerIntent(scope, key, options.guarantee ?? 'reconciled')
      return (await options.store.getAnswerIntent(scope, key))!
    },
    async abort(scope, key, error) {
      const existing = await options.store.getAnswerIntent(scope, key)
      if (!existing) throw new DurableChatConflictError('unknown answer intent')
      await options.store.abortAnswerIntent(scope, key, error)
      return (await options.store.getAnswerIntent(scope, key))!
    },
    async reconcile(scope, key) {
      const existing = await options.store.getAnswerIntent(scope, key)
      if (!existing || !options.reconcileAuthority) return existing
      if (existing.state === 'finalized') return existing
      const acknowledgement = await options.reconcileAuthority({ scope, intent: existing })
      if (!acknowledgement) return existing
      await options.store.acknowledgeAnswerIntent(scope, key, {
        acknowledged: true,
        ...(acknowledgement.authorityId ? { authorityId: acknowledgement.authorityId } : {}),
        ...(acknowledgement.status ? { status: acknowledgement.status } : {}),
        ...(acknowledgement.at ? { at: acknowledgement.at } : {}),
      })
      await options.store.finalizeAnswerIntent(scope, key, options.guarantee ?? 'reconciled')
      return (await options.store.getAnswerIntent(scope, key))!
    },
  }
}

/** Stable key helper exported for products implementing their own settlement
 * loop. */
export function durableInteractionIntentKey(scope: DurableChatScope, interactionId: string, attemptKey: string): string {
  ensureAttemptKey(attemptKey)
  return intentKey(scope, interactionId, attemptKey)
}

export const applyDurableInteractionAsk = upsertDurableInteractionAsk
export const applyDurableInteractionCancel = recordDurableInteractionCancel
export const applyDurableInteractionAnswer = recordDurableInteractionAnswer
