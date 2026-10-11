/**
 * `/launch-invariants` — the rules every agent app holds before launch, and the
 * runtime pieces that hold them.
 *
 * Each invariant is a failure GTM shipped on 2026-10-10 and fixed by hand
 * (see {@link LAUNCH_INVARIANTS}). This subpath carries what runs in the
 * Worker: sized reads, the scheduled dispatcher that gives each job its own
 * invocation, the auth lookup cache that survives a D1 stall, and the 80%
 * platform-limit alarms. `/launch-invariants/testing` carries the checks an app
 * runs in its own suite, and `agent-app-invariants` reports them per invariant.
 *
 * Server-safe: no Node built-ins. See docs/launch-invariants.md.
 */
export {
  describeVerdict,
  LAUNCH_BUDGETS,
  LAUNCH_INVARIANT_IDS,
  LAUNCH_INVARIANTS,
  type InvariantVerdict,
  type LaunchInvariant,
  type LaunchInvariantId,
} from './catalog.js'
export {
  D1_MAX_BOUND_PARAMETERS,
  readInSizedBatches,
  SIZED_READ_BYTES,
  SIZED_READ_COMPOSITE_ROWS,
  SIZED_READ_ROWS,
  sizedBatches,
  type SizedBatchOptions,
  type SizedRow,
} from './sized-reads.js'
export {
  AUTH_LOOKUP_DEADLINE_MS,
  AUTH_LOOKUP_TTL_MS,
  AuthLookupRefused,
  createAuthLookupCache,
  credentialCacheKey,
  type AuthLookupCache,
  type AuthLookupCacheOptions,
  type AuthLookupOptions,
} from './auth-lookup-cache.js'
export {
  checkIsolatedJobs,
  createScheduledDispatch,
  cronDailyFirings,
  longestGapMinutes,
  parseWranglerCrons,
  slotsOf,
  type IsolatedJobsInput,
  type ObservedSlot,
  type ScheduledDispatch,
  type ScheduledDispatchOptions,
  type ScheduledDispatchResult,
  type ScheduledJob,
  type ScheduledJobInput,
  type ScheduledJobOutcome,
  type ScheduleEntry,
  type ScheduleSlot,
  type WranglerCrons,
} from './schedule.js'
export {
  createLimitAlarms,
  estimatedBytes,
  LIMIT_RESOURCES,
  withD1LimitAlarms,
  type LimitAlarmOptions,
  type LimitAlarms,
  type LimitBudgets,
  type LimitLevel,
  type LimitObservation,
  type LimitResource,
} from './limit-alarms.js'
export {
  checkSettlementScenarios,
  checkTurnSettlement,
  SETTLEMENT_SCENARIOS,
  type SettledTurnRecord,
  type SettlementScenario,
  type TurnSettlementCounts,
  type TurnTerminalState,
} from './settlement.js'
