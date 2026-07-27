/**
 * The SWEEP half: ask the store what it has been quietly accumulating.
 *
 * A live per-turn hook cannot see the failure that matters most, because the
 * worst outage produced NO turns at all to hook: gtm-agent took 9–21 user
 * messages a day for sixteen straight days and wrote zero real assistant
 * replies. Nothing crashed on a schedule; the product simply stopped
 * answering. The only thing that could have noticed is something that
 * periodically counts what arrived against what was answered.
 *
 * That is this. It runs on a cron, reads the shared `/chat-store` schema, and
 * pages when the ratio breaks.
 *
 * The queries live HERE and not in each product because all four products
 * (gtm, tax, legal, workcomp) persist to the same `message`/`thread` tables —
 * four copies of this cron is exactly the duplication the repo's engine/shell
 * rule exists to prevent.
 */

import { classifyTurnOutcome, describeReason, type TurnHealthReason } from './classify.js'
import type { AlertSink, TurnHealthAlert } from './sink.js'

/** A thread that has taken user messages with no reply since. */
export interface UnansweredThread {
  threadId: string
  /** User messages newer than the newest real assistant reply. */
  pendingMessages: number
  /** Age of the OLDEST unanswered user message, in ms. */
  oldestAgeMs: number
}

/** A persisted assistant row, as the sweep needs to judge it. */
export interface PersistedTurnRow {
  id: string
  threadId: string
  content: string
  /** Raw `parts` column. A JSON string or an already-parsed array; the sweep
   *  accepts both because D1 drivers differ. */
  parts: unknown
  outputTokens?: number | null
  model?: string | null
  createdAt: number
}

/** What the sweep needs from a store. A product on a non-standard schema
 *  implements these two reads; everything else is shared. */
export interface TurnHealthSource {
  findUnansweredThreads(input: {
    minAgeMs: number
    /** Ignore user messages older than this. See {@link SweepOptions.maxAgeMs}. */
    maxAgeMs: number
    now: number
  }): Promise<UnansweredThread[]>
  listRecentAssistantTurns(input: { sinceMs: number; now: number; limit: number }): Promise<
    PersistedTurnRow[]
  >
}

export interface SweepOptions {
  product: string
  source: TurnHealthSource
  sink: AlertSink
  /** A user message must go unanswered this long before it counts. Guards
   *  against alerting on a turn that is simply still streaming. Default 15 min. */
  minAgeMs?: number
  /**
   * A user message OLDER than this is abandoned, not unanswered — it stops
   * counting. Default 7 days.
   *
   * Without this bound the sweep is worse than useless. gtm-agent's table
   * holds 384 unanswered messages whose oldest is 1,676 h (70 days) old;
   * paging hourly on a backlog nobody will ever reply to is exactly how an
   * alert channel gets muted, and a muted channel is the state this module
   * exists to escape. The alert has to mean "something broke recently".
   */
  maxAgeMs?: number
  /** How far back to judge settled turns. Default 24 h. */
  lookbackMs?: number
  /** Cap on rows judged per sweep. Default 500. */
  limit?: number
  /** Fraction of recent turns allowed to be silently broken before paging.
   *  Default 0.05 — the measured blank-completion rate on the tax tool surface
   *  was 12.2%, so 5% separates a real regression from noise. */
  emptyRateThreshold?: number
  /** Absolute floor: never page on a rate computed from fewer turns than this. */
  minTurnsForRate?: number
  now?: number
}

/** What the sweep found. Returned as well as alerted, so a cron can log it and
 *  a test can assert on it. */
export interface SweepResult {
  product: string
  unansweredThreads: number
  pendingUserMessages: number
  oldestUnansweredMs: number
  turnsJudged: number
  unhealthyTurns: number
  emptyCompletions: number
  malformedToolCalls: number
  toolCallsWithoutEffect: number
  alerts: TurnHealthAlert[]
}

function parseParts(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A parts column that is not JSON is itself a corruption worth seeing, but
    // it is not this detector's job — treat as no parts rather than throwing.
    return []
  }
}

const HOUR_MS = 3_600_000

/**
 * Run one sweep and deliver whatever it finds.
 *
 * Errors from the sink are NOT swallowed here (unlike the live lane): a sweep
 * that could not deliver has accomplished nothing, and its cron invocation
 * should go red rather than report a clean run.
 */
export async function sweepSilentFailures(options: SweepOptions): Promise<SweepResult> {
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? 15 * 60_000
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * HOUR_MS
  const lookbackMs = options.lookbackMs ?? 24 * HOUR_MS
  const limit = options.limit ?? 500
  const emptyRateThreshold = options.emptyRateThreshold ?? 0.05
  const minTurnsForRate = options.minTurnsForRate ?? 10

  const [unanswered, turns] = await Promise.all([
    options.source.findUnansweredThreads({ minAgeMs, maxAgeMs, now }),
    options.source.listRecentAssistantTurns({ sinceMs: now - lookbackMs, now, limit }),
  ])

  const alerts: TurnHealthAlert[] = []

  // ── silence: messages in, nothing out ──────────────────────────────────
  const pendingUserMessages = unanswered.reduce((sum, t) => sum + t.pendingMessages, 0)
  const oldestUnansweredMs = unanswered.reduce((max, t) => Math.max(max, t.oldestAgeMs), 0)

  if (unanswered.length > 0) {
    const hours = (oldestUnansweredMs / HOUR_MS).toFixed(1)
    alerts.push({
      product: options.product,
      // A day of total silence is not a warning.
      severity: oldestUnansweredMs >= 24 * HOUR_MS ? 'critical' : 'warning',
      key: `sweep:${options.product}:unanswered_threads`,
      title: `${options.product}: ${pendingUserMessages} user message(s) unanswered across ${unanswered.length} thread(s)`,
      details: [
        `oldest unanswered message: ${hours}h`,
        ...unanswered
          .slice(0, 5)
          .map(
            (t) =>
              `thread ${t.threadId}: ${t.pendingMessages} pending, oldest ${(
                t.oldestAgeMs / HOUR_MS
              ).toFixed(1)}h`,
          ),
      ],
      data: {
        unansweredThreads: unanswered.length,
        pendingUserMessages,
        oldestUnansweredMs,
      },
      at: now,
    })
  }

  // ── success that delivered nothing ─────────────────────────────────────
  let emptyCompletions = 0
  let malformedToolCalls = 0
  let toolCallsWithoutEffect = 0
  let unhealthyTurns = 0
  const malformedSamples: TurnHealthReason[] = []

  for (const row of turns) {
    const verdict = classifyTurnOutcome({
      finalText: row.content,
      parts: parseParts(row.parts),
      outputTokens: row.outputTokens ?? null,
    })
    if (verdict.healthy) continue
    unhealthyTurns += 1
    for (const reason of verdict.reasons) {
      if (reason.kind === 'empty_completion') emptyCompletions += 1
      if (reason.kind === 'malformed_tool_call') {
        malformedToolCalls += 1
        if (malformedSamples.length < 3) malformedSamples.push(reason)
      }
      if (reason.kind === 'tool_call_no_effect') toolCallsWithoutEffect += 1
    }
  }

  // A malformed tool call is never acceptable at any rate — it means a
  // deliverable was requested and silently discarded. Page on the first one.
  if (malformedToolCalls > 0) {
    alerts.push({
      product: options.product,
      severity: 'critical',
      key: `sweep:${options.product}:malformed_tool_call`,
      title: `${options.product}: ${malformedToolCalls} tool call(s) had unparseable arguments — deliverables silently dropped`,
      details: malformedSamples.map(describeReason),
      data: { malformedToolCalls, turnsJudged: turns.length },
      at: now,
    })
  }

  if (turns.length >= minTurnsForRate) {
    const rate = emptyCompletions / turns.length
    if (rate > emptyRateThreshold) {
      alerts.push({
        product: options.product,
        severity: 'critical',
        key: `sweep:${options.product}:empty_completion_rate`,
        title: `${options.product}: ${(rate * 100).toFixed(1)}% of turns completed with no output`,
        details: [
          `${emptyCompletions} of ${turns.length} settled turns delivered nothing`,
          `threshold ${(emptyRateThreshold * 100).toFixed(1)}%`,
        ],
        data: { emptyCompletions, turnsJudged: turns.length, rate },
        at: now,
      })
    }
  }

  for (const alert of alerts) await options.sink.deliver(alert)

  return {
    product: options.product,
    unansweredThreads: unanswered.length,
    pendingUserMessages,
    oldestUnansweredMs,
    turnsJudged: turns.length,
    unhealthyTurns,
    emptyCompletions,
    malformedToolCalls,
    toolCallsWithoutEffect,
    alerts,
  }
}

// ── D1 source for the shared chat-store schema ────────────────────────────

/** Minimal structural D1 contract (Cloudflare's `D1Database` satisfies it). */
export interface D1LikeForHealth {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
    }
  }
}

/**
 * The sweep source for products on the canonical `/chat-store` tables.
 *
 * "Answered" deliberately means an assistant row with NON-EMPTY content. A
 * blank assistant row is what a broken turn writes, so counting it as an
 * answer would let the exact failure being hunted mark itself resolved. That
 * single predicate is the difference between this catching the gtm outage and
 * sleeping through it — during those sixteen days the table was NOT empty.
 *
 * The query deliberately does NOT join the thread table. Products do not all
 * keep one: tax-agent's `thread` table holds zero rows because it groups by
 * its own `tax_sessions`, and an inner join against it silently reported "0
 * unanswered threads, healthy" while 18 real messages sat unanswered. A
 * detector that reports healthy because its join found nothing is the same
 * bug class it was built to catch.
 */
export function createD1TurnHealthSource(
  db: D1LikeForHealth,
  options: { messageTable?: string; threadTable?: string } = {},
): TurnHealthSource {
  // Table names are identifiers and cannot be bound as parameters. They come
  // from deploy-time product config, never from a request, and are validated
  // here so this can never become an injection point.
  const message = safeIdentifier(options.messageTable ?? 'message')
  const thread = safeIdentifier(options.threadTable ?? 'thread')

  return {
    async findUnansweredThreads({ minAgeMs, maxAgeMs, now }) {
      const cutoffSeconds = Math.floor((now - minAgeMs) / 1000)
      const floorSeconds = Math.floor((now - maxAgeMs) / 1000)
      const { results } = await db
        .prepare(
          `SELECT m.thread_id AS threadId,
                  COUNT(*) AS pendingMessages,
                  MIN(m.created_at) AS oldestCreatedAt
             FROM ${message} m
            WHERE m.role = 'user'
              AND m.created_at <= ?1
              AND m.created_at >= ?2
              AND m.created_at > COALESCE(
                    (SELECT MAX(a.created_at)
                       FROM ${message} a
                      WHERE a.thread_id = m.thread_id
                        AND a.role = 'assistant'
                        AND length(trim(a.content)) > 0), 0)
            GROUP BY m.thread_id
            ORDER BY oldestCreatedAt ASC`,
        )
        .bind(cutoffSeconds, floorSeconds)
        .all<{ threadId: string; pendingMessages: number; oldestCreatedAt: number }>()

      return results.map((row) => ({
        threadId: row.threadId,
        pendingMessages: Number(row.pendingMessages),
        oldestAgeMs: now - Number(row.oldestCreatedAt) * 1000,
      }))
    },

    async listRecentAssistantTurns({ sinceMs, limit }) {
      const sinceSeconds = Math.floor(sinceMs / 1000)
      const { results } = await db
        .prepare(
          `SELECT id, thread_id AS threadId, content, parts,
                  output_tokens AS outputTokens, model, created_at AS createdAt
             FROM ${message}
            WHERE role = 'assistant' AND created_at >= ?1
            ORDER BY created_at DESC
            LIMIT ?2`,
        )
        .bind(sinceSeconds, limit)
        .all<Record<string, unknown>>()

      return results.map((row) => ({
        id: String(row.id),
        threadId: String(row.threadId),
        content: typeof row.content === 'string' ? row.content : '',
        parts: row.parts,
        outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
        model: (row.model as string | null) ?? null,
        createdAt: Number(row.createdAt) * 1000,
      }))
    },
  }

  function safeIdentifier(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`unsafe table identifier: ${name}`)
    }
    return name
  }
}
