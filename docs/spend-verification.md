# Spend verification (`/spend`)

A product that runs sandboxes bills a platform it does not control.
When that platform's billing has a defect, the product finds out from a bank statement.
This subpath is the consumer's half of the problem: the product's own record of what it asked for, diffed against what it was charged.

## The incident this exists for

On 2026-08-05 an abandoned-project reclaimer deprovisioned a set of long-parked sandboxes.
A pre-fix defect had left their compute intervals open, and deletion settled each one "up to now" instead of up to the boundary at which the box had actually stopped.
Twenty-three settlements with July interval starts and durations of 124 to 268 hours landed inside seven minutes against one wallet: **$514.161090533**.
Seven other wallets took another **$100.15** in the same window.

The platform defect is fixed and every affected wallet was refunded ([agent-dev-container#4422](https://github.com/tangle-network/agent-dev-container/issues/4422)).
The structural hole is not.
Products bill to a shared company key, so no individual balance visibly goes negative; and no product holds an independent record of what it believes it should owe.
Seven of the eight affected users never noticed.
That is the gap this closes: **a platform billing defect should cost an alert, not silent money.**

## Threat model

**Defends against**

- A platform billing defect that charges for time the box was not running — the incident's exact shape.
- Drift: a settlement path that quietly starts billing on a different boundary than the product assumes.
- A box the product never asked for, billed against the product's key.
- Unbounded exposure: spend continuing to accrue with nothing watching and nothing stopping.

**Does NOT defend against, by design**

- **A product certifying its own charges.**
  The platform's ledger stays authoritative.
  Nothing here writes to a ledger, refunds anything, disputes anything, or suppresses a charge.
  The output is evidence a human takes to the platform.
  A consumer-side checker that could cancel a charge would be a consumer-side ledger, and then there would be two.
- **Fraud or a compromised key.**
  This compares two honest records; it assumes both parties are trying to be right.
- **Cost the product genuinely incurred.**
  A box left running for a week because nobody stopped it is a product bug, and the reconciler will correctly say nothing.
  The budget guard is the control for that, not the reconciler.

The asymmetry that makes the whole thing safe: every bound this computes is an **upper** bound, and every derivation error pushes toward a false alarm rather than a missed charge.
A false alarm costs a human five minutes.
A missed charge is the incident.

## What the ceiling can and cannot bound

The expectation ledger records, per box: when the product first saw it, the last moment it observed work, any detached run it dispatched and has not seen finish, and a stop or delete when the product knows about one.
From those it derives an **expected billable ceiling** — the longest the box could honestly have been billable.

```
horizon = deleted      → the delete instant
        | stopped      → the stop instant
        | detached     → the reconciliation instant   (unbounded — see below)
        | otherwise    → last observed activity + the idle timeout

horizon = min(horizon, created + maxLifetime)   // the hard platform bound
horizon = min(horizon, now)                     // unelapsed time was not billed
ceiling = horizon - created + tolerance
```

### What it CAN bound

| Blind spot | Why the bound survives it |
|---|---|
| **A platform-side suspend the product never sees** | A suspend only ever *removes* billable time. An upper bound is unaffected, so nothing widens for it. |
| **A reconnect** | A reconnect is recorded as activity; the fold takes the max and the horizon moves out on its own. No special case. |
| **Out-of-order or replayed lifecycle events** | The fold is monotonic — activity only moves forward, delete is set-once. A replayed old event cannot rewind the bound. |
| **A stop that did not take** | The ceiling gets *tighter*, so the settlement breaks it and the discrepancy is reported. That is a true positive: the product believes the box stopped and the platform kept billing. |

### What it CANNOT bound

**An unfinished detached run.**
The product dispatched work and disconnected.
The box keeps working — and billing — past the last activity anyone observed, so `lastActivityAt` genuinely understates the truth and an activity-based bound would be a lie.
The ceiling therefore abandons that basis entirely, degrades to the reconciliation instant, and reports `bounded: false`.
A finding on that basis means the platform billed time outside the box's own lifetime, which is a much stronger claim than "longer than expected" — and the absence of a finding means nothing at all.

**The rescue is `maxLifetimeSeconds`.**
The platform destroys the box at `created + maxLifetime` regardless of what anyone observed, so a product that asks for one holds a hard bound that survives every blind spot above.
Both shipped products ask for 86 400 s.
This is why the incident is detectable with **no lifecycle bookkeeping at all**: 124 hours billed against a 24-hour maximum lifetime is out of bounds on arithmetic alone.

**A duration the ledger does not store.**
The `credit_transactions` row carries an amount, not a duration.
Three ways to recover it, and the reconciler labels which it used on every finding:

| Basis | Derivation | Exact? |
|---|---|---|
| `reported` | The product's ledger view exposed it | Yes |
| `rate` | `charge ÷ price-per-hour` — the platform computes the charge as `(durationMs / 3 600 000) × costPerHour` and nothing else enters it | Yes, if the product knows its box's price |
| `reference-span` | `settledAt − intervalStart`, both read off the row | **No — an upper bound.** A correct settlement that the platform's durable settlement queue merely posted late reads longer here than it billed |

`reference-span` is the default, because no product currently knows its box's price.
It is *exact* for the failure this module exists to catch: billing "up to now" makes the settlement instant and the interval end the same moment.
Findings on that basis carry the caveat inline, and supplying `nanoUsdPerHour` upgrades them to the exact basis.

### Tolerance and thresholds

| Knob | Default | Why |
|---|---|---|
| `toleranceMs` | 900 000 (15 min) | The platform's *own* settlement-staleness threshold. Its runbook clears an incident when `/health computeSettlement.oldestAgeSeconds` is "back under 900" — so 900 s is lag the platform has already declared normal. Must stay well under the idle window (3 600 s in every shipped product). |
| `velocity.multiple` | 5 | A product doubling or tripling its load in a day is ordinary. Five times a trailing median is not. The incident ran at **1 344×**, so the threshold is nowhere near the signal. |
| `velocity.minAbsoluteNanoUsd` | 1 000 000 000 ($1.00) | Without a floor the rule is useless — a trailing median of a tenth of a cent makes every ordinary day a 5× outlier. Set from the incident's own distribution: the smallest of the eight affected wallets took $1.98, and the two rows in the same window that were *genuine* were sub-cent. The floor sits above the noise and below every real finding. |
| `velocity.minTrailingWindows` | 3 | Below this a median means nothing, so the rule stays silent and a product's genuine first days are not an anomaly. |
| `velocity.windowMs` | 86 400 000 (24 h) | The incident settled inside seven minutes; any window wider than the burst catches it, and a day is the unit an operator reasons in. |

## Calibration against the incident

`src/spend/calibration.test.ts` runs the reconstructed incident (`src/spend/fixtures/incident-parked-time.ts`) through the reconciler.
The fixture marks per field what comes from the receipts and what is reconstructed, because a fixture that blends the two proves nothing.

Measured, 75 rows / 75 boxes / $519.54 charged (the burst plus fourteen ordinary prior days plus the two genuine sub-cent rows):

| Adoption state | `unknown-box` | `over-ceiling` | `velocity` | `negative-balance` | Total |
|---|---|---|---|---|---|
| **Expectation ledger adopted** | 0 | **23** | **1** | 1 | 25 |
| **Reconciler only, nothing recorded** | 75 | 0 | **1** | — | 76 |

- The 23 `over-ceiling` findings are exactly the 23 parked boxes, and their amounts sum to **$514.161090533** — the refunded total, to the nanodollar.
- A representative finding: settled **124.00 h** against a ceiling of **1.45 h**, over by **122.55 h**, ceiling basis `idle-timeout`, duration basis `reference-span`.
- `velocity` fires once, on the 2026-08-05 window: **$514.18** against a trailing median of **$0.38** over 14 prior windows — **1 343.8×**.
- **Zero false positives.** The 50 ordinary rows and the two genuine sub-cent rows in the same window are silent.
- The day-one column matters: a product that wires only the reconciler still catches the incident before it has recorded a single box. `unknown-box` is weaker evidence, but $514 leaving does not go unnoticed.

## Adoption

### Both products, the one-line seam

`ensureWorkspaceSandbox` takes an optional `spend` field.
Omitted, nothing changes — no extra call, no extra await.
Wired, the same object both refuses to provision past a cap and records that a box is now billable.

```ts
import { createSandboxSpendHooks, createSpendLedger } from '@tangle-network/agent-app/spend'

const spend = createSandboxSpendHooks({
  ledger: createSpendLedger({ store: myDrizzleSpendStore }),
  budget: {
    limitNanoUsd: 250_000_000_000,            // $250 / workspace
    settledNanoUsd: (ws) => settledComputeFor(ws),
    onRefusal: (r) => alert('compute budget', r),
  },
  onError: (err) => console.error('[spend] record failed', err),
})
```

### tax-agent

Creation runs through `apps/web/src/lib/.server/sandbox-service.ts:127-142` (`ensureSessionSandbox`), which already sets `idleTimeoutSeconds: 3600` / `maxLifetimeSeconds: 86400` at `:446-453`.
Add one field to the ensure options:

```ts
// apps/web/src/lib/.server/sandbox-service.ts:137-141
return shellEnsureWorkspaceSandbox(this.buildTaxShell({ ...opts, harness }), {
  workspaceId: opts.userId,
  userId: opts.userId,
  harness,
  spend,                         // ← the only line that changes
})
```

tax-agent already persists `box.id` into `tax_sessions.project_ref` at `sandbox-service.ts:88-97`, so it has half a lifecycle record already; the expectation store is a new table beside it.
Its two archive routes (`routes/api.sessions.$id.ts:170`, `routes/api.sessions.bulk-delete.ts:148`) call a `deleteContainer` that is deliberately a no-op — those are the natural seams for `ledger.recordStopped` if the product ever does stop a box.

### legal-agent

Creation runs through `src/lib/.server/sandbox/index.ts:448-473`, resources at `:389-396`.
Same one-line change, into the options object built at `:458-466`:

```ts
// src/lib/.server/sandbox/index.ts:458-466
const ensureOptions: EnsureOptionsWithBillingOwner = {
  workspaceId,
  ...(userId ? { userId } : {}),
  harness,
  ...(options?.forceNew ? { forceNew: true } : {}),
  ...(billingOwnerId ? { billingOwnerId } : {}),
  spend,                         // ← the only line that changes
}
```

legal-agent has **no** sandbox lifecycle record today — it resolves its box by name on every call and never persists `box.id` — so the expectation store is greenfield there.

**One known leak, and it is not covered by this seam.**
`src/lib/.server/user-sandbox.ts:57` builds its own `Sandbox` client and calls `client.create()` directly, bypassing agent-app entirely, for the per-user terminal box (`legal-u-*`, distinct from the per-workspace `legal-s11-*` box).
Boxes created there are invisible to `ensureWorkspaceSandbox`'s hook and will surface as `unknown-box` findings until either that path is routed through the shell or it calls `ledger.observeSandbox` itself.
Naming it is the point: a reconciler that quietly ignored those boxes would be reporting a clean bill for an account that is not clean.

### Scoping the ledger fetch

The product supplies its own settled rows — this package never reaches for them, because the ledger is the counterparty's record and reading it is the product's authenticated business.
**That fetch must be scoped to boxes the product owns.**
Products bill to a shared company key, so an unscoped fetch returns every sibling product's settlements and every one of them is a correct, useless `unknown-box` finding.
Scope by `group_key` (`sandbox:<id>`) against the product's own box ids, or by the `key_id` the product's boxes were created under.

### Running it

Programmatically, or as a scheduled gate:

```jsonc
// package.json
"scripts": { "spend-check": "agent-app-spend-check" }
```

`agent-app-spend-check` reads `spend.config.mjs`, which default-exports the reconcile options (or a function returning them).
Exit 0 clean, 1 on findings, 2 on a usage or config error; a failing report goes to stderr so a cron that only forwards stderr still delivers the alert.

## What it does not do yet

- **Nothing records stop or delete in production**, because neither shipped product stops or deletes a box — the 3 600 s platform idle timeout is the only reclamation today. The ceiling therefore rests on `idle-timeout` and `max-lifetime` in practice. Both are sound; `stopped`/`deleted` are simply tighter bounds waiting for a caller.
- **Turn-level activity is not hooked automatically.** `ensureWorkspaceSandbox` is the only automatic recording seam. A product that runs long turns should call `ledger.recordActivity` from its turn path, and `recordDetachedRunStarted`/`Ended` around any detached run, or the ceiling will be tighter than the truth and produce false alarms.
- **The budget guard is a pre-check against spend already settled**, not a reservation. Settlement lags provisioning by design, so the cap overshoots by at most the unsettled tail — bounded by the box's own idle timeout. A cap that refuses one box late is worth more than one that cannot be implemented honestly.
