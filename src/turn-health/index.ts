/**
 * `/turn-health` — make a failure that returns success impossible to miss.
 *
 * Conventional health checks probe DEPENDENCIES and answer "is the sandbox
 * reachable, is the router up". Every outage measured in this fleet happened
 * with all dependencies green:
 *
 *   - gtm-agent answered 0 of ~250 user messages for sixteen consecutive days
 *     while `/api/health` returned 200 the entire time;
 *   - turns settled `completed` with `finalText: ""` and `outputTokens: 0`;
 *   - six tool calls collapsed into one unparseable call, persisting nothing,
 *     raising nothing.
 *
 * This module probes the OUTCOME instead, in two lanes that catch different
 * things:
 *
 *   - LIVE — {@link createTurnHealthLifecycle} fills the `lifecycle` seam
 *     `createChatTurnRoutes` already exposes, and pages the moment a turn
 *     settles having delivered nothing.
 *   - SWEEP — {@link sweepSilentFailures} runs on a cron and counts what
 *     arrived against what was answered. It is the only lane that can see an
 *     outage which produces no turns at all.
 *
 * Server-only, subpath-only. The alert transport is a seam; the shipped
 * implementations target the ops webhook the org already runs.
 */

export {
  classifyTurnOutcome,
  describeReason,
  type TurnHealthReason,
  type TurnHealthSeverity,
  type TurnHealthVerdict,
  type TurnOutcomeInput,
} from './classify.js'

export {
  createTurnHealthLifecycle,
  type TurnHealthCompleteInfo,
  type TurnHealthErrorInfo,
  type TurnHealthLifecycle,
  type TurnHealthLifecycleOptions,
} from './lifecycle.js'

export {
  type AlertSink,
  type AlertThrottleStore,
  createConsoleAlertSink,
  createGuardedAlertSink,
  createMemoryThrottleStore,
  createMultiAlertSink,
  createThrottledAlertSink,
  createWebhookAlertSink,
  type FetchLike,
  type TurnHealthAlert,
  turnAlert,
} from './sink.js'

export {
  createD1TurnHealthSource,
  type D1LikeForHealth,
  type PersistedTurnRow,
  sweepSilentFailures,
  type SweepOptions,
  type SweepResult,
  type TurnHealthSource,
  type UnansweredThread,
} from './sweep.js'
