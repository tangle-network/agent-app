# Launch invariants

Every agent app holds eight invariants before launch. Each is a failure GTM shipped on 2026-10-10 and fixed by hand. They live in `@tangle-network/agent-app/launch-invariants`, so every app checks the same rule with the same numbers and gets each fix once.

| Id | Rule | Runtime piece | Check |
|---|---|---|---|
| `bounded-reads` | No query in a scheduled job or report route returns more than 8 MB; large columns are read in sized batches of at most 4 MB | `sizedBatches`, `readInSizedBatches` | `checkScheduledJobBudgets` |
| `memory-budget` | Each scheduled job grows the live heap by at most 40 MB on a day-sized fixture, and every scheduled job is covered | — | `checkScheduledJobBudgets` |
| `isolated-jobs` | Each scheduled invocation runs exactly one job; turn recovery and orphan settlement run at least every 15 minutes | `createScheduledDispatch` | `checkIsolatedJobs` |
| `honest-settlement` | Every turn reaches exactly one terminal state (an answer, a typed failure with Retry, or a Stop counted on its own) within 15 minutes of its owner stopping; failures are attributed to the request time; a completed run with an aborted tool is a failure | `settleOrphanedTurns` (`/stream`) | `checkSettlementScenarios`, `checkTurnSettlement` |
| `coalesced-events` | The recorded long turn stores at most 5,000 events | the turn buffer (`/stream`) | `checkCoalescedTurn` |
| `auth-survives-d1-stall` | A key or session verified within 60 s keeps working while D1 errors or stalls; never past revoke or expiry; cache keys are SHA-256 | `createAuthLookupCache`, `credentialCacheKey` | `checkAuthSurvivesStall` |
| `authorize-before-stream` | A refused request gets a plain 4xx; no stream opens and no state is touched first | `createChatTurnRoutes` (`/chat-routes`) | `checkAuthorizeBeforeStream` |
| `limit-alarms` | Worker memory, D1 rows per query, sandbox disk, snapshot count and key rate alarm at 80% of a declared limit | `createLimitAlarms`, `withD1LimitAlarms` | `checkLimitAlarms` |

The runtime pieces are server-safe. The checks are in `@tangle-network/agent-app/launch-invariants/testing`, which uses Node built-ins and belongs in tests only.

## Adopt the kit

1. Add `launch-invariants.config.mjs` at the app root.

   ```js
   export default {
     product: 'gtm',
     test: 'pnpm exec vitest run tests/launch-invariants.test.ts',
     // Default: the first of wrangler.toml, wrangler.jsonc, wrangler.json at the root.
     wrangler: ['wrangler.toml'],
   }
   ```

2. Write `tests/launch-invariants.test.ts`. Each check drives the app's real code through a small adapter; `recordInvariant` fails the test with the findings and records the verdict for the report.

   ```ts
   import { readFileSync } from 'node:fs'
   import { checkIsolatedJobs, parseWranglerCrons, slotsOf } from '@tangle-network/agent-app/launch-invariants'
   import { checkScheduledJobBudgets, recordInvariant, recordInvariants } from '@tangle-network/agent-app/launch-invariants/testing'

   it('isolated jobs', () => {
     const crons = parseWranglerCrons(readFileSync('wrangler.toml', 'utf8'), 'toml')
     recordInvariant(checkIsolatedJobs({
       configuredCrons: [...crons.top, ...Object.values(crons.envs).flat()],
       slots: slotsOf(SCHEDULE).map((slot) => ({ ...slot, jobs: [slot.job] })),
       recoveryJobs: ['turn-recovery', 'orphan-settlement'],
     }))
   })

   it('bounded reads and memory budget', async () => {
     recordInvariants(await checkScheduledJobBudgets({ d1: dayFixture.d1, install: setD1, jobs, scheduled }))
   })
   ```

3. Add the command to the app's CI and its signoff steps.

   ```json
   { "scripts": { "invariants": "agent-app-invariants" } }
   ```

   `agent-app-invariants` runs the `test` command with `AGENT_APP_INVARIANTS_RESULTS` set, reads the recorded verdicts, and prints one line per invariant. It exits 0 when all eight hold and 1 otherwise; `--json <file>` writes the report.

An invariant passes when at least one verdict was recorded for it and every recorded verdict passed. The CLI reads the wrangler configs itself: the cron check must have read every cron any environment configures, so a test cannot pass on a stale list.

An app adopts the kit before every invariant holds. Mark a check that fails today with why it fails, who owns the fix and the next check:

```ts
recordInvariant(checkSettlementScenarios(records, { now }), {
  knownFailing: 'runtime-restart, aborted-tool and Stop scenarios settle in the completion Workflow, not driven yet (L4, turn-lifecycle slice 3)',
})
```

The report counts a known failure as not holding (`7 of 8 hold, 1 known failing`) and exits 0, so the app's releases continue. A known-failing check that starts passing fails its test until the marker is removed, so a fixed invariant cannot regress silently.

Not applicable is accepted only where the deployment shows it:

| Invariant | Accepted when |
|---|---|
| `isolated-jobs`, `memory-budget` | No wrangler environment configures a cron |
| `bounded-reads`, `auth-survives-d1-stall` | The app has no D1 binding |

The other four apply to every agent app. Declare an accepted case in the config as `notApplicable: { 'isolated-jobs': 'no scheduled work' }`.

## Write the checks

### Bounded reads and memory budget

Build a day-sized fixture in the app's own schema: about 60 MB of message parts and turn events, as a busy day stores them. Pass every job the app schedules, by name, as `scheduled`; a job that is scheduled but not run fails coverage.

`checkScheduledJobBudgets` wraps the D1 binding (`measureD1`), measures each response's serialized bytes, and samples the live heap after a forced collection before and after every query. node:sqlite and better-sqlite3 keep pages off the JS heap, so the growth it reports is the job's own. A failure names the largest query, or the query running when the heap peaked.

Fix a failing job by listing keys with `length(column)` and reading `sizedBatches` of them, handling each batch before the next. Keep what you conclude, not what you read. A substring sliced or matched out of a large string can pin the whole parent in V8: GTM's digest kept regex matches in a Map and held every tool output they came from until it copied them out (`new URL(match).href`). Composite keys such as `(turnId, seq)` bind two parameters each, so use `rows: SIZED_READ_COMPOSITE_ROWS`; a consecutive `seq BETWEEN` range can use `rows: Infinity`.

### Isolated jobs

Give each job its own invocation. A cron's minute list carries one job per minute, so a Worker keeps a few trigger expressions:

```ts
const SCHEDULE = [
  { cron: '0,1,2,3 * * * *', minutes: { 0: 'post-scheduler', 1: 'approval-digest', 2: 'reliability', 3: 'turn-health' } },
  { cron: '7,22,37,52 * * * *', job: 'turn-recovery' },
  { cron: '8,23,38,53 * * * *', job: 'orphan-settlement' },
]
export const scheduled = createScheduledDispatch({ entries: SCHEDULE, jobs })
// worker: scheduled(event, env, ctx) { return scheduled.dispatch(event, env, (p) => ctx.waitUntil(p)) }
```

An app that keeps its own dispatcher observes what each invocation runs by driving its handler with stubbed jobs, and passes those slots instead.

### Honest settlement

Seed each of `SETTLEMENT_SCENARIOS` into the app's own storage at a fixed `now`, run the app's recovery and settlement jobs at that `now`, read each turn back as a `SettledTurnRecord`, and pass them to `checkSettlementScenarios`. The scenarios are the shapes GTM shipped: an orphaned stream, a request that died before admission, a runtime restart under an admitted run, a completed run with an aborted tool, a user Stop, a normal answer and a live long turn.

Schedule `settleOrphanedTurns` from `/stream` as its own job at least every 15 minutes. It ends each running turn stream nothing renewed past its lease with a typed, retryable error, without moving the row in time, and returns each turn's detection lag. A product whose durable owner does not renew the turn row answers `isOwned`. A Cloudflare Workflow instance keeps the script version it started on, so a settlement fix reaches running instances only after they are restarted or terminated by id.

### Coalesced events

`checkCoalescedTurn` replays `recordedLongTurn()` (59,659 events: three per token from a reasoning model, with tool calls between) through the app's turn persistence, attached and after a completion handoff, under a controlled clock. The shared buffer stores about 4,400 events attached and about 1,000 detached. Attached storage grows about three rows per 400 ms flush window, so a turn streamed attached for much longer than ten minutes approaches the budget.

### Auth survives a D1 stall

Put each auth lookup (session, API key, key owner) behind `createAuthLookupCache`, keyed by `credentialCacheKey`. The cache reads the store first and serves the last valid result only when the store errors or stalls past 2.5 s, for at most 60 s from the last verification, and never after the store refuses. Drop the entry on revoke and rotate. Serve the verified object itself: GTM keyed a WeakMap on it, a copy missed, and operator requests answered 401.

`checkAuthSurvivesStall` takes the app's real lookup and revoke path over a `stallingD1` binding, and moves `Date.now` forward to age the cache.

### Authorization before any stream

Pass the app's mounted route handler and requests it must refuse (no session, another workspace's thread, a revoked key). Apps on `createChatTurnRoutes` from 0.60.51 or later get the property from the route factory; the check proves the app's own `authorize` refuses.

### Limit alarms

Declare a limit for each of the five resources and build alarms with `createLimitAlarms` over the app's alert sink, wrapped in `createThrottledAlertSink` from `/turn-health`. Wrap the Worker's D1 binding with `withD1LimitAlarms` to observe rows read and response size per query. Read sandbox disk and snapshot count from the Sandbox SDK on a schedule, and the per-key request rate where the operator API counts it. workerd exposes no heap reading, so Worker memory is observed through response sizes, plus a tail consumer reporting `exceededMemory` at the full limit.

`checkLimitAlarms` builds the app's alarms over a capturing sink and checks each resource: silent at 79%, a warning at 80%, critical at the limit, and no declared limit above the platform's.
