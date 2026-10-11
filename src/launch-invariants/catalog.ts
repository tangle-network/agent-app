/**
 * The launch invariants every agent app holds, and the budgets they are held to.
 *
 * Each one is a failure GTM shipped to production on 2026-10-10 and fixed by
 * hand. They are listed here once so every app checks the same rule with the
 * same numbers, and `agent-app-invariants` reports each by its id.
 */

/** Budgets the invariants are measured against. */
export const LAUNCH_BUDGETS = {
  /** Most bytes one query may return in a scheduled job or report route: one sized batch with room for its listing. */
  queryBytes: 8 * 1024 * 1024,
  /** Most the live heap may grow while one scheduled job runs on a day-sized fixture. */
  heapGrowthBytes: 40 * 1024 * 1024,
  /** Most bytes of a large column one sized read returns; a single larger row is read alone. */
  sizedReadBytes: 4 * 1024 * 1024,
  /** Most stored events one long turn may write. */
  turnEvents: 5_000,
  /** A turn whose owner stopped reaches its terminal state within this long. */
  settleWithinMs: 15 * 60_000,
  /** Turn recovery and orphan settlement run at least this often. */
  recoveryEveryMs: 15 * 60_000,
  /** Longest a cached auth lookup may be served while the store cannot answer. */
  authCacheTtlMs: 60_000,
  /** A platform-limit alarm fires at this share of the limit. */
  alarmRatio: 0.8,
} as const

export type LaunchInvariantId =
  | 'bounded-reads'
  | 'memory-budget'
  | 'isolated-jobs'
  | 'honest-settlement'
  | 'coalesced-events'
  | 'auth-survives-d1-stall'
  | 'authorize-before-stream'
  | 'limit-alarms'

export interface LaunchInvariant {
  id: LaunchInvariantId
  title: string
  /** The rule, as the conformance report states it. */
  rule: string
  /** The production failure the rule answers. */
  incident: string
}

export const LAUNCH_INVARIANTS: readonly LaunchInvariant[] = [
  {
    id: 'bounded-reads',
    title: 'Bounded reads',
    rule: 'No query in a scheduled job or report route returns more than 8 MB; large columns are read in sized batches of at most 4 MB.',
    incident: 'GTM turn health read 500 replies with their parts (122 MB of a 128 MB Worker); the reliability report scanned 1.63 M events and overloaded D1.',
  },
  {
    id: 'memory-budget',
    title: 'Memory budget',
    rule: 'Every scheduled job runs on a day-sized fixture with live-heap growth of at most 40 MB, and every scheduled job is covered.',
    incident: 'GTM sweeps exceeded the Worker\'s 128 MB six times; a regex slice kept in a Map pinned whole tool outputs.',
  },
  {
    id: 'isolated-jobs',
    title: 'Isolated scheduled jobs',
    rule: 'Each scheduled invocation runs exactly one job, and turn recovery and orphan settlement run at least every 15 minutes.',
    incident: 'At 21:00Z turn health ran out of memory while the hourly sweeps shared one run, and none of the eight queued after it ran.',
  },
  {
    id: 'honest-settlement',
    title: 'Honest turn settlement',
    rule: 'Every turn reaches exactly one terminal state (an answer, a typed failure with Retry, or a Stop counted on its own) within 15 minutes of its owner stopping; failures are attributed to the request time, and a completed run with an aborted tool is a failure.',
    incident: 'Stale running rows (51 settled by hand), failure notices 8–11 h late, and completions with aborted tools counted as answers.',
  },
  {
    id: 'coalesced-events',
    title: 'Coalesced turn events',
    rule: 'A recorded long turn stores at most 5,000 events: text and reasoning deltas are merged before storage.',
    incident: 'A reasoning model wrote 59,659 events in one turn and 1.63 M in a day.',
  },
  {
    id: 'auth-survives-d1-stall',
    title: 'Auth survives a D1 stall',
    rule: 'A key or session verified within 60 s keeps working while D1 errors or stalls; the cache is used only then, never past revoke or expiry, and is keyed by SHA-256.',
    incident: 'An overloaded D1 failed sign-in and API-key checks for credentials that were valid moments before.',
  },
  {
    id: 'authorize-before-stream',
    title: 'Authorization before any stream',
    rule: 'A refused request gets a plain response; no stream opens and no product state is touched before authorization resolves.',
    incident: 'agent-app 0.60.48–0.60.49 opened a progress-first stream before authorize ran.',
  },
  {
    id: 'limit-alarms',
    title: 'Platform-limit alarms at 80%',
    rule: 'Worker memory, D1 rows per query, sandbox disk, snapshot count and key rate each have a declared limit and an alarm that fires at 80%.',
    incident: '19 platform-limit events on 2026-10-10, each found after it failed a customer.',
  },
]

/** The invariant ids in report order. */
export const LAUNCH_INVARIANT_IDS: readonly LaunchInvariantId[] = LAUNCH_INVARIANTS.map((invariant) => invariant.id)

/** One checked outcome of one invariant, for one subject (a job, a route, a scenario). */
export interface InvariantVerdict {
  invariant: LaunchInvariantId
  /** What was checked: a job name, a route, a scenario. */
  subject: string
  pass: boolean
  /** Findings, one line each. On a pass, what was proven. */
  details: string[]
  /** Measurements behind the verdict, for the report. */
  data?: Record<string, unknown>
  /**
   * Set when the app recorded this failure as known, with why and who owns the
   * fix. The report counts it as not holding; it does not fail the suite.
   */
  knownFailing?: string
}

/** A verdict whose message names every finding, for a test runner's failure output. */
export function describeVerdict(verdict: InvariantVerdict): string {
  const head = `${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.invariant} — ${verdict.subject}`
  return verdict.details.length ? `${head}\n  ${verdict.details.join('\n  ')}` : head
}
