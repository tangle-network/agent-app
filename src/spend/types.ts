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

// ── the product's own view of a box's life ────────────────────────────────────

/**
 * One box, as the PRODUCT understands it. Folded, not an append-only log: a
 * product runs one row per sandbox, and every field below is derived by a
 * monotonic fold (see `foldSpendBoxRecord`) so two concurrent writers cannot
 * produce a wrong answer, only a stale one.
 *
 * Timestamps are epoch ms throughout, matching the platform's own
 * `sandbox_meta.last_started_at`.
 */
export interface SpendBoxRecord {
  /** The platform's sandbox id — the join key to every settlement row. */
  readonly sandboxId: string
  /** The product's own tenancy unit, which the platform does not model. */
  readonly workspaceId: string
  /** First moment the product knew this box existed. */
  readonly createdAt: number
  /**
   * The idle timeout the product ASKED the platform for, seconds. This is the
   * width of the grace window between the last thing the product saw and the
   * moment the platform should have stopped billing.
   */
  readonly idleTimeoutSeconds: number
  /**
   * The maximum lifetime the product asked for, seconds, when it asked for one.
   * This is the strongest bound a product holds: the platform destroys the box
   * at `createdAt + maxLifetimeSeconds` regardless of what the product observed,
   * so it caps the ceiling even when nothing else can (see `computeExpectedCeiling`).
   */
  readonly maxLifetimeSeconds: number | null
  /** Latest moment the product OBSERVED the box doing work. */
  readonly lastActivityAt: number
  /**
   * Detached runs dispatched but never observed to finish, by run id.
   *
   * Non-empty means the product genuinely cannot bound this box from its own
   * observations: it handed the platform work and disconnected. The ceiling
   * degrades accordingly rather than pretending to a tightness it did not earn.
   */
  readonly openDetachedRunIds: readonly string[]
  /** When the product knows the box stopped. Cleared by later activity. */
  readonly stoppedAt: number | null
  /** When the product knows the box was deleted. Set once — a deleted id never returns. */
  readonly deletedAt: number | null
  /** Opaque product-column values, written verbatim and never read here. */
  readonly extras?: Record<string, unknown>
}

/**
 * A fold step. Every field states its own merge rule, so a SQL implementation
 * can apply it in one statement and reach the same record an in-memory
 * read-modify-write reaches.
 */
export interface SpendBoxPatch {
  /** Advance `lastActivityAt` to the max of stored and this. Never moves backward. */
  readonly observedActivityAt?: number
  /** Add a run id to `openDetachedRunIds` (set semantics — re-adding is a no-op). */
  readonly openDetachedRunAdd?: string
  /** Remove a run id from `openDetachedRunIds`. Removing an absent id is a no-op. */
  readonly openDetachedRunRemove?: string
  /**
   * Latest-wins. Activity observed AFTER a recorded stop clears it: a box that
   * worked after we thought it stopped is running again, and a stale stop would
   * make the ceiling too tight.
   */
  readonly stoppedAt?: number
  /** Set-once. A later delete observation does not move the first one. */
  readonly deletedAt?: number
}

// ── what bounds a box's billable time ─────────────────────────────────────────

/** Which fact bounds a box's billable time, weakest last. */
export type CeilingBasis =
  /** The product observed deletion. Billing cannot run past a box that is gone. */
  | 'deleted'
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
  | 'open-detached-run'

/** The upper bound on one box's billable duration, and what earned it. */
export interface ExpectedCeiling {
  readonly sandboxId: string
  readonly basis: CeilingBasis
  /** The latest instant this box could still have been billable, epoch ms. */
  readonly horizonAt: number
  /** `horizonAt - createdAt + toleranceMs`. The upper bound on billable ms. */
  readonly ceilingMs: number
  readonly toleranceMs: number
  /**
   * False when the basis is `open-detached-run` — the ceiling then rests on the
   * reconciliation instant rather than on anything the product observed, so an
   * overage means the platform billed outside the box's own lifetime, not merely
   * longer than expected.
   */
  readonly bounded: boolean
}

// ── what the platform actually emitted ────────────────────────────────────────

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
export interface SettlementRow {
  /** The ledger row id, for the dispute. */
  readonly id: string
  /**
   * `sandbox:<kind>:<sandboxId>:<intervalStartMs>` — the platform's idempotency
   * key, and the only place the billed interval's START is recorded.
   */
  readonly referenceId: string | null
  /**
   * Signed nanodollars, exactly as the ledger stores it: negative is a charge,
   * positive is a credit or refund.
   */
  readonly amountNanoUsd: number
  /** `compute` | `refund` | `inference` | … */
  readonly type: string
  /** `sandbox` | `router` | … */
  readonly product: string | null
  /** `sandbox:<sandboxId>` — the platform's aggregation unit. */
  readonly groupKey: string | null
  /** Settlement instant, epoch ms. The product normalizes the stored text. */
  readonly createdAt: number
  readonly description: string | null
  /** Provider at-cost basis, unsigned nanodollars. Null when unattributed. */
  readonly costBasisNanoUsd: number | null
  /**
   * The billed duration, when the product's ledger view exposes it directly.
   * Null is the common case: the platform does not store duration on the row.
   */
  readonly billedMs: number | null
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
  readonly keyId?: string | null
}

// ── whose box is this? ────────────────────────────────────────────────────────

/**
 * What one settlement is attributable to, from inside ONE product.
 *
 * The distinction this type exists for: a sibling product's box and a charge
 * that is not ours at all look identical from inside a single product, because
 * both arrive as a settlement naming a sandbox this product's expectation ledger
 * has never heard of. Dropping both loses the check's whole purpose; reporting
 * both makes it noise. Only a platform-stamped attribution field separates them.
 */
export type SpendOwnershipVerdict =
  /** Attributable to THIS product. An unrecorded one is a phantom-charge candidate. */
  | 'mine'
  /** Attributable to a DIFFERENT product on the same wallet. Reported, never a finding. */
  | 'foreign'
  /**
   * The row carries nothing that decides it. Counted as `mine` — FAIL CLOSED.
   * An unattributable charge on a shared wallet is precisely the shape of the
   * thing this module exists to catch, so the ambiguous case costs a human five
   * minutes rather than costing the product the detection.
   */
  | 'undecidable'

/** One settlement, presented to an ownership rule. */
export interface SpendOwnershipCandidate {
  readonly row: SettlementRow
  /** The sandbox the row is attributable to, or null for a row naming none. */
  readonly sandboxId: string | null
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
export interface SpendOwnershipRule {
  /** Named in the report and on every finding, so a reader knows what was excluded. */
  readonly label: string
  decide(candidate: SpendOwnershipCandidate): SpendOwnershipVerdict
}

/**
 * What this pass scoped itself to — present on every report, including a clean
 * one, because "nothing fired" and "nothing was looked at" are different
 * answers and a report that cannot tell them apart is the failure this closes.
 */
export interface SpendOwnershipSummary {
  /**
   * False when the caller declared no rule. The pass then treats every box as
   * its own — today's behaviour, which over-reports rather than under-reports —
   * and every `unknown-box` finding says on its face that a sibling product's
   * box is indistinguishable from a charge that is not ours.
   */
  readonly declared: boolean
  /** The rule's label, or null when none was declared. */
  readonly label: string | null
  /** Boxes this pass treated as this product's, and what they were charged. */
  readonly ownedBoxes: number
  readonly ownedNanoUsd: number
  /**
   * Of those, the boxes no rule could decide. Counted as owned (fail-closed) and
   * reported separately so a product can see how much of its own verdict rests
   * on rows that carried no attribution.
   */
  readonly undecidableBoxes: number
  /** Boxes attributed to another product on the same wallet. Never findings. */
  readonly foreignBoxes: number
  readonly foreignNanoUsd: number
  /**
   * Their ids, in full — an exclusion a reader cannot audit is an exclusion
   * they have to trust, and this module's whole posture is that nothing about
   * money is taken on trust.
   */
  readonly foreignSandboxIds: readonly string[]
}

/** The parts of a settlement reference id, once parsed. */
export interface SettlementReference {
  /** `stop` | `compute` | `egress` | `gpu-lease` | anything the platform adds. */
  readonly kind: string
  /** For compute kinds, the sandbox id. For `gpu-lease`, the lease id. */
  readonly resourceId: string
  /** The interval's start, epoch ms. Null for kinds that carry no interval. */
  readonly intervalStartMs: number | null
}

/** How a settled duration was arrived at — every duration finding carries one. */
export type BilledDurationBasis =
  /** The ledger row carried the duration. Exact. */
  | 'reported'
  /** `amount ÷ the product's stated hourly rate`. Exact when the rate is right. */
  | 'rate'
  /**
   * `settledAt - intervalStart`. An UPPER bound, not the billed duration: a
   * correct settlement posted late by the platform's durable settlement queue
   * reads longer here than it billed. Findings on this basis say so.
   */
  | 'reference-span'
  /** No basis available — duration rules are skipped for this row. */
  | 'unknown'

// ── findings ──────────────────────────────────────────────────────────────────

/** The checks this reconciler runs. Each is individually skippable, by name. */
export type SpendCheckId =
  /** A settlement against a box the product has no record of ever asking for. */
  | 'unknown-box'
  /** A settled duration longer than the product's own upper bound allows. */
  | 'over-ceiling'
  /** A spend window far above the trailing median — the burst shape of a defect. */
  | 'velocity'
  /** The balance the product observes has gone below its floor. */
  | 'negative-balance'

export const SPEND_CHECKS: readonly SpendCheckId[] = [
  'unknown-box',
  'over-ceiling',
  'velocity',
  'negative-balance',
]

/**
 * One discrepancy, with every number the rule compared.
 *
 * Nullable fields are per-check and deliberately present-but-null rather than
 * absent: a reader scanning a JSON dump can tell "this rule does not measure
 * that" from "that measurement is missing".
 */
export interface SpendFinding {
  readonly check: SpendCheckId
  /** What is wrong, in one sentence, with the numbers in it. */
  readonly message: string
  /** What to do about it. A finding without a remedy is a complaint. */
  readonly remedy: string
  readonly sandboxId: string | null
  readonly workspaceId: string | null
  /** The ledger rows that evidence this finding — the dispute's exhibit list. */
  readonly referenceIds: readonly string[]
  /** Nanodollars this finding puts in question, unsigned. */
  readonly settledNanoUsd: number
  /** `over-ceiling` — the duration actually settled, and how that was derived. */
  readonly settledMs: number | null
  readonly durationBasis: BilledDurationBasis | null
  /** `over-ceiling` — the bound it broke, and what earned that bound. */
  readonly ceilingMs: number | null
  readonly overageMs: number | null
  readonly ceilingBasis: CeilingBasis | null
  /** `velocity` — the window, its trailing median, and the ratio between them. */
  readonly windowNanoUsd: number | null
  readonly trailingMedianNanoUsd: number | null
  readonly velocityRatio: number | null
  readonly windowStartAt: number | null
  /** `negative-balance` — the observed balance and the floor it broke. */
  readonly balanceNanoUsd: number | null
  readonly balanceFloorNanoUsd: number | null
}

/** What one reconciliation pass concluded. */
export interface SpendReport {
  /** True when nothing fired. `ok === findings.length === 0`. */
  readonly ok: boolean
  readonly findings: readonly SpendFinding[]
  readonly checksRun: readonly SpendCheckId[]
  /** Rows the pass read, including the ones no rule looked at. */
  readonly rowsExamined: number
  /** Distinct boxes those rows settled against. */
  readonly boxesExamined: number
  /** Total charged across every examined row, unsigned nanodollars. */
  readonly settledNanoUsd: number
  /** Total credited back across every examined row, unsigned nanodollars. */
  readonly creditedNanoUsd: number
  /** What this pass claimed as its own, and what it excluded as another product's. */
  readonly ownership: SpendOwnershipSummary
  /** The instant the pass treated as "now". */
  readonly asOf: number
}
