/**
 * The review queue is a PROJECTION, not a store — a client-safe pure fold of
 * existing sources into queue items (the `/missions` events.ts pattern: pure
 * data, re-validation at JSON boundaries). The only genuinely-new durable
 * state behind it is the {@link WorkProductRecord} row and its status
 * machine; everything else reads what already exists:
 *
 *  - intake: a chat thread for the engagement scope with NO record yet
 *  - missing_info: the open record's thread has a PENDING `/interactions` ask
 *  - working: record status `draft` (the live token tail stays on the chat
 *    surface's existing running-turns endpoint — the projection tracks no
 *    live runs, per the reuse-the-primitive invariant)
 *  - ready_for_review / changes_requested / approved / blocked: read directly
 *    off `WorkProductRecord.status` (blocked surfaces its unresolved count)
 */

import {
  isWorkProductStatus,
  unresolvedBlockingExceptions,
  type WorkProductProvenance,
  type WorkProductRecord,
  type WorkProductRef,
} from './types'

export type ReviewQueueState =
  | 'intake'
  | 'missing_info'
  | 'working'
  | 'ready_for_review'
  | 'changes_requested'
  | 'approved'
  | 'blocked'

/** One row of the review queue projection for an engagement scope */
export interface ReviewQueueItem {
  scopeKey: string
  state: ReviewQueueState
  threadId: string | null
  workProduct?: WorkProductRef & { title: string; kind: string }
  /** The pending `/interactions` ask parking this scope, when any. */
  pendingAsk?: { interactionId: string; title: string }
  blockingExceptions: number
  failedChecks: number
  provenance?: Pick<WorkProductProvenance, 'profileHash' | 'servingModels'>
  updatedAt: number
}

/** An engagement-scoped chat thread — the intake candidate source. Products
 *  that scope threads already carry a scopeKey-style column. */
export interface ReviewQueueThread {
  scopeKey: string
  threadId: string
  updatedAt: number
}

/** A pending `/interactions` ask on a thread (from the existing list
 *  endpoint) — the missing_info source. */
export interface ReviewQueuePendingAsk {
  threadId: string
  interactionId: string
  title: string
}

/** Existing-source inputs the projection folds — no new stores */
export interface ReviewQueueInputs {
  workProducts: readonly WorkProductRecord[]
  /** Engagement threads with no work product yet → intake items. */
  threads?: readonly ReviewQueueThread[]
  /** Pending asks by thread → missing_info override on open records. */
  pendingAsks?: readonly ReviewQueuePendingAsk[]
}

const OPEN_STATUSES = new Set(['draft', 'blocked', 'ready', 'changes_requested'])

/** The record that represents a scope in the queue: its single open row when
 *  one exists, else its latest approved version. Superseded rows are history
 *  and never surface. */
function currentRecordPerScope(records: readonly WorkProductRecord[]): Map<string, WorkProductRecord> {
  const byScope = new Map<string, WorkProductRecord>()
  for (const record of records) {
    if (record.status === 'superseded') continue
    const held = byScope.get(record.scopeKey)
    if (!held) {
      byScope.set(record.scopeKey, record)
      continue
    }
    const heldOpen = OPEN_STATUSES.has(held.status)
    const recordOpen = OPEN_STATUSES.has(record.status)
    if (recordOpen !== heldOpen) {
      if (recordOpen) byScope.set(record.scopeKey, record)
      continue
    }
    if (record.version > held.version || (record.version === held.version && record.updatedAt > held.updatedAt)) {
      byScope.set(record.scopeKey, record)
    }
  }
  return byScope
}

function stateOf(record: WorkProductRecord, pendingAsk: ReviewQueuePendingAsk | undefined): ReviewQueueState {
  switch (record.status) {
    case 'ready':
      return 'ready_for_review'
    case 'changes_requested':
      return 'changes_requested'
    case 'approved':
      return 'approved'
    case 'blocked':
      return pendingAsk ? 'missing_info' : 'blocked'
    case 'draft':
      return pendingAsk ? 'missing_info' : 'working'
    // 'superseded' is filtered before this switch.
    default:
      return 'working'
  }
}

/** Fold the existing sources into queue items, newest first. */
export function projectReviewQueue(inputs: ReviewQueueInputs): ReviewQueueItem[] {
  const asksByThread = new Map<string, ReviewQueuePendingAsk>()
  for (const ask of inputs.pendingAsks ?? []) {
    if (!asksByThread.has(ask.threadId)) asksByThread.set(ask.threadId, ask)
  }

  const items: ReviewQueueItem[] = []
  const byScope = currentRecordPerScope(inputs.workProducts)
  for (const [scopeKey, record] of byScope) {
    const pendingAsk = record.threadId ? asksByThread.get(record.threadId) : undefined
    const item: ReviewQueueItem = {
      scopeKey,
      state: stateOf(record, pendingAsk),
      threadId: record.threadId,
      workProduct: {
        id: record.id,
        version: record.version,
        title: record.artifact?.title ?? scopeKey,
        kind: record.artifact?.kind ?? '',
      },
      blockingExceptions: unresolvedBlockingExceptions(record.exceptions).length,
      failedChecks: record.checks.filter((check) => !check.passed).length,
      provenance: { profileHash: record.provenance.profileHash, servingModels: record.provenance.servingModels },
      updatedAt: record.updatedAt,
    }
    if (pendingAsk) item.pendingAsk = { interactionId: pendingAsk.interactionId, title: pendingAsk.title }
    items.push(item)
  }

  // Intake: an engagement thread with no record for its scope.
  for (const thread of inputs.threads ?? []) {
    if (byScope.has(thread.scopeKey)) continue
    if (items.some((item) => item.scopeKey === thread.scopeKey)) continue
    items.push({
      scopeKey: thread.scopeKey,
      state: 'intake',
      threadId: thread.threadId,
      blockingExceptions: 0,
      failedChecks: 0,
      updatedAt: thread.updatedAt,
    })
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Re-validate one JSON-boundary row into a queue item; null for junk. The
 *  client-side twin of the server projection, for payloads that cross a
 *  fetch boundary. */
export function parseReviewQueueItem(raw: unknown): ReviewQueueItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const states: readonly ReviewQueueState[] = [
    'intake',
    'missing_info',
    'working',
    'ready_for_review',
    'changes_requested',
    'approved',
    'blocked',
  ]
  if (typeof record.scopeKey !== 'string' || record.scopeKey.length === 0) return null
  if (!states.includes(record.state as ReviewQueueState)) return null
  if (record.threadId !== null && typeof record.threadId !== 'string') return null
  if (typeof record.blockingExceptions !== 'number' || typeof record.failedChecks !== 'number') return null
  if (typeof record.updatedAt !== 'number') return null
  const item: ReviewQueueItem = {
    scopeKey: record.scopeKey,
    state: record.state as ReviewQueueState,
    threadId: record.threadId,
    blockingExceptions: record.blockingExceptions,
    failedChecks: record.failedChecks,
    updatedAt: record.updatedAt,
  }
  const workProduct = record.workProduct as Record<string, unknown> | undefined
  if (workProduct && typeof workProduct === 'object') {
    if (
      typeof workProduct.id === 'string' &&
      typeof workProduct.version === 'number' &&
      typeof workProduct.title === 'string' &&
      typeof workProduct.kind === 'string'
    ) {
      item.workProduct = {
        id: workProduct.id,
        version: workProduct.version,
        title: workProduct.title,
        kind: workProduct.kind,
      }
    }
  }
  const pendingAsk = record.pendingAsk as Record<string, unknown> | undefined
  if (pendingAsk && typeof pendingAsk === 'object') {
    if (typeof pendingAsk.interactionId === 'string' && typeof pendingAsk.title === 'string') {
      item.pendingAsk = { interactionId: pendingAsk.interactionId, title: pendingAsk.title }
    }
  }
  const provenance = record.provenance as Record<string, unknown> | undefined
  if (provenance && typeof provenance === 'object') {
    if (
      typeof provenance.profileHash === 'string' &&
      Array.isArray(provenance.servingModels) &&
      provenance.servingModels.every((model) => typeof model === 'string')
    ) {
      item.provenance = { profileHash: provenance.profileHash, servingModels: provenance.servingModels as string[] }
    }
  }
  return item
}

/** Convenience guard used when a status string crosses a JSON boundary. */
export { isWorkProductStatus }
