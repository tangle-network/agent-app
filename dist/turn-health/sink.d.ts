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
import { type TurnHealthReason, type TurnHealthSeverity } from './classify.js';
/** One deliverable alert. */
export interface TurnHealthAlert {
    /** Which product raised it (`projectId`). Alerts from four products land in
     *  one channel, so this is what makes the message actionable. */
    product: string;
    severity: TurnHealthSeverity;
    /** Stable grouping key. Throttling is keyed on this, so it must NOT contain
     *  a turn id or a timestamp or every alert is unique and nothing dedupes. */
    key: string;
    title: string;
    /** Human-readable lines. */
    details: string[];
    /** Structured payload for a machine consumer. */
    data?: Record<string, unknown>;
    at: number;
}
/** Deliver an alert. Implementations MUST NOT throw — see
 *  {@link createGuardedAlertSink}. */
export interface AlertSink {
    deliver(alert: TurnHealthAlert): Promise<void>;
}
/** Build the alert for a set of reasons found on one turn. */
export declare function turnAlert(input: {
    product: string;
    severity: TurnHealthSeverity;
    reasons: TurnHealthReason[];
    threadId?: string;
    turnId?: string;
    model?: string;
    at?: number;
}): TurnHealthAlert;
/** Minimal structural fetch, so this module has no lib-dom dependency and can
 *  be driven by a fake in tests. */
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<{
    ok: boolean;
    status: number;
    text?(): Promise<string>;
}>;
/**
 * POST to an incoming webhook in the Slack message format.
 *
 * Chosen because the org already runs one (`SLACK_OPS_WEBHOOK_URL`) and
 * gtm-agent's outbound webhook code already speaks this exact shape — the
 * instruction was to route somewhere humans already look, not to stand up a
 * new channel. Discord and most log drains accept the same `{text}` body.
 */
export declare function createWebhookAlertSink(options: {
    webhookUrl: string;
    fetchImpl?: FetchLike;
}): AlertSink;
/**
 * POST to Slack `chat.postMessage` with a bot token.
 *
 * This is the transport the org actually has. A survey of the four product
 * repos found NO ops alert path of any kind — no incoming webhook, no pager, no
 * notifier — which is the mechanical reason a 17-day outage never reached a
 * human. What does exist is a Slack bot token in the shared secrets store, and
 * `@tangle-network/agent-integrations` already speaks this exact API, so this
 * routes alerts through the channel the org runs rather than standing up a new
 * one.
 *
 * Slack answers `200 OK` with `{"ok": false, "error": "..."}` for an invalid
 * token or channel, so the body is checked and not just the status — a
 * transport that reports success on a rejected post would make the alerter
 * itself a silent failure.
 */
export declare function createSlackBotAlertSink(options: {
    botToken: string;
    channel: string;
    fetchImpl?: FetchLike;
}): AlertSink;
/** stderr sink. The zero-config fallback so a product that has not yet been
 *  given a webhook still emits something a log search can find. */
export declare function createConsoleAlertSink(log?: (message: string) => void): AlertSink;
/** Fan out to several sinks. One failing transport must not stop the others. */
export declare function createMultiAlertSink(sinks: readonly AlertSink[]): AlertSink;
/** Records the last time a key was alerted on. A product backs this with KV,
 *  D1, or a Durable Object; the in-memory default is correct for a sweep that
 *  runs as a single cron invocation. */
export interface AlertThrottleStore {
    lastSentAt(key: string): Promise<number | null>;
    markSent(key: string, at: number): Promise<void>;
}
/** Process-local throttle store. */
export declare function createMemoryThrottleStore(): AlertThrottleStore;
/**
 * Collapse repeats of the same `key` inside `windowMs`.
 *
 * Deliberately re-alerts once per window rather than going silent after the
 * first: an incident that is still burning must keep saying so. Going quiet
 * after one message is how a 17-day outage stays invisible after someone
 * dismisses the first notification.
 */
export declare function createThrottledAlertSink(inner: AlertSink, options: {
    windowMs: number;
    store?: AlertThrottleStore;
}): AlertSink;
/**
 * Swallow transport errors so telemetry can never fail the turn it measures.
 *
 * Use this at the LIVE lifecycle call site only. A sweep should let the error
 * surface, because a sweep that cannot deliver has done nothing at all and its
 * cron run should go red.
 */
export declare function createGuardedAlertSink(inner: AlertSink, onError?: (error: unknown) => void): AlertSink;
