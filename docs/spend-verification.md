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
- **The check itself going quiet while looking green** — an empty ledger fetch, an expectation ledger naming nobody, an ownership rule that stopped matching after a key rotation. See [Were we billed for everything we asked for?](#were-we-billed-for-everything-we-asked-for-window).

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
- **A sibling product's spend on the same wallet.**
  Excluded by `ownership` and reported as a number, never as a finding — see [Whose box is this?](#whose-box-is-this-ownership).
  The product that owns those boxes runs its own reconciliation; a product cannot dispute a charge it did not incur.
  Two products sharing one platform API key are indistinguishable here by construction, and the answer is a second key.

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

## Whose box is this? (`ownership`)

A settlement naming a sandbox the product has never heard of is one of two completely different things, and from inside one product they arrive identical:

- **a sibling product's box** on the same wallet — nothing is wrong, and reporting it is noise that trains a human to ignore the check;
- **a charge that is not ours** — the incident's day-one signature, and the only thing a product with no lifecycle bookkeeping can catch at all.

Measured: seeding one gtm box plus one legal-agent settlement row on the same wallet produced `{ ok: false, findingCount: 1 }`, blaming a box that was never gtm's.

### What we did not do

**Filter the settlements down to boxes already in the expectation ledger.**
It removes the false findings and removes the check with them.
"We were billed for a box we never asked for" *is* a box that is not in the ledger, so filtering on the ledger makes a phantom charge unrepresentable — the ledger's own contents would define the answer, and a product that recorded nothing would be certified clean.
A design that trades the incident detection away to remove false positives is the wrong design however clean the report looks.

**Match a product-owned box-name prefix.**
Unimplementable on today's platform, not merely weak.
The sandbox id on a settlement row is the orchestrator's project ref, minted as `sandbox-<12 hex>` from a SHA-256 of (owner, idempotency key) — `makeSandboxProjectRef`, `products/sandbox/api/src/routes/sandboxes.ts` — and surfaced as the SDK's `id`.
The `name` a product asks for never reaches the ledger row, and the charge's `description` carries only the resource spec (`Sandbox compute: 2vCPU/4GB × 2.00h`).
There is no name in the data to match.
A prefix rule wired anyway would classify every row as another product's and report a clean bill for an unchecked account — the same silence, arrived at more confidently.

### What we did

Split the residue on the one field the **platform** stamps per product: `credit_transactions.key_id`, the API key the box was created under, written from the box's own creation metadata at settlement time.

```ts
import { ownedByBillingKeys, reconcileSpend } from '@tangle-network/agent-app/spend'

await reconcileSpend({
  rows,
  store,
  ownership: ownedByBillingKeys([process.env.SANDBOX_API_KEY_ID!]),
})
```

| Box | Verdict | Outcome |
|---|---|---|
| In the expectation ledger | `mine`, and the rule is never consulted | Full checks — `over-ceiling` fires whatever any rule says |
| Not recorded, stamped with one of our keys | `mine` | **`unknown-box` finding** — a phantom-charge candidate |
| Not recorded, stamped with another key | `foreign` | Reported in `report.ownership`, never a finding |
| Not recorded, no key stamped | `undecidable` | **`unknown-box` finding** — fail closed |

Three rules keep the detection intact, and each is a test:

1. **A recorded box is never excluded.** Ownership is consulted only for boxes with no ledger record, so a rule that is wrong or over-narrow cannot hide an `over-ceiling` finding. The incident's own 23 findings survive any rule at all.
2. **Undecidable fails closed.** A row with no key attribution is claimed. Silence is never the answer to "I don't know", and an unattributable charge on a shared wallet is precisely the shape of the thing this module watches for.
3. **A box is claimed if any of its rows claims it.** `mine` > `undecidable` > `foreign`. Both directions push toward reporting, which is the only direction that cannot lose money.

Because the rule reads a stamp the platform already wrote, a product cannot widen its own claim by asserting one — it can only recognise attribution or fail to.

### The deployment requirement this creates

**Each product needs its own platform API key.**
Two products sharing one key are genuinely indistinguishable after settlement: nothing on the row differs, so no consumer-side predicate can separate them and the honest verdict for both is `undecidable` — every sibling box reported, back to the original noise.
The fix for that is a second key, not a cleverer predicate.

### Absence is loud, not silent

`ownership` is optional and omitting it changes nothing about the findings: the pass claims every box, which is the behaviour that shipped and the direction that over-reports rather than under-reports.
What it does not do is keep quiet about it.

- `report.ownership.declared` is `false`.
- `formatSpendReport` prints `scope: NOT DECLARED — …` above the findings.
- Every `unknown-box` message says a sibling product's box reads exactly like a charge that is not ours, and the remedy names `ownedByBillingKeys`.

The same reasoning runs the other way for a declared rule.
A clean report and a rule so narrow it verified nothing produce the same `OK` line, so the scope line and the excluded box ids print on **every** report, clean ones included — an exclusion a reader cannot audit is one they have to take on trust.

### Velocity moves with it

With a rule declared, `velocity` counts only this product's rows.
A product cannot dispute a charge it did not incur, and leaving the siblings in means one product's incident wakes every product on the wallet.
The finding says which basis it used, and the wallet-level total stays visible in `report.ownership`.

## Were we billed for everything we asked for? (`window`)

Every rule above is driven by a settlement row.
That makes the reconciler able to answer exactly one direction of the question — *were we billed for something we did not ask for, or for more than allowed* — and structurally unable to answer the other: *were we NOT billed for something we DID ask for*.
With no row there is nothing to iterate, and a rule that never fires reports a clean bill.

Three real shapes fall straight through that hole, and each of them used to render as `ok: true`:

| Shape | What the report said | What was true |
|---|---|---|
| The expectation ledger names no box, so the pass examines nobody | `ok: true` | Nothing was checked |
| The billing endpoint quietly starts returning zero rows | `ok: true`, `rowsExamined: 0` | The feed is broken |
| A stale or rotated key list excludes every box | `ok: true`, everything `foreign` | The ownership rule stopped matching |

In all three the check stopped checking while looking green — which is the exact failure class this module exists to prevent, reproduced inside the module.

### The discriminator is already in the ledger

The expectation ledger records when the product first saw a box, the last work it observed, and any stop or delete it knows about.
Those are precisely the inputs `computeExpectedCeiling` already folds into a **horizon** — the latest instant a box could still have been billable.
So a box's live interval is `[createdAt, horizon]`, taken from the same fold the ceiling check uses rather than from a second definition of "running" that could drift from it.
No new store, no new column, no new event.

A box whose live interval overlaps the reconciliation window is a box the product **expected** to be billed for.

```ts
import { reconcileSpend } from '@tangle-network/agent-app/spend'

const report = await reconcileSpend({
  rows,
  store,                                        // must implement `listLiveBetween`
  ownership: ownedByBillingKeys([keyId]),
  window: { startAt: since, endAt: now },       // the window `rows` was fetched for
})
```

The window is **declared, never derived from the rows** — deriving it from the rows is circular, since a feed returning nothing would produce a window that expects nothing and certifies itself.
A window that ends at or before it starts throws rather than examining nobody inside it.

`listLiveBetween` is a new **optional** method on `SpendLedgerStorePort`, and it may over-return.
The reconciler re-derives liveness itself, so the intended implementation is the coarse predicate a `WHERE` clause can express and the exact answer stays in one place:

```sql
WHERE created_at <= :endAt AND (deleted_at IS NULL OR deleted_at >= :startAt)
```

### The new outcome: `silent-ledger`

The fifth check, and the only one whose subject is the **check** rather than the bill.
It reads as *do not trust this report*, not as *dispute this charge*, and it has three shapes because the reader's next action differs in each:

| Shape | Finding | Reader's next action |
|---|---|---|
| Every expected box settled nothing | One aggregate finding | Re-run the transactions query for the window by hand and compare the row count |
| One box silent while its siblings settled | One finding per box | Check settlement lag, then whether that box was created under an unclaimed key |
| The pass examined nobody and expected nothing | One finding | Declare `window` and implement `listLiveBetween` — the question is currently unanswerable |

### Settlement lag, and why the grace period is load-bearing

Settlement lags provisioning.
A box that came up ninety seconds before the window closed has no settlement yet and never should have, so expecting one would report the platform's ordinary queue behaviour as a defect.
Expectation is therefore asserted only for boxes with at least `expectationGraceMs` of live time **inside** the window.

| Knob | Default | Why |
|---|---|---|
| `expectationGraceMs` | 900 000 (15 min) | The same number as `toleranceMs`, from the other side: the platform's runbook clears a compute-settlement incident when `oldestAgeSeconds` is "back under 900", so 900 s is lag the platform has already declared normal. Shrink it for a short window, or the window expects nothing at all. |

### A clean bill is now something a pass has to earn

`report.coverage` is the new gate, and `ok` is `findings.length === 0 && coverage !== 'unverified'`.

| `coverage` | When | `ok` can be true? |
|---|---|---|
| `verified` | The pass claimed at least one of its own settlements, or declared an expectation with boxes in it | Yes |
| `nothing-expected` | Expectation declared, and no box was live long enough to expect a bill — an idle product | Yes. This is the one case where a pass that examined nobody is still clean |
| `unverified` | The pass examined none of this product's settlements and could not say what it expected | **No** |

The gate sits on `coverage`, not on the finding, deliberately: `skip: ['silent-ledger']` removes the noise, never the verdict, so no combination of options can make an examined-nobody pass report clean.

### Gating the all-excluded pathology

Consumers raise an alarm on `boxesExamined > 0 && ownedBoxes === 0` — "we saw settlements but none were ours".
That shape has two completely different causes and the naive test cannot tell them apart: an ownership rule gone stale after a key rotation, or **a product that was legitimately idle while a sibling settled on the same wallet**.
Under the naive test an idle product pages every single day, which is how a real alert gets muted.

`assessAllExcluded` is the shared answer, so seven consumers do not each re-derive it:

```ts
import { assessAllExcluded } from '@tangle-network/agent-app/spend'

const excluded = assessAllExcluded(report)
if (excluded.pathological) alert('spend scope', excluded.reason)
```

| `basis` | `pathological` | Meaning |
|---|---|---|
| `not-all-excluded` | `false` | The pass examined its own settlements |
| `expected-boxes-live` | `true` | Boxes of ours were live and every settlement read as a sibling's — the rule has stopped matching |
| `nothing-expected` | `false` | Declared expectation, nothing live: an idle product beside a busy sibling |
| `not-declared` | `true` | No expectation declared, so the question is unanswerable. **Fails closed** — today's behaviour, and the `reason` names the fix |

### Absence is loud here too

Exactly the discipline `ownership` already follows.
Omitting `window`, or wiring a store with no `listLiveBetween`, changes no existing finding and is never silent:

- `report.expectation.declared` is `false`.
- `formatSpendReport` prints `expectation: NOT DECLARED — …` above the findings.
- A pass that also examined none of its own settlements prints `UNVERIFIED — …` and cannot be `ok`.

A declared expectation prints its window, its live/expected/settled counts and every unsettled box id on **every** report, clean ones included — an expectation a reader cannot audit is one they have to take on trust.

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

### Turn activity

The same object goes on the turn primitives, which is what keeps the ceiling honest for long turns.

```ts
for await (const event of streamSandboxPrompt(shell, box, prompt, { spend })) { /* … */ }
await driveSandboxTurn(shell, box, prompt, { sessionId, spend })
```

`onActivity` fires at the start of a turn and again when it settles — including when it throws, because a turn that died still burned box time up to the moment it died.
It is **synchronous by contract and unawaited**: it sits on the turn path, so a store write must not add latency to it or hold a stream open.
`createSandboxSpendHooks` settles the write internally and routes failures to `onError`, so nothing escapes as an unhandled rejection.
The autonomous lane needs it most — a detached turn keeps the box billable with nobody watching, and every tick that reports `running` is fresh evidence it is still working.

Without this, `lastActivityAt` only advances when a box is provisioned, so a three-hour turn leaves the ceiling three hours too tight and manufactures a discrepancy out of the product's own silence.

### Scoping the ledger fetch

The product supplies its own settled rows — this package never reaches for them, because the ledger is the counterparty's record and reading it is the product's authenticated business.
The fetch is `GET /v1/billing/transactions?product=sandbox`, and the most it can narrow to is a **wallet**: `product` there is the platform's own service taxonomy, written by `agent-dev-container` for every sandbox compute charge from every consumer app.
So on an account running two of our products, each product's fetch returns the other product's boxes.

The endpoint does accept `keyId`, and filtering there is worth doing — it moves less data.
It is not a substitute for declaring ownership in the reconciler, for two reasons: a `keyId` filter silently drops rows the platform left unattributed (exactly the rows worth seeing), and a reconciliation that cannot state what it excluded cannot be audited.
Declare `ownership` whether or not the fetch also filters.

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
- **Detached runs must still be declared by the product.** The turn primitives tap activity automatically (see below), but `recordDetachedRunStarted`/`Ended` are the product's call — only it knows that a dispatch it made is one it will not watch finish. Without them a detached run looks like an ordinary turn that went quiet, and the ceiling will be tighter than the truth.
- **`silent-ledger` needs a store that can list its boxes.** `listLiveBetween` is optional and no shipped product implements it yet, so today every product's pass reports `expectation.declared: false` until it adds the one query. That is loud rather than silent — but until it lands, a pass that examines nobody is reported as `unverified`, not fixed.
- **A settlement the platform never posted at all is indistinguishable from one this product's ownership rule cannot see.** `silent-ledger` reports the shape; which of the two it is comes from re-running the fetch by hand, which is why that is the first line of the remedy.
- **The budget guard is a pre-check against spend already settled**, not a reservation. Settlement lags provisioning by design, so the cap overshoots by at most the unsettled tail — bounded by the box's own idle timeout. A cap that refuses one box late is worth more than one that cannot be implemented honestly.
