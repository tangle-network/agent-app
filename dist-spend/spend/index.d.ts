/**
 * The vocabulary of consumer-side spend verification.
 *
 * Kept in its own module with ZERO imports so a product can type its storage
 * rows and its reconciliation config without pulling in `node:fs` through the
 * CLI half.
 *
 * The model in one paragraph: the platform's ledger is authoritative about what
 * was CHARGED. A product knows something the ledger does not — what it ASKED
 * for. Recording that second view, and diffing it against the first, is what
 * turns a platform billing defect from silent money into an alert. Nothing here
 * lets a product self-certify a charge away; the output is a discrepancy a human
 * disputes.
 */
/**
 * One box, as the PRODUCT understands it. Folded, not an append-only log: a
 * product runs one row per sandbox, and every field below is derived by a
 * monotonic fold (see `foldSpendBoxRecord`) so two concurrent writers cannot
 * produce a wrong answer, only a stale one.
 *
 * Timestamps are epoch ms throughout, matching the platform's own
 * `sandbox_meta.last_started_at`.
 */
interface SpendBoxRecord {
    /** The platform's sandbox id — the join key to every settlement row. */
    readonly sandboxId: string;
    /** The product's own tenancy unit, which the platform does not model. */
    readonly workspaceId: string;
    /** First moment the product knew this box existed. */
    readonly createdAt: number;
    /**
     * The idle timeout the product ASKED the platform for, seconds. This is the
     * width of the grace window between the last thing the product saw and the
     * moment the platform should have stopped billing.
     */
    readonly idleTimeoutSeconds: number;
    /**
     * The maximum lifetime the product asked for, seconds, when it asked for one.
     * This is the strongest bound a product holds: the platform destroys the box
     * at `createdAt + maxLifetimeSeconds` regardless of what the product observed,
     * so it caps the ceiling even when nothing else can (see `computeExpectedCeiling`).
     */
    readonly maxLifetimeSeconds: number | null;
    /** Latest moment the product OBSERVED the box doing work. */
    readonly lastActivityAt: number;
    /**
     * Detached runs dispatched but never observed to finish, by run id.
     *
     * Non-empty means the product genuinely cannot bound this box from its own
     * observations: it handed the platform work and disconnected. The ceiling
     * degrades accordingly rather than pretending to a tightness it did not earn.
     */
    readonly openDetachedRunIds: readonly string[];
    /** When the product knows the box stopped. Cleared by later activity. */
    readonly stoppedAt: number | null;
    /** When the product knows the box was deleted. Set once — a deleted id never returns. */
    readonly deletedAt: number | null;
    /** Opaque product-column values, written verbatim and never read here. */
    readonly extras?: Record<string, unknown>;
}
/**
 * A fold step. Every field states its own merge rule, so a SQL implementation
 * can apply it in one statement and reach the same record an in-memory
 * read-modify-write reaches.
 */
interface SpendBoxPatch {
    /** Advance `lastActivityAt` to the max of stored and this. Never moves backward. */
    readonly observedActivityAt?: number;
    /** Add a run id to `openDetachedRunIds` (set semantics — re-adding is a no-op). */
    readonly openDetachedRunAdd?: string;
    /** Remove a run id from `openDetachedRunIds`. Removing an absent id is a no-op. */
    readonly openDetachedRunRemove?: string;
    /**
     * Latest-wins. Activity observed AFTER a recorded stop clears it: a box that
     * worked after we thought it stopped is running again, and a stale stop would
     * make the ceiling too tight.
     */
    readonly stoppedAt?: number;
    /** Set-once. A later delete observation does not move the first one. */
    readonly deletedAt?: number;
}
/** Which fact bounds a box's billable time, weakest last. */
type CeilingBasis = 
/** The product observed deletion. Billing cannot run past a box that is gone. */
'deleted'
/** The product observed a stop. Billing should have closed there. */
 | 'stopped'
/** No stop seen, but the platform destroys the box at its max lifetime. */
 | 'max-lifetime'
/** No stop seen; the platform's idle timer is what should have closed billing. */
 | 'idle-timeout'
/**
 * An unfinished detached run and no max lifetime — the product cannot bound
 * this box at all, so the ceiling degrades to the reconciliation instant.
 * A finding on this basis is weak evidence and says so.
 */
 | 'open-detached-run';
/** The upper bound on one box's billable duration, and what earned it. */
interface ExpectedCeiling {
    readonly sandboxId: string;
    readonly basis: CeilingBasis;
    /** The latest instant this box could still have been billable, epoch ms. */
    readonly horizonAt: number;
    /** `horizonAt - createdAt + toleranceMs`. The upper bound on billable ms. */
    readonly ceilingMs: number;
    readonly toleranceMs: number;
    /**
     * False when the basis is `open-detached-run` — the ceiling then rests on the
     * reconciliation instant rather than on anything the product observed, so an
     * overage means the platform billed outside the box's own lifetime, not merely
     * longer than expected.
     */
    readonly bounded: boolean;
}
/**
 * One settled ledger row, in the shape the platform's `credit_transactions`
 * table stores it. The product supplies these through its own fetch (the
 * platform's credit-history API, an export, a mirror) — this package never
 * reaches for them, because the ledger is the counterparty's record and reading
 * it is the product's authenticated business.
 *
 * The rows a product can fetch are scoped to the BILLING OWNER, not to the
 * product: `product: 'sandbox'` is the platform's service taxonomy and every
 * consumer app's compute wears it. So a wallet running two of our products
 * returns both products' settlements, and telling them apart is
 * {@link SpendOwnershipRule}'s job.
 */
interface SettlementRow {
    /** The ledger row id, for the dispute. */
    readonly id: string;
    /**
     * `sandbox:<kind>:<sandboxId>:<intervalStartMs>` — the platform's idempotency
     * key, and the only place the billed interval's START is recorded.
     */
    readonly referenceId: string | null;
    /**
     * Signed nanodollars, exactly as the ledger stores it: negative is a charge,
     * positive is a credit or refund.
     */
    readonly amountNanoUsd: number;
    /** `compute` | `refund` | `inference` | … */
    readonly type: string;
    /** `sandbox` | `router` | … */
    readonly product: string | null;
    /** `sandbox:<sandboxId>` — the platform's aggregation unit. */
    readonly groupKey: string | null;
    /** Settlement instant, epoch ms. The product normalizes the stored text. */
    readonly createdAt: number;
    readonly description: string | null;
    /** Provider at-cost basis, unsigned nanodollars. Null when unattributed. */
    readonly costBasisNanoUsd: number | null;
    /**
     * The billed duration, when the product's ledger view exposes it directly.
     * Null is the common case: the platform does not store duration on the row.
     */
    readonly billedMs: number | null;
    /**
     * The platform API key the charge was triggered by — `credit_transactions.key_id`,
     * stamped from the box's own creation metadata at settlement time and exposed
     * by `/v1/billing/transactions` (which also filters on it).
     *
     * This is the ONLY field on a settlement row that can be attributed back to a
     * PRODUCT rather than to a wallet or to the platform's service taxonomy, which
     * is why {@link SpendOwnershipRule}'s shipped constructor is built on it. The
     * sandbox id cannot do the job: the platform mints it as `sandbox-<12 hex>`
     * from a hash of (owner, idempotency key), so a product's own box naming never
     * reaches the ledger row.
     *
     * Optional, and `null` is a real answer: the platform leaves it null on legacy
     * rows and an export may not carry the column at all. A missing key is
     * `undecidable`, never `foreign` — see {@link SpendOwnershipVerdict}.
     */
    readonly keyId?: string | null;
}
/**
 * What one settlement is attributable to, from inside ONE product.
 *
 * The distinction this type exists for: a sibling product's box and a charge
 * that is not ours at all look identical from inside a single product, because
 * both arrive as a settlement naming a sandbox this product's expectation ledger
 * has never heard of. Dropping both loses the check's whole purpose; reporting
 * both makes it noise. Only a platform-stamped attribution field separates them.
 */
type SpendOwnershipVerdict = 
/** Attributable to THIS product. An unrecorded one is a phantom-charge candidate. */
'mine'
/** Attributable to a DIFFERENT product on the same wallet. Reported, never a finding. */
 | 'foreign'
/**
 * The row carries nothing that decides it. Counted as `mine` — FAIL CLOSED.
 * An unattributable charge on a shared wallet is precisely the shape of the
 * thing this module exists to catch, so the ambiguous case costs a human five
 * minutes rather than costing the product the detection.
 */
 | 'undecidable';
/** One settlement, presented to an ownership rule. */
interface SpendOwnershipCandidate {
    readonly row: SettlementRow;
    /** The sandbox the row is attributable to, or null for a row naming none. */
    readonly sandboxId: string | null;
}
/**
 * The product's declaration of which settlements are its own.
 *
 * The one hard constraint on `decide`: it must answer from PROPERTIES OF THE
 * ROW. A rule that answers by looking the sandbox up in the product's own
 * expectation ledger deletes `unknown-box` entirely — every unrecorded box would
 * be `foreign` by construction, and "we were billed for a box we never asked
 * for" would become unrepresentable. The ledger already decides recorded-ness;
 * this decides ATTRIBUTION, and the two must stay independent.
 *
 * `decide` must not throw. If it does, the throw propagates and the whole pass
 * fails — a reconciliation whose ownership rule is broken has no verdict worth
 * printing, and swallowing it would turn a broken rule into a clean bill.
 */
interface SpendOwnershipRule {
    /** Named in the report and on every finding, so a reader knows what was excluded. */
    readonly label: string;
    decide(candidate: SpendOwnershipCandidate): SpendOwnershipVerdict;
}
/**
 * What this pass scoped itself to — present on every report, including a clean
 * one, because "nothing fired" and "nothing was looked at" are different
 * answers and a report that cannot tell them apart is the failure this closes.
 */
interface SpendOwnershipSummary {
    /**
     * False when the caller declared no rule. The pass then treats every box as
     * its own — today's behaviour, which over-reports rather than under-reports —
     * and every `unknown-box` finding says on its face that a sibling product's
     * box is indistinguishable from a charge that is not ours.
     */
    readonly declared: boolean;
    /** The rule's label, or null when none was declared. */
    readonly label: string | null;
    /** Boxes this pass treated as this product's, and what they were charged. */
    readonly ownedBoxes: number;
    readonly ownedNanoUsd: number;
    /**
     * Of those, the boxes no rule could decide. Counted as owned (fail-closed) and
     * reported separately so a product can see how much of its own verdict rests
     * on rows that carried no attribution.
     */
    readonly undecidableBoxes: number;
    /** Boxes attributed to another product on the same wallet. Never findings. */
    readonly foreignBoxes: number;
    readonly foreignNanoUsd: number;
    /**
     * Their ids, in full — an exclusion a reader cannot audit is an exclusion
     * they have to trust, and this module's whole posture is that nothing about
     * money is taken on trust.
     */
    readonly foreignSandboxIds: readonly string[];
}
/**
 * The stretch of time a reconciliation pass covers — the same window the
 * product's own ledger fetch was scoped to.
 *
 * Declared by the caller rather than derived from the rows, because deriving it
 * from the rows is circular: a feed that returns nothing would produce a
 * zero-width window that expects nothing and certifies itself.
 */
interface SpendWindow {
    /** Inclusive start, epoch ms. */
    readonly startAt: number;
    /** Inclusive end, epoch ms. */
    readonly endAt: number;
}
/**
 * One box's life, measured against a reconciliation window.
 *
 * The live interval is `[createdAt, horizon]`, where the horizon is the SAME one
 * `computeExpectedCeiling` derives — so a box cannot count as live for the
 * expectation check and dead for the ceiling check.
 */
interface SpendBoxLiveness {
    readonly sandboxId: string;
    readonly workspaceId: string;
    /** First instant the box could have been billable. */
    readonly liveFrom: number;
    /** Last instant it could have been, evaluated at the window's end. */
    readonly liveUntil: number;
    /** Which fact closed the interval — the ceiling's own vocabulary. */
    readonly basis: CeilingBasis;
    /** True when any of that life fell inside the window. */
    readonly overlaps: boolean;
    /** How much of it did, in ms. Zero for a box that did not overlap. */
    readonly liveMsInWindow: number;
    /**
     * True when the overlap is long enough that a settlement should have landed.
     * A box that came up moments before the window closed is live but not yet
     * expected — settlement lags provisioning, and demanding a row inside that lag
     * would report the platform's ordinary queue as a defect.
     */
    readonly expectSettlement: boolean;
}
/**
 * What this pass EXPECTED to be billed for — present on every report, including
 * a clean one, for the same reason {@link SpendOwnershipSummary} is: "nothing
 * fired" and "nothing was expected" and "nothing could be expected" are three
 * different answers and a report that cannot tell them apart is the failure this
 * closes.
 */
interface SpendExpectationSummary {
    /**
     * False when the caller declared no window, or the store cannot list its
     * boxes. The pass then cannot say what it expected — which is reported, never
     * rounded down to a clean bill.
     */
    readonly declared: boolean;
    readonly window: SpendWindow | null;
    /** Live ms inside the window before a settlement is expected of a box. */
    readonly graceMs: number;
    /** Boxes whose life overlapped the window at all. */
    readonly liveBoxes: number;
    /** Of those, the ones live long enough that a settlement should have landed. */
    readonly expectedBoxes: number;
    /** Of those, the ones at least one settlement this pass claimed did land against. */
    readonly settledBoxes: number;
    /**
     * The expected boxes nothing settled against, in full — the exhibit list for
     * "the check stopped checking", and an expectation a reader cannot audit is
     * one they have to take on trust.
     */
    readonly unsettledSandboxIds: readonly string[];
}
/**
 * How much this pass is entitled to claim about the bill.
 *
 * `ok` is gated on this, which is what makes an examined-nobody pass
 * structurally incapable of rendering as a clean bill.
 */
type SpendCoverage = 
/** The pass examined this product's settlements, or knows what it expected. */
'verified'
/**
 * Expectation was declared and no box was live long enough to expect a bill.
 * Zero settlements is the RIGHT answer — an idle product, not a defect, and
 * the one case in which a pass that examined nobody is still clean.
 */
 | 'nothing-expected'
/**
 * The pass examined none of this product's settlements and cannot say what it
 * expected. The CHECK is suspect, not the bill.
 */
 | 'unverified';
/** The parts of a settlement reference id, once parsed. */
interface SettlementReference {
    /** `stop` | `compute` | `egress` | `gpu-lease` | anything the platform adds. */
    readonly kind: string;
    /** For compute kinds, the sandbox id. For `gpu-lease`, the lease id. */
    readonly resourceId: string;
    /** The interval's start, epoch ms. Null for kinds that carry no interval. */
    readonly intervalStartMs: number | null;
}
/** How a settled duration was arrived at — every duration finding carries one. */
type BilledDurationBasis = 
/** The ledger row carried the duration. Exact. */
'reported'
/** `amount ÷ the product's stated hourly rate`. Exact when the rate is right. */
 | 'rate'
/**
 * `settledAt - intervalStart`. An UPPER bound, not the billed duration: a
 * correct settlement posted late by the platform's durable settlement queue
 * reads longer here than it billed. Findings on this basis say so.
 */
 | 'reference-span'
/** No basis available — duration rules are skipped for this row. */
 | 'unknown';
/** The checks this reconciler runs. Each is individually skippable, by name. */
type SpendCheckId = 
/** A settlement against a box the product has no record of ever asking for. */
'unknown-box'
/** A settled duration longer than the product's own upper bound allows. */
 | 'over-ceiling'
/** A spend window far above the trailing median — the burst shape of a defect. */
 | 'velocity'
/** The balance the product observes has gone below its floor. */
 | 'negative-balance'
/**
 * The product expected settlements and saw none — the only check whose
 * subject is the CHECK rather than the bill.
 *
 * Every other rule is driven by a settlement row, so all of them go quiet
 * together when the rows stop arriving: an empty ledger fetch, a stale
 * ownership rule that excludes every box, an expectation ledger naming
 * nobody. This is the rule that fires when the others cannot, and it reads as
 * "do not trust this report" rather than "dispute this charge".
 */
 | 'silent-ledger';
declare const SPEND_CHECKS: readonly SpendCheckId[];
/**
 * One discrepancy, with every number the rule compared.
 *
 * Nullable fields are per-check and deliberately present-but-null rather than
 * absent: a reader scanning a JSON dump can tell "this rule does not measure
 * that" from "that measurement is missing".
 */
interface SpendFinding {
    readonly check: SpendCheckId;
    /** What is wrong, in one sentence, with the numbers in it. */
    readonly message: string;
    /** What to do about it. A finding without a remedy is a complaint. */
    readonly remedy: string;
    readonly sandboxId: string | null;
    readonly workspaceId: string | null;
    /** The ledger rows that evidence this finding — the dispute's exhibit list. */
    readonly referenceIds: readonly string[];
    /** Nanodollars this finding puts in question, unsigned. */
    readonly settledNanoUsd: number;
    /** `over-ceiling` — the duration actually settled, and how that was derived. */
    readonly settledMs: number | null;
    readonly durationBasis: BilledDurationBasis | null;
    /** `over-ceiling` — the bound it broke, and what earned that bound. */
    readonly ceilingMs: number | null;
    readonly overageMs: number | null;
    readonly ceilingBasis: CeilingBasis | null;
    /** `velocity` — the window, its trailing median, and the ratio between them. */
    readonly windowNanoUsd: number | null;
    readonly trailingMedianNanoUsd: number | null;
    readonly velocityRatio: number | null;
    /** `velocity` and `silent-ledger` — the window the finding is about. */
    readonly windowStartAt: number | null;
    readonly windowEndAt: number | null;
    /** `negative-balance` — the observed balance and the floor it broke. */
    readonly balanceNanoUsd: number | null;
    readonly balanceFloorNanoUsd: number | null;
    /** `silent-ledger` — how many boxes were expected to settle, and how many did. */
    readonly expectedBoxes: number | null;
    readonly settledBoxes: number | null;
    /** `silent-ledger`, per-box form — how long that box was live inside the window. */
    readonly liveMsInWindow: number | null;
}
/** What one reconciliation pass concluded. */
interface SpendReport {
    /**
     * True when nothing fired AND the pass earned the right to say so:
     * `findings.length === 0 && coverage !== 'unverified'`.
     *
     * The second half is not decoration. Every rule but `silent-ledger` is driven
     * by a settlement row, so a pass that read no rows — an empty ledger fetch, a
     * stale ownership rule excluding every box, an expectation ledger naming
     * nobody — fires nothing and used to report a clean bill. `coverage` is what
     * makes that shape unrepresentable, and it holds even when a caller skips the
     * `silent-ledger` check: the skip removes the finding, never the verdict.
     */
    readonly ok: boolean;
    /** How much this pass is entitled to claim. See {@link SpendCoverage}. */
    readonly coverage: SpendCoverage;
    readonly findings: readonly SpendFinding[];
    readonly checksRun: readonly SpendCheckId[];
    /** Rows the pass read, including the ones no rule looked at. */
    readonly rowsExamined: number;
    /** Distinct boxes those rows settled against. */
    readonly boxesExamined: number;
    /** Total charged across every examined row, unsigned nanodollars. */
    readonly settledNanoUsd: number;
    /** Total credited back across every examined row, unsigned nanodollars. */
    readonly creditedNanoUsd: number;
    /** What this pass claimed as its own, and what it excluded as another product's. */
    readonly ownership: SpendOwnershipSummary;
    /** What this pass expected to be billed for, and what did not arrive. */
    readonly expectation: SpendExpectationSummary;
    /** The instant the pass treated as "now". */
    readonly asOf: number;
}

/**
 * Which settlements belong to the product running the reconciliation.
 *
 * ## The problem this module is the answer to
 *
 * A product fetches its settled rows from `/v1/billing/transactions`, scoped to
 * the BILLING OWNER — the wallet whose key paid. `product: 'sandbox'` narrows
 * that to compute, but `sandbox` is the PLATFORM's service taxonomy: every
 * consumer app's box compute wears it. So a Tangle account running two of our
 * products hands each product's reconciliation the other product's boxes, and
 * `unknown-box` — correctly, by its own rule — reports one finding per sibling
 * box. Two products on one wallet make each other's spend check useless.
 *
 * ## Why the obvious fix is the wrong fix
 *
 * The obvious fix is to reconcile only the boxes already in the product's
 * expectation ledger. That removes the false findings and removes the check:
 * `unknown-box` exists to catch "we were billed for a box we never asked for",
 * which is the 2026-08-05 incident's day-one signature and the ONLY thing a
 * product with no lifecycle bookkeeping can catch at all. Filtering to the
 * ledger makes a phantom charge unrepresentable — the ledger's own contents
 * would define the answer.
 *
 * So the residue — settlements against boxes with no ledger record — has to be
 * SPLIT, not dropped. A sibling's box and a phantom charge are indistinguishable
 * unless something outside the product's own bookkeeping tells them apart.
 *
 * ## What can tell them apart
 *
 * Exactly one field on a settlement row, and it is not the sandbox id. The
 * platform mints that id as `sandbox-<12 hex>` — a hash of (owner, idempotency
 * key) — so a product's own box naming never reaches the ledger row, and the
 * charge's `description` carries only the resource spec. What does survive is
 * `credit_transactions.key_id`: the platform API key the box was created under,
 * stamped from the box's own creation metadata at settlement and filterable on
 * the transactions endpoint. Each product deploys with its own key, so the key
 * is the product's billing identity as the PLATFORM recorded it — not as the
 * product asserts it after the fact.
 *
 * That asymmetry is what makes the split safe. A product cannot widen its own
 * claim by claiming; it can only recognise a stamp the platform already wrote.
 *
 * ## The three rules that keep the detection intact
 *
 * 1. **A recorded box is never excluded.** Ownership is consulted only for
 *    boxes with no ledger record. A rule that is wrong or over-narrow therefore
 *    cannot hide an `over-ceiling` finding on a box the product recorded — the
 *    incident's own 23 findings survive any rule at all.
 * 2. **Undecidable fails closed.** A row with no key attribution is `mine`, so
 *    an unattributable charge on a shared wallet is reported. Silence is never
 *    the answer to "I don't know."
 * 3. **A box is claimed if ANY of its rows claims it.** The fold is
 *    `mine > undecidable > foreign`, which is the module's standing asymmetry:
 *    every derivation error pushes toward a false alarm, never toward a missed
 *    charge.
 */
/**
 * Claim every settlement the platform stamped with one of these API keys.
 *
 * The shipped rule, because it is the only one built on a field the PLATFORM
 * writes. Give each product its own platform key and this separates them
 * exactly; give two products the same key and no consumer-side rule can tell
 * them apart, because after settlement there is nothing left that differs — the
 * fix then is a second key, not a cleverer predicate.
 *
 * A row with no `keyId` (a legacy row, or an export that drops the column) is
 * `undecidable`, never `foreign`: the absence of an attribution is not evidence
 * that the charge is someone else's.
 *
 * @param keyIds The product's own platform API key ids. Must be non-empty — a
 *   rule that owns nothing would classify every settlement as another product's
 *   and report a clean bill for an account nobody is checking.
 */
declare function ownedByBillingKeys(keyIds: readonly string[]): SpendOwnershipRule;
/**
 * One box's verdict, folded over every row that settled against it.
 *
 * `mine` wins over `undecidable`, which wins over `foreign`: it takes one row
 * attributable to this product to make the box this product's problem, and one
 * unattributable row to stop the box being excluded. Both directions push
 * toward reporting, which is the only direction that cannot lose money.
 *
 * Exported because a product auditing its own scoping wants the same answer the
 * reconciler reached, not a re-derivation of it.
 */
declare function decideBoxOwnership(rule: SpendOwnershipRule, sandboxId: string, rows: readonly SettlementRow[]): SpendOwnershipVerdict;

/**
 * Expectation liveness: what the product BELIEVES it should have been billed for.
 *
 * ## The hole this closes
 *
 * `reconcileSpend` compares settlements against expectations, and every one of
 * its rules is driven by a settlement row. That makes it able to answer exactly
 * one direction of the question:
 *
 * > were we billed for something we did not ask for, or for more than allowed?
 *
 * It cannot answer the other direction — *were we NOT billed for something we
 * DID ask for* — because with no row there is nothing to iterate. Three real
 * shapes fall straight through that hole and every one of them renders as a
 * clean bill:
 *
 * - the expectation ledger names no box, so the pass examines nobody → `ok:true`;
 * - the billing endpoint quietly starts returning zero rows → `ok:true`,
 *   `rowsExamined:0`;
 * - a stale or rotated key list excludes every box → `ok:true` with everything
 *   `foreign`.
 *
 * In all three the check stopped checking while looking green. That is the exact
 * failure class the module exists to prevent, reproduced inside the module.
 *
 * ## The discriminator, and why it is not a new store
 *
 * The expectation ledger already records the only fact needed: when the product
 * first saw a box (`createdAt`), the last work it observed (`lastActivityAt`),
 * and any stop or delete it knows about. Those are precisely the inputs
 * {@link computeExpectedCeiling} already folds into a horizon — the latest
 * instant a box could still have been billable. So a box's LIVE INTERVAL is
 * `[createdAt, horizon]`, derived from the same fold the ceiling uses rather
 * than from a second, drift-prone definition of "running".
 *
 * A box whose live interval overlaps the reconciliation window is a box the
 * product expected to be billed for. The absence of a settlement against it is
 * then a first-class outcome, not silence.
 *
 * ## Why the grace period is load-bearing
 *
 * Settlement lags provisioning. A box that came up ninety seconds before the
 * window closed has no settlement yet and never should have — expecting one
 * would manufacture a finding out of the platform's ordinary queue behaviour.
 * So expectation is asserted only for boxes with at least
 * {@link DEFAULT_EXPECTATION_GRACE_MS} of live time INSIDE the window, which is
 * the platform's own declared-normal settlement lag (see the constant).
 *
 * The asymmetry the rest of the module runs on holds here too, but it points the
 * other way and that is deliberate: an over-tight liveness derivation produces a
 * false ALARM about the check, never a false clean bill. Nothing in this file
 * can make a report cleaner than it would otherwise be.
 */
/**
 * How much live time a box needs inside the window before a settlement is
 * EXPECTED for it. 15 minutes.
 *
 * Same number and same justification as {@link DEFAULT_CEILING_TOLERANCE_MS},
 * arrived at from the other side: the platform's runbook clears a compute
 * settlement incident when `/health computeSettlement.oldestAgeSeconds` is "back
 * under 900", so 900 s is lag the platform has already declared normal. A box
 * live for less than that inside the window may legitimately have settled
 * nothing yet, and demanding a row for it would report the platform's own queue
 * as a defect.
 *
 * A caller parameter, because a product reconciling a very short window must
 * shrink it or the window expects nothing at all.
 */
declare const DEFAULT_EXPECTATION_GRACE_MS = 900000;
/** Options for {@link boxLivenessInWindow}. */
interface BoxLivenessOptions {
    /** Live ms inside the window before a settlement is expected. Default {@link DEFAULT_EXPECTATION_GRACE_MS}. */
    readonly graceMs?: number;
}
/** Reject a window that cannot be reconciled, rather than examining nobody inside it. */
declare function assertSpendWindow(window: SpendWindow): void;
/**
 * One box's live interval, and whether the product should have been billed for
 * it inside this window.
 *
 * The live interval's end is {@link computeExpectedCeiling}'s horizon evaluated
 * at the window's end — the SAME derivation the ceiling check uses, so a box
 * cannot be considered live here and dead there. `toleranceMs` is zero because
 * tolerance is slack allowed to the PLATFORM's clock, and widening a box's life
 * by it would expect settlements for boxes that were already gone.
 */
declare function boxLivenessInWindow(record: SpendBoxRecord, window: SpendWindow, options?: BoxLivenessOptions): SpendBoxLiveness;
/** Why {@link assessAllExcluded} answered the way it did. */
type AllExcludedBasis = 
/** Not every box was excluded — the pass examined some of this product's own. */
'not-all-excluded'
/** Boxes of this product's were live in the window, so an all-foreign pass is wrong. */
 | 'expected-boxes-live'
/** Expectation was declared and nothing was live: an idle product, not a defect. */
 | 'nothing-expected'
/** No expectation was declared, so the question cannot be answered. Fails closed. */
 | 'not-declared';
/** {@link assessAllExcluded}'s verdict, with the reason a pager message needs. */
interface AllExcludedAssessment {
    /** True when the caller should raise. */
    readonly pathological: boolean;
    readonly basis: AllExcludedBasis;
    /** One sentence naming the numbers behind the verdict. */
    readonly reason: string;
}
/**
 * Should "we saw settlements but none of them were ours" page a human?
 *
 * Consumers raise this pathology on `boxesExamined > 0 && ownedBoxes === 0`.
 * That shape has two completely different causes and the naive test cannot tell
 * them apart:
 *
 * - an ownership rule that has gone stale — a rotated key, a new deployment key
 *   nobody added — so every one of the product's OWN boxes now reads as a
 *   sibling's. The check has stopped checking.
 * - a product that was legitimately idle while a sibling settled on the same
 *   wallet. Nothing is wrong, and paging on it pages EVERY day the product is
 *   quiet, which is how a real alert gets muted.
 *
 * The discriminator is expectation liveness: did this product have a box alive
 * during the window? Only then is an all-excluded pass pathological.
 *
 * Fails closed when no expectation was declared — that is today's behaviour, and
 * a pass that cannot answer the question must not answer it optimistically. The
 * `reason` says so, and the fix (declare `window`, implement `listLiveBetween`)
 * is in the string a human reads.
 */
declare function assessAllExcluded(report: SpendReport): AllExcludedAssessment;
/** The expectation summary a pass that declared none reports. Loud, never absent. */
declare function undeclaredExpectation(graceMs: number): SpendExpectationSummary;

/**
 * Persistence seam for the expectation ledger — the product implements it over
 * its own tables.
 *
 * Deliberately NOT compare-and-set, unlike `MissionStorePort`. A mission has one
 * serialized owner and a lost write corrupts a state machine; a box record is a
 * MONOTONIC FOLD (activity takes a max, a detached-run id joins or leaves a set,
 * delete is set-once) so concurrent writers converge no matter what order they
 * land in. The worst a lost race can do here is leave `lastActivityAt` behind
 * the truth — which makes the derived ceiling TIGHTER, so the failure mode is a
 * false alarm a human dismisses, never a missed charge. That asymmetry is the
 * whole reason the fold is shaped this way.
 *
 * `update` returns null when the row does not exist, never a throw.
 */
interface SpendLedgerStorePort {
    load(sandboxId: string): Promise<SpendBoxRecord | null>;
    /** `extras` are the opaque product-column values — write them in the SAME
     *  statement as the record, or ignore them if the table has no extra columns. */
    insert(record: SpendBoxRecord, extras?: Record<string, unknown>): Promise<SpendBoxRecord>;
    update(sandboxId: string, patch: SpendBoxPatch): Promise<SpendBoxRecord | null>;
    /**
     * OPTIONAL — every box that could have been live during the window.
     *
     * This is the one capability that lets a reconciliation answer "were we NOT
     * billed for something we DID ask for". Without it the pass is driven entirely
     * by settlement rows, so a feed that returns nothing fires nothing and reads
     * as a clean bill. Omitting it is safe and additive: the pass reports
     * `expectation.declared: false` and refuses to certify a bill it could not
     * check (see {@link SpendReport.coverage}).
     *
     * **It may over-return.** The reconciler re-derives liveness itself with
     * `boxLivenessInWindow`, so a store that returns every row it has is correct,
     * merely slower. That is deliberate: the definition of "live" must live in one
     * place, not once per product's SQL. The intended predicate is the coarse one
     * a WHERE clause can express —
     *
     * ```sql
     * WHERE created_at <= :endAt AND (deleted_at IS NULL OR deleted_at >= :startAt)
     * ```
     *
     * — and the exact answer (idle timeout, max lifetime, stop, open detached run)
     * is the reconciler's.
     */
    listLiveBetween?(window: SpendWindow): Promise<readonly SpendBoxRecord[]>;
}
/**
 * Apply one fold step. Exported so a SQL implementation and an in-memory one
 * reach the same record, and so a product can unit-test its own store against
 * the canonical answer.
 *
 * The two rules worth stating out loud:
 *
 * - `observedActivityAt` only ever moves `lastActivityAt` FORWARD. A replayed
 *   or out-of-order event cannot rewind the ceiling.
 * - activity later than a recorded `stoppedAt` CLEARS the stop. A box that
 *   worked after the product thought it stopped is running again, and keeping
 *   the stale stop would make the ceiling too tight — inventing an over-ceiling
 *   finding out of the product's own bookkeeping rather than the platform's.
 */
declare function foldSpendBoxRecord(record: SpendBoxRecord, patch: SpendBoxPatch): SpendBoxRecord;
/** An in-memory store that also lets a test inspect and force state. */
interface InMemorySpendLedgerStore extends SpendLedgerStorePort {
    /** Every record, insertion order. */
    records(): SpendBoxRecord[];
    /** Unguarded direct write — simulates a crash-shaped or platform-seeded row. */
    put(record: SpendBoxRecord): void;
}
/** Create an in-memory expectation ledger. Production writers use the same port. */
declare function createInMemorySpendLedgerStore(): InMemorySpendLedgerStore;
/** What the product tells the ledger when it first sees a box. */
interface ObserveSandboxInput {
    readonly sandboxId: string;
    readonly workspaceId: string;
    /** The idle timeout the product asked the platform for, seconds. */
    readonly idleTimeoutSeconds: number;
    /** The max lifetime the product asked for, seconds, when it asked for one. */
    readonly maxLifetimeSeconds?: number | null;
    /** Defaults to the ledger's clock. */
    readonly at?: number;
}
interface SpendLedgerOptions {
    readonly store: SpendLedgerStorePort;
    /** Injectable clock (epoch ms). Default `Date.now`. */
    readonly now?: () => number;
    /** Product columns written verbatim on every insert. */
    readonly extras?: Record<string, unknown>;
}
/**
 * The recording half of spend verification: the product's own account of what
 * it asked the platform for.
 *
 * Every method is best-effort from the caller's point of view — a product wires
 * these into paths that must not fail because bookkeeping failed. They still
 * reject on a store error rather than swallowing it, so a caller that wants
 * fire-and-forget says so at the call site (`/sandbox`'s hook does).
 */
interface SpendLedger {
    /**
     * Record that a box exists and is billable from now. Inserts on first sight,
     * and otherwise records activity — reuse and resume are both "the platform is
     * charging for this box again", and the record's own existence is what
     * distinguishes them, so no caller has to know which happened.
     */
    observeSandbox(input: ObserveSandboxInput): Promise<SpendBoxRecord>;
    /** Record that the product saw this box do work. */
    recordActivity(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>;
    /**
     * Record that the product handed the platform work it will NOT watch finish.
     * Until the matching end is recorded, this box's ceiling cannot rest on
     * observed activity — see `computeExpectedCeiling`.
     */
    recordDetachedRunStarted(sandboxId: string, runId: string, at?: number): Promise<SpendBoxRecord | null>;
    /** Record that a detached run was confirmed finished. */
    recordDetachedRunEnded(sandboxId: string, runId: string, at?: number): Promise<SpendBoxRecord | null>;
    /** Record that the product knows this box stopped. */
    recordStopped(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>;
    /** Record that the product knows this box was deleted. */
    recordDeleted(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>;
}
/** Create the recording half over a product-supplied store. */
declare function createSpendLedger(options: SpendLedgerOptions): SpendLedger;

/**
 * Slack allowed between the product's bound and what the platform settled,
 * before an overage is called a discrepancy. 15 minutes.
 *
 * Not a guess: it is the platform's OWN staleness threshold for compute
 * settlement. Its runbook clears an incident when
 * `/health computeSettlement.oldestAgeSeconds` is "back under 900" — so 900 s is
 * the age the platform itself treats as normal settlement lag, and anything
 * inside it is drift the platform has already declared acceptable. Below that a
 * product would alert on the platform's ordinary queue behaviour; far above it
 * the tolerance starts eating the signal, because the idle window it must stay
 * well under is 3600 s in every shipped product.
 *
 * It is a caller parameter because a product that asks for a shorter idle
 * timeout must shrink this with it.
 */
declare const DEFAULT_CEILING_TOLERANCE_MS = 900000;
interface ComputeExpectedCeilingOptions {
    /** The instant the reconciliation treats as "now", epoch ms. */
    readonly asOf: number;
    /** Slack before an overage counts. Default {@link DEFAULT_CEILING_TOLERANCE_MS}. */
    readonly toleranceMs?: number;
}
/**
 * The upper bound on how long one box could honestly have been billable.
 *
 * The whole design constraint is that this must stay an UPPER bound under
 * everything the product cannot see. Three such blind spots exist, and they
 * pull in different directions:
 *
 * - **Platform-side suspends.** The platform can park a box the product never
 *   hears about. That only ever REDUCES real billable time, so an upper bound
 *   is unaffected and nothing here widens for it.
 * - **Detached runs.** The product dispatches work and disconnects. The box
 *   keeps working — and billing — after the last activity the product saw, so
 *   `lastActivityAt` understates the truth. An unfinished detached run
 *   therefore abandons the activity-based bound entirely rather than reporting
 *   a bound it cannot support.
 * - **Reconnects.** A browser or worker re-attaches and work resumes. This
 *   needs no special case: a reconnect is recorded as activity, the fold takes
 *   the max, and the horizon moves out on its own.
 *
 * The bound that rescues the detached case is `maxLifetimeSeconds`. The platform
 * destroys the box at `createdAt + maxLifetimeSeconds` no matter what anyone
 * observed, so a product that asks for one holds a hard bound that survives
 * every blind spot above. Both shipped products ask for 86 400 s, which is why
 * the incident — 124 to 268 hours settled against boxes with a 24-hour
 * lifetime — is detectable with no lifecycle bookkeeping at all.
 */
declare function computeExpectedCeiling(record: SpendBoxRecord, options: ComputeExpectedCeilingOptions): ExpectedCeiling;

/**
 * Parse the platform's settlement idempotency key.
 *
 * The platform mints it as `sandbox:<kind>:<resourceId>:<intervalStart>`
 * (`d1-usage-service.ts`), where `intervalStart` is the interval cursor in epoch
 * ms — the SAME `last_started_at` the settlement subtracts from to get its
 * billed duration. That makes this string the only place a consumer can read the
 * billed interval's start, because the ledger row itself stores no duration.
 *
 * Kinds seen in production: `stop` (an interval closing), `compute` (a heartbeat
 * claim), `egress`, `gpu-lease`. `stop` deliberately covers both a settle and a
 * late stop racing over the same claim, so the two derive one reference id and
 * the ledger's uniqueness constraint makes the overlap safe.
 *
 * Returns null for anything that is not a sandbox reference — a router
 * inference row, a grant, a refund — rather than guessing.
 */
declare function parseSettlementReference(referenceId: string | null | undefined): SettlementReference | null;
/**
 * Read the sandbox id out of the platform's aggregation key, `sandbox:<id>`.
 *
 * Distinct from the reference id: `groupKey` is the unit a billing statement
 * groups by and is deliberately NOT unique per row, while `referenceId` is
 * unique per interval. A null group key means "do not aggregate" (grants,
 * top-ups, refunds, transfers) and is not an error.
 */
declare function parseSandboxGroupKey(groupKey: string | null | undefined): string | null;
/**
 * The sandbox a settlement row is attributable to.
 *
 * The reference id wins over the group key because it is the field the platform
 * dedups on, so it is the one guaranteed present and correct on a compute
 * settlement; the group key is the fallback for rows written before a producer
 * stamped a reference, and for kinds whose reference names something else (a GPU
 * lease id, not a box).
 */
declare function settlementSandboxId(row: SettlementRow): string | null;
/** True when a row is a charge (the ledger stores charges as negative amounts). */
declare function isCharge(row: SettlementRow): boolean;
/** A charge's magnitude in unsigned nanodollars; 0 for credits. */
declare function chargeNanoUsd(row: SettlementRow): number;

interface VelocityOptions {
    /** Bucket width for a spend window, ms. Default 24 h. */
    readonly windowMs?: number;
    /** Fire when a window exceeds this multiple of the trailing median. Default 5. */
    readonly multiple?: number;
    /**
     * Windows of history required before a median means anything. Default 3.
     * Below this the rule stays silent, so a product's genuine first days of
     * usage are not reported as an anomaly.
     */
    readonly minTrailingWindows?: number;
    /**
     * A window under this never fires, whatever the ratio. Default $1.00.
     *
     * Without a floor the rule is useless: a trailing median of a tenth of a cent
     * makes every ordinary day a 5x outlier. $1.00 is set from the incident's own
     * distribution — the smallest of the eight affected wallets took $1.98, and
     * the two rows in the same window that were GENUINE were sub-cent. So the
     * floor sits above the noise and below every real finding.
     */
    readonly minAbsoluteNanoUsd?: number;
}
/** The balance the product observes, and the floor it must not cross. */
interface ObservedBalance {
    /** Signed nanodollars, as the platform reports it. */
    readonly nanoUsd: number;
    /** Below this is a finding. Default 0. */
    readonly floorNanoUsd?: number;
}
/**
 * A box's price, nanodollars per hour, used to derive an EXACT billed duration
 * from a charge. Return null when the product does not know the box's rate; the
 * reconciler then falls back to the reference span.
 */
type BoxRateResolver = (record: SpendBoxRecord | null, sandboxId: string) => number | null | undefined;
interface ReconcileSpendOptions {
    /**
     * Settled ledger rows, supplied by the product's own authenticated fetch.
     *
     * The fetch can only scope to a WALLET — `product: 'sandbox'` is the
     * platform's service taxonomy, not this product's — so on an account running
     * more than one of our products these rows carry the siblings' boxes too.
     * {@link ReconcileSpendOptions.ownership} is what separates them.
     */
    readonly rows: readonly SettlementRow[];
    /** The product's expectation ledger. */
    readonly store: SpendLedgerStorePort;
    /**
     * Which of those rows are THIS product's — see {@link SpendOwnershipRule} and
     * the shipped `ownedByBillingKeys`.
     *
     * Omitting it is safe and changes nothing: the pass claims every box, which is
     * the behaviour that shipped, and the direction that over-reports rather than
     * under-reports. It is not silent about it — `report.ownership.declared` is
     * `false`, `formatSpendReport` says so above the findings, and every
     * `unknown-box` finding states on its face that a sibling product's box is
     * indistinguishable from a charge that is not ours.
     *
     * Declaring it never weakens the ledger-backed checks: ownership is consulted
     * ONLY for boxes with no expectation record, so `over-ceiling` on a recorded
     * box fires whatever the rule says.
     */
    readonly ownership?: SpendOwnershipRule;
    /** Treated as "now". Default `Date.now()`. */
    readonly asOf?: number;
    /** Ceiling slack. Default {@link DEFAULT_CEILING_TOLERANCE_MS}. */
    readonly toleranceMs?: number;
    /** Box price, for the exact duration basis. A number applies to every box. */
    readonly nanoUsdPerHour?: number | BoxRateResolver;
    /** Velocity tuning, or `false` to skip the rule. */
    readonly velocity?: VelocityOptions | false;
    /** The workspace balance, when the product can see one. Omitted skips the rule. */
    readonly balance?: ObservedBalance;
    /** Stamped onto findings so an alert names the tenant. */
    readonly workspaceId?: string;
    /** Checks to leave out of this pass. */
    readonly skip?: readonly SpendCheckId[];
    /**
     * The stretch of time these `rows` were fetched for.
     *
     * Declaring it — together with a store that implements `listLiveBetween` — is
     * what lets the pass answer the direction every settlement-driven rule is
     * blind to: *were we NOT billed for something we DID ask for*. The expectation
     * ledger already holds the answer; nothing new is stored for it.
     *
     * Omitting it is additive and changes no existing finding. It is not silent:
     * `report.expectation.declared` is `false`, `formatSpendReport` prints
     * `expectation: NOT DECLARED` above the findings, and a pass that also
     * examined none of this product's settlements reports `coverage: 'unverified'`
     * and cannot render as a clean bill.
     */
    readonly window?: SpendWindow;
    /**
     * Live ms a box needs inside the window before a settlement is EXPECTED of it.
     * Default {@link DEFAULT_EXPECTATION_GRACE_MS} (15 min — the platform's own
     * declared-normal settlement lag). Shrink it for a short window.
     */
    readonly expectationGraceMs?: number;
}
/**
 * Diff what the platform charged against what the product believes it asked for.
 *
 * Never disputes anything and never writes: the output is a report a human acts
 * on. The platform's ledger stays authoritative — this only ever produces the
 * evidence for a conversation with it.
 */
declare function reconcileSpend(options: ReconcileSpendOptions): Promise<SpendReport>;

/** Why provisioning was refused, with every number the decision used. */
interface ComputeBudgetRefusal {
    readonly workspaceId: string;
    /** The cap, unsigned nanodollars. */
    readonly limitNanoUsd: number;
    /** Cumulative settled compute spend for this workspace, unsigned nanodollars. */
    readonly settledNanoUsd: number;
    /** How far past the cap it already is. */
    readonly overageNanoUsd: number;
    readonly at: number;
}
/**
 * Provisioning refused because the workspace is already past its compute cap.
 *
 * Correctable by design: every number the decision used is on the error, so a
 * product can render "this workspace has spent $X of its $Y compute budget" and
 * an operator can raise the cap or investigate without reading logs.
 *
 * This is the failure mode the module exists to produce. A platform billing
 * defect that used to end in a silent negative balance now ends in provisioning
 * stopping and something loud happening instead.
 */
declare class ComputeBudgetExceededError extends Error {
    readonly workspaceId: string;
    readonly limitNanoUsd: number;
    readonly settledNanoUsd: number;
    readonly overageNanoUsd: number;
    constructor(refusal: ComputeBudgetRefusal);
}
/**
 * A per-workspace cap on sandbox compute.
 *
 * `/billing`'s budget primitive caps MODEL keys, and it works because the
 * platform enforces the cap at the key it minted. Sandbox compute has no such
 * key: a box bills the shared company wallet, so nothing upstream refuses. This
 * carries the same shape to the one place a consumer can still act — the moment
 * before it asks for another box.
 *
 * `settledNanoUsd` is a callback rather than a number because the authority is
 * the platform ledger, not this package: the product reads the same rows it
 * hands the reconciler. Cache it if the read is expensive; a cap is a
 * coarse-grained control and a slightly stale total still refuses.
 */
interface ComputeBudget {
    /** The cap, unsigned nanodollars. */
    readonly limitNanoUsd: number;
    /** Cumulative settled compute spend for the workspace, unsigned nanodollars. */
    readonly settledNanoUsd: (workspaceId: string) => Promise<number> | number;
    /**
     * Called on every refusal, before the error is thrown. This is the alert
     * seam: a refusal nobody hears is a product that silently stopped working.
     */
    readonly onRefusal?: (refusal: ComputeBudgetRefusal) => void;
    /** Injectable clock (epoch ms). Default `Date.now`. */
    readonly now?: () => number;
}
/**
 * Throw {@link ComputeBudgetExceededError} when the workspace is already past
 * its cap. Returns normally — and reads nothing — when no budget is configured.
 *
 * Deliberately a pre-check against spend ALREADY SETTLED, not a reservation
 * against spend about to happen: settlement lags provisioning by design (the
 * platform's durable settlement queue), so there is no instant at which a
 * consumer could hold an accurate running total. The cap therefore overshoots by
 * at most the unsettled tail, which is bounded by the box's own idle timeout.
 * A cap that refuses one box late is worth far more than one that cannot be
 * implemented honestly.
 */
declare function assertComputeBudget(budget: ComputeBudget | undefined, workspaceId: string): Promise<void>;
/**
 * What `/sandbox` reports once a box is provisioned, reused or resumed.
 *
 * Structurally identical to `SandboxProvisionedObservation` in `/sandbox`, and
 * deliberately re-declared rather than imported: `/spend` composes `/sandbox`,
 * so a type import in the other direction would invert the dependency. The two
 * are pinned together by a compile-time assignment in this module's tests.
 */
interface SpendProvisionObservation {
    readonly workspaceId: string;
    readonly userId?: string;
    readonly sandboxId: string;
    readonly boxKey?: string | undefined;
    readonly idleTimeoutSeconds: number;
    readonly maxLifetimeSeconds?: number | undefined;
    readonly at: number;
}
/**
 * The optional seam `EnsureWorkspaceSandboxOptions.spend` and the turn
 * primitives' `spend` option both accept. One object, wired in both places.
 */
interface SandboxSpendSeam {
    beforeProvision?(input: {
        workspaceId: string;
        userId?: string;
    }): Promise<void> | void;
    onProvisioned?(observation: SpendProvisionObservation): Promise<void> | void;
    /** Synchronous by contract — it sits on the turn path. See `createSandboxSpendHooks`. */
    onActivity?(input: {
        sandboxId: string;
        at: number;
    }): void;
}
interface SandboxSpendHooksOptions {
    /** Records box lifecycle. Omit to run the budget guard alone. */
    readonly ledger?: SpendLedger;
    /** Refuses provisioning past a cap. Omit to record alone. */
    readonly budget?: ComputeBudget;
    /**
     * Called when RECORDING fails. Recording is best-effort — a bookkeeping
     * failure must never take down the provisioning it is bookkeeping — so this
     * is the only place such a failure is visible. A refusal is NOT routed here;
     * refusals throw, by design.
     */
    readonly onError?: (error: unknown) => void;
}
/**
 * Build the object to hand `ensureWorkspaceSandbox`'s `spend` option.
 *
 * Wiring it is the entire adoption cost: one field, and the product's boxes are
 * both budget-capped and recorded.
 */
declare function createSandboxSpendHooks(options: SandboxSpendHooksOptions): SandboxSpendSeam;

/**
 * Render a reconciliation for a human deciding whether to open a dispute.
 *
 * Every finding prints its numbers, not a summary of them: the reader's next
 * action is a conversation with the platform about specific reference ids, and a
 * report that made them re-derive the durations would just be re-read alongside
 * the raw rows anyway.
 */
declare function formatSpendReport(report: SpendReport): string;
/** The report as a plain JSON value, for an alerting pipeline. */
declare function spendReportToJson(report: SpendReport): string;

export { type AllExcludedAssessment, type AllExcludedBasis, type BilledDurationBasis, type BoxLivenessOptions, type BoxRateResolver, type CeilingBasis, type ComputeBudget, ComputeBudgetExceededError, type ComputeBudgetRefusal, type ComputeExpectedCeilingOptions, DEFAULT_CEILING_TOLERANCE_MS, DEFAULT_EXPECTATION_GRACE_MS, type ExpectedCeiling, type InMemorySpendLedgerStore, type ObserveSandboxInput, type ObservedBalance, type ReconcileSpendOptions, SPEND_CHECKS, type SandboxSpendHooksOptions, type SandboxSpendSeam, type SettlementReference, type SettlementRow, type SpendBoxLiveness, type SpendBoxPatch, type SpendBoxRecord, type SpendCheckId, type SpendCoverage, type SpendExpectationSummary, type SpendFinding, type SpendLedger, type SpendLedgerOptions, type SpendLedgerStorePort, type SpendOwnershipCandidate, type SpendOwnershipRule, type SpendOwnershipSummary, type SpendOwnershipVerdict, type SpendProvisionObservation, type SpendReport, type SpendWindow, type VelocityOptions, assertComputeBudget, assertSpendWindow, assessAllExcluded, boxLivenessInWindow, chargeNanoUsd, computeExpectedCeiling, createInMemorySpendLedgerStore, createSandboxSpendHooks, createSpendLedger, decideBoxOwnership, foldSpendBoxRecord, formatSpendReport, isCharge, ownedByBillingKeys, parseSandboxGroupKey, parseSettlementReference, reconcileSpend, settlementSandboxId, spendReportToJson, undeclaredExpectation };
