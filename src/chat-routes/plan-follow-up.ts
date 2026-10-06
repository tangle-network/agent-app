/**
 * The chat turn that attaches to a decided plan's follow-up execution.
 *
 * Deciding a plan does not run anything in the product. The Sandbox platform
 * enqueues the approved (or revision) execution itself under the turn id
 * `planFollowUpTurnId(planId, revision, outcome)`, and the Sidecar names that
 * execution `plan-followup-<sha256(sessionId \0 turnId)>`. The browser card then
 * re-enters the chat route with a `planFollowUp` descriptor. That attach is a
 * real turn: it streams, persists an assistant row, and bills. It therefore
 * needs the same single-runner protection as a fresh turn.
 *
 * This module owns that attach: the descriptor check against the persisted
 * plan, the execution identity, the exclusive D1 claim on the `turn_status`
 * row, and the replay-then-follow event stream. Products keep their own
 * authorization, billing, and persistence around it.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SandboxEvent, SandboxInstance } from '@tangle-network/sandbox'
import { persistedPartToPlan, planFollowUpTurnId } from '../plans'

/** The decision a follow-up continues. */
export type PlanFollowUpOutcome = 'approved' | 'rejected'

/** The descriptor a decided plan card sends back to the chat route. */
export interface PlanFollowUpAttach {
  planId: string
  revision: number
  outcome: PlanFollowUpOutcome
  turnId: string
}

/** Result of checking a follow-up descriptor against the session's persisted plans. */
export type PlanFollowUpResolution =
  | { ok: true; attach: PlanFollowUpAttach; executionId: string }
  | { ok: false; status: 400 | 409; code: string; error: string }

/** Result of one exclusive follow-up claim. */
export type PlanFollowUpAdmission =
  | { admitted: true; lease: string }
  | { admitted: false; reason: 'in_flight' | 'completed' }

/** Result of settling a claim. `lease_lost` means a stale reclaim superseded it. */
export type PlanFollowUpSettlement =
  | { settled: true }
  | { settled: false; reason: 'lease_lost' }

/** A bound D1 statement used by the follow-up gate. */
export interface D1BoundForPlanFollowUps {
  run(): Promise<unknown>
}

/**
 * Structural D1 contract for the follow-up gate. `batch` is required: it is
 * D1's atomic boundary, and the gate confirms ownership from the row read in
 * the same batch instead of from a driver-specific affected-row count.
 */
export interface D1LikeForPlanFollowUps {
  prepare(sql: string): { bind(...values: unknown[]): D1BoundForPlanFollowUps }
  batch(statements: D1BoundForPlanFollowUps[]): Promise<unknown[]>
}

/** Configure the follow-up gate. Clock and lease are injectable for tests. */
export interface PlanFollowUpGateOptions {
  now?: () => Date
  createLease?: () => string
  /** How long a `running` claim may sit before another isolate may reclaim it. Default one hour. */
  staleAfterMs?: number
}

/** Exclusive claim over one follow-up execution's `turn_status` row. */
export interface PlanFollowUpGate {
  admit(executionId: string, scopeId: string): Promise<PlanFollowUpAdmission>
  /** Record a completed attach. Only the current lease may settle. */
  settle(executionId: string, scopeId: string, lease: string): Promise<PlanFollowUpSettlement>
  /** Record a failed attach so a retry is admitted immediately. */
  abandon(executionId: string, scopeId: string, lease: string): Promise<PlanFollowUpSettlement>
}

const PLAN_FOLLOW_UP_STALE_AFTER_MS = 60 * 60 * 1000
const PLAN_FOLLOW_UP_ATTACH_TIMEOUT_MS = 120_000
const TERMINAL_SESSION_EVENT_TYPES = new Set(['done', 'error', 'result'])

/** The Sidecar's execution id for a follow-up turn. Keep it byte-identical to the Sidecar. */
export function planFollowUpExecutionId(sessionId: string, turnId: string): string {
  return `plan-followup-${createHash('sha256').update(`${sessionId}\0${turnId}`).digest('hex')}`
}

/** Parse a follow-up descriptor. The turn id is derived, never trusted. */
export function parsePlanFollowUpAttach(value: unknown): PlanFollowUpAttach | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const planId = typeof record.planId === 'string' ? record.planId.trim() : ''
  const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : ''
  const revision = record.revision
  const outcome = record.outcome
  if (!planId || !turnId || (outcome !== 'approved' && outcome !== 'rejected')) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (turnId !== planFollowUpTurnId(planId, revision, outcome)) return null
  return { planId, revision, outcome, turnId }
}

/**
 * Validate a follow-up request against what the session actually persisted:
 * the plan must be in this session at this revision and must already carry the
 * claimed decision.
 */
export function resolvePlanFollowUpRequest(input: {
  sessionId: string
  planFollowUp: unknown
  messages: ReadonlyArray<{ role: string; parts?: unknown }>
}): PlanFollowUpResolution {
  const attach = parsePlanFollowUpAttach(input.planFollowUp)
  if (!attach) {
    return { ok: false, status: 400, code: 'invalid_plan_follow_up', error: 'Invalid planFollowUp descriptor' }
  }
  const plan = input.messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.parts))
    .flatMap((message) => message.parts as unknown[])
    .map((part) => (part && typeof part === 'object' && !Array.isArray(part)
      ? persistedPartToPlan(part as Record<string, unknown>)
      : null))
    .find((candidate) => candidate?.planId === attach.planId && candidate.revision === attach.revision)
  if (!plan) {
    return {
      ok: false,
      status: 409,
      code: 'plan_follow_up_missing',
      error: `Plan ${attach.planId} revision ${attach.revision} is not in this session`,
    }
  }
  if (plan.status !== attach.outcome) {
    return {
      ok: false,
      status: 409,
      code: 'plan_follow_up_not_decided',
      error: `Plan ${attach.planId} is ${plan.status}, not ${attach.outcome}`,
    }
  }
  return { ok: true, attach, executionId: planFollowUpExecutionId(input.sessionId, attach.turnId) }
}

/**
 * Session events carry two payload shapes: replayed events hold the stream
 * event under `data`, while live events nest it under `data.properties`.
 * Downstream reads `data.<field>`, so a live event is unwrapped.
 */
export function unwrapSessionEventPayload(event: SandboxEvent): SandboxEvent {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined
  const properties = data?.properties && typeof data.properties === 'object' && !Array.isArray(data.properties)
    ? data.properties as Record<string, unknown>
    : undefined
  return properties ? { ...event, data: properties } as SandboxEvent : event
}

/**
 * Attach to the already-enqueued follow-up execution: replay its buffered
 * events from the start, then follow it live to completion. It never sends a
 * new prompt. The session-events iterator has no reconnect, so a stream that
 * ends without a terminal event fails instead of persisting a partial turn.
 */
export async function* streamPlanFollowUpEvents(
  box: SandboxInstance,
  sessionId: string,
  executionId: string,
  options: { timeoutMs?: number } = {},
): AsyncGenerator<SandboxEvent> {
  const timeoutMs = options.timeoutMs ?? PLAN_FOLLOW_UP_ATTACH_TIMEOUT_MS
  const abort = new AbortController()
  const iterator = box.session(sessionId).events({
    executionId,
    since: '0',
    signal: abort.signal,
  })[Symbol.asyncIterator]()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let sawTerminalEvent = false
  const track = (event: SandboxEvent): SandboxEvent => {
    if (TERMINAL_SESSION_EVENT_TYPES.has(String(event.type ?? ''))) sawTerminalEvent = true
    return unwrapSessionEventPayload(event)
  }
  try {
    const first = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Plan follow-up ${executionId} did not start within ${Math.round(timeoutMs / 1000)} seconds`)),
          timeoutMs,
        )
      }),
    ])
    if (timeout) clearTimeout(timeout)
    if (first.done) throw new Error(`Plan follow-up ${executionId} ended before emitting an event`)
    yield track(first.value)
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        if (!sawTerminalEvent) {
          throw new Error(`Plan follow-up ${executionId} stream ended without a terminal event`)
        }
        return
      }
      yield track(next.value)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    abort.abort()
    await iterator.return?.(undefined)
  }
}

interface PlanFollowUpStatusRow {
  status: string
  leaseToken: string | null
}

/**
 * Exclusive claim over a follow-up execution in the shared `turn_status`
 * table. Every claim writes a random lease and confirms ownership from the
 * row returned by the same D1 batch. A running claim older than
 * `staleAfterMs` may be reclaimed; the superseded holder then settles into
 * `lease_lost` instead of overwriting the newer claim. The table needs the
 * `leaseToken` column from `TURN_EVENTS_MIGRATION_SQL` or, for an older table,
 * `TURN_STATUS_LEASE_MIGRATION_SQL` (both in `/stream`).
 */
export function createD1PlanFollowUpGate(
  db: D1LikeForPlanFollowUps,
  options: PlanFollowUpGateOptions = {},
): PlanFollowUpGate {
  const now = options.now ?? (() => new Date())
  const createLease = options.createLease ?? randomUUID
  const staleAfterMs = options.staleAfterMs ?? PLAN_FOLLOW_UP_STALE_AFTER_MS
  const readStatus = (executionId: string) => db.prepare(`
    SELECT status, leaseToken
    FROM turn_status
    WHERE turnId = ?
    LIMIT 1
  `).bind(executionId)

  async function readAfterBatch(
    write: D1BoundForPlanFollowUps,
    executionId: string,
    operation: string,
  ): Promise<PlanFollowUpStatusRow> {
    const results = await db.batch([write, readStatus(executionId)])
    const rows = (results[1] as { results?: unknown[] } | undefined)?.results
    const row = rows?.[0] as Partial<PlanFollowUpStatusRow> | undefined
    if (!row || typeof row.status !== 'string') {
      throw new Error(`Plan follow-up ${executionId} has no status after ${operation}`)
    }
    if (row.leaseToken !== null && row.leaseToken !== undefined && typeof row.leaseToken !== 'string') {
      throw new Error(`Plan follow-up ${executionId} has an invalid lease after ${operation}`)
    }
    return { status: row.status, leaseToken: row.leaseToken ?? null }
  }

  async function settle(
    executionId: string,
    scopeId: string,
    lease: string,
    status: 'complete' | 'error',
  ): Promise<PlanFollowUpSettlement> {
    const row = await readAfterBatch(
      db.prepare(`
        UPDATE turn_status
        SET status = ?, scopeId = ?, updatedAt = ?
        WHERE turnId = ? AND status = 'running' AND leaseToken = ?
      `).bind(status, scopeId, now().toISOString(), executionId, lease),
      executionId,
      `settling ${status}`,
    )
    if (row.leaseToken !== lease) return { settled: false, reason: 'lease_lost' }
    if (row.status !== status) {
      throw new Error(`Plan follow-up ${executionId} remained ${row.status} while settling ${status}`)
    }
    return { settled: true }
  }

  return {
    async admit(executionId, scopeId) {
      const claimedAt = now()
      const lease = createLease()
      const staleBefore = new Date(claimedAt.getTime() - staleAfterMs).toISOString()
      const row = await readAfterBatch(
        db.prepare(`
          INSERT INTO turn_status (turnId, status, scopeId, updatedAt, leaseToken)
          VALUES (?, 'running', ?, ?, ?)
          ON CONFLICT(turnId) DO UPDATE SET
            status = 'running',
            scopeId = excluded.scopeId,
            updatedAt = excluded.updatedAt,
            leaseToken = excluded.leaseToken
          WHERE turn_status.status = 'error'
             OR (turn_status.status = 'running' AND turn_status.updatedAt < ?)
        `).bind(executionId, scopeId, claimedAt.toISOString(), lease, staleBefore),
        executionId,
        'admission',
      )
      if (row.status === 'running' && row.leaseToken === lease) return { admitted: true, lease }
      if (row.status === 'running') return { admitted: false, reason: 'in_flight' }
      if (row.status === 'complete') return { admitted: false, reason: 'completed' }
      throw new Error(`Plan follow-up ${executionId} has unexpected admission status: ${row.status}`)
    },
    settle: (executionId, scopeId, lease) => settle(executionId, scopeId, lease, 'complete'),
    abandon: (executionId, scopeId, lease) => settle(executionId, scopeId, lease, 'error'),
  }
}
