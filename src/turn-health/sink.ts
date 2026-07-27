/**
 * Where a silent-failure verdict GOES.
 *
 * The detection half is worthless without this half. Every failure this module
 * finds was already visible in the database the whole time — 255 unanswered
 * messages sat in a table for 17 days. What was missing was not the data, it
 * was delivery to a human who had not thought to look.
 *
 * So the sink is a seam, not a channel: the product supplies the transport,
 * and agent-app ships the two shapes the fleet already has credentials for
 * (an ops webhook, and stderr). No new channel is invented here.
 */

import { describeReason, type TurnHealthReason, type TurnHealthSeverity } from './classify.js'

/** One deliverable alert. */
export interface TurnHealthAlert {
  /** Which product raised it (`projectId`). Alerts from four products land in
   *  one channel, so this is what makes the message actionable. */
  product: string
  severity: TurnHealthSeverity
  /** Stable grouping key. Throttling is keyed on this, so it must NOT contain
   *  a turn id or a timestamp or every alert is unique and nothing dedupes. */
  key: string
  title: string
  /** Human-readable lines. */
  details: string[]
  /** Structured payload for a machine consumer. */
  data?: Record<string, unknown>
  at: number
}

/** Deliver an alert. Implementations MUST NOT throw — see
 *  {@link createGuardedAlertSink}. */
export interface AlertSink {
  deliver(alert: TurnHealthAlert): Promise<void>
}

/** Build the alert for a set of reasons found on one turn. */
export function turnAlert(input: {
  product: string
  severity: TurnHealthSeverity
  reasons: TurnHealthReason[]
  threadId?: string
  turnId?: string
  model?: string
  at?: number
}): TurnHealthAlert {
  const kinds = [...new Set(input.reasons.map((r) => r.kind))].sort()
  return {
    product: input.product,
    severity: input.severity,
    // Keyed by product + reason kinds ONLY. A blank-completion storm across
    // 200 turns is one incident, not 200 pages.
    key: `turn:${input.product}:${kinds.join('+')}`,
    title: `${input.product}: turn completed but delivered nothing (${kinds.join(', ')})`,
    details: input.reasons.map(describeReason),
    data: {
      kinds,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.model ? { model: input.model } : {}),
    },
    at: input.at ?? Date.now(),
  }
}

// ── transports ────────────────────────────────────────────────────────────

/** Minimal structural fetch, so this module has no lib-dom dependency and can
 *  be driven by a fake in tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text?(): Promise<string> }>

/**
 * POST to an incoming webhook in the Slack message format.
 *
 * Chosen because the org already runs one (`SLACK_OPS_WEBHOOK_URL`) and
 * gtm-agent's outbound webhook code already speaks this exact shape — the
 * instruction was to route somewhere humans already look, not to stand up a
 * new channel. Discord and most log drains accept the same `{text}` body.
 */
export function createWebhookAlertSink(options: {
  webhookUrl: string
  fetchImpl?: FetchLike
}): AlertSink {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  return {
    async deliver(alert) {
      const icon = alert.severity === 'critical' ? ':rotating_light:' : ':warning:'
      const lines = [
        `${icon} *${alert.title}*`,
        ...alert.details.map((d) => `• ${d}`),
        `_${new Date(alert.at).toISOString()}_`,
      ]
      const response = await fetchImpl(options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines.join('\n') }),
      })
      if (!response.ok) {
        // A dropped alert is a silent failure of the silent-failure detector.
        // It must be loud in the one place that is still working: the log.
        throw new Error(`alert webhook responded ${response.status}`)
      }
    },
  }
}

/** stderr sink. The zero-config fallback so a product that has not yet been
 *  given a webhook still emits something a log search can find. */
export function createConsoleAlertSink(log: (message: string) => void = console.error): AlertSink {
  return {
    async deliver(alert) {
      log(
        `[turn-health] ${alert.severity.toUpperCase()} ${alert.title} :: ${alert.details.join(' | ')}`,
      )
    },
  }
}

/** Fan out to several sinks. One failing transport must not stop the others. */
export function createMultiAlertSink(sinks: readonly AlertSink[]): AlertSink {
  return {
    async deliver(alert) {
      const settled = await Promise.allSettled(sinks.map((s) => s.deliver(alert)))
      const failures = settled.filter((r) => r.status === 'rejected')
      if (failures.length === sinks.length && sinks.length > 0) {
        throw new Error('every alert sink failed')
      }
    },
  }
}

// ── throttling ────────────────────────────────────────────────────────────

/** Records the last time a key was alerted on. A product backs this with KV,
 *  D1, or a Durable Object; the in-memory default is correct for a sweep that
 *  runs as a single cron invocation. */
export interface AlertThrottleStore {
  lastSentAt(key: string): Promise<number | null>
  markSent(key: string, at: number): Promise<void>
}

/** Process-local throttle store. */
export function createMemoryThrottleStore(): AlertThrottleStore {
  const seen = new Map<string, number>()
  return {
    async lastSentAt(key) {
      return seen.get(key) ?? null
    },
    async markSent(key, at) {
      seen.set(key, at)
    },
  }
}

/**
 * Collapse repeats of the same `key` inside `windowMs`.
 *
 * Deliberately re-alerts once per window rather than going silent after the
 * first: an incident that is still burning must keep saying so. Going quiet
 * after one message is how a 17-day outage stays invisible after someone
 * dismisses the first notification.
 */
export function createThrottledAlertSink(
  inner: AlertSink,
  options: { windowMs: number; store?: AlertThrottleStore },
): AlertSink {
  const store = options.store ?? createMemoryThrottleStore()
  return {
    async deliver(alert) {
      const last = await store.lastSentAt(alert.key)
      if (last !== null && alert.at - last < options.windowMs) return
      await inner.deliver(alert)
      await store.markSent(alert.key, alert.at)
    },
  }
}

/**
 * Swallow transport errors so telemetry can never fail the turn it measures.
 *
 * Use this at the LIVE lifecycle call site only. A sweep should let the error
 * surface, because a sweep that cannot deliver has done nothing at all and its
 * cron run should go red.
 */
export function createGuardedAlertSink(
  inner: AlertSink,
  onError: (error: unknown) => void = (e) => console.error('[turn-health] alert delivery failed', e),
): AlertSink {
  return {
    async deliver(alert) {
      try {
        await inner.deliver(alert)
      } catch (error) {
        onError(error)
      }
    },
  }
}
