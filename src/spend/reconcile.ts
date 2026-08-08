import { DEFAULT_CEILING_TOLERANCE_MS, computeExpectedCeiling } from './ceiling'
import {
  DEFAULT_EXPECTATION_GRACE_MS,
  assertSpendWindow,
  boxLivenessInWindow,
  undeclaredExpectation,
} from './liveness'
import { decideBoxOwnership } from './ownership'
import { chargeNanoUsd, parseSettlementReference, settlementSandboxId } from './reference'
import type { SpendLedgerStorePort } from './store'
import {
  SPEND_CHECKS,
  type BilledDurationBasis,
  type CeilingBasis,
  type SettlementRow,
  type SpendBoxLiveness,
  type SpendBoxRecord,
  type SpendCheckId,
  type SpendCoverage,
  type SpendExpectationSummary,
  type SpendFinding,
  type SpendOwnershipRule,
  type SpendOwnershipSummary,
  type SpendOwnershipVerdict,
  type SpendReport,
  type SpendWindow,
} from './types'

/** How many nanodollars in one US dollar. The ledger's unit. */
const NANO_PER_USD = 1_000_000_000
const MS_PER_HOUR = 3_600_000

export interface VelocityOptions {
  /** Bucket width for a spend window, ms. Default 24 h. */
  readonly windowMs?: number
  /** Fire when a window exceeds this multiple of the trailing median. Default 5. */
  readonly multiple?: number
  /**
   * Windows of history required before a median means anything. Default 3.
   * Below this the rule stays silent, so a product's genuine first days of
   * usage are not reported as an anomaly.
   */
  readonly minTrailingWindows?: number
  /**
   * A window under this never fires, whatever the ratio. Default $1.00.
   *
   * Without a floor the rule is useless: a trailing median of a tenth of a cent
   * makes every ordinary day a 5x outlier. $1.00 is set from the incident's own
   * distribution — the smallest of the eight affected wallets took $1.98, and
   * the two rows in the same window that were GENUINE were sub-cent. So the
   * floor sits above the noise and below every real finding.
   */
  readonly minAbsoluteNanoUsd?: number
}

const DEFAULT_VELOCITY: Required<VelocityOptions> = {
  windowMs: 86_400_000,
  multiple: 5,
  minTrailingWindows: 3,
  minAbsoluteNanoUsd: NANO_PER_USD,
}

/** The balance the product observes, and the floor it must not cross. */
export interface ObservedBalance {
  /** Signed nanodollars, as the platform reports it. */
  readonly nanoUsd: number
  /** Below this is a finding. Default 0. */
  readonly floorNanoUsd?: number
}

/**
 * A box's price, nanodollars per hour, used to derive an EXACT billed duration
 * from a charge. Return null when the product does not know the box's rate; the
 * reconciler then falls back to the reference span.
 */
export type BoxRateResolver = (record: SpendBoxRecord | null, sandboxId: string) => number | null | undefined

export interface ReconcileSpendOptions {
  /**
   * Settled ledger rows, supplied by the product's own authenticated fetch.
   *
   * The fetch can only scope to a WALLET — `product: 'sandbox'` is the
   * platform's service taxonomy, not this product's — so on an account running
   * more than one of our products these rows carry the siblings' boxes too.
   * {@link ReconcileSpendOptions.ownership} is what separates them.
   */
  readonly rows: readonly SettlementRow[]
  /** The product's expectation ledger. */
  readonly store: SpendLedgerStorePort
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
  readonly ownership?: SpendOwnershipRule
  /** Treated as "now". Default `Date.now()`. */
  readonly asOf?: number
  /** Ceiling slack. Default {@link DEFAULT_CEILING_TOLERANCE_MS}. */
  readonly toleranceMs?: number
  /** Box price, for the exact duration basis. A number applies to every box. */
  readonly nanoUsdPerHour?: number | BoxRateResolver
  /** Velocity tuning, or `false` to skip the rule. */
  readonly velocity?: VelocityOptions | false
  /** The workspace balance, when the product can see one. Omitted skips the rule. */
  readonly balance?: ObservedBalance
  /** Stamped onto findings so an alert names the tenant. */
  readonly workspaceId?: string
  /** Checks to leave out of this pass. */
  readonly skip?: readonly SpendCheckId[]
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
  readonly window?: SpendWindow
  /**
   * Live ms a box needs inside the window before a settlement is EXPECTED of it.
   * Default {@link DEFAULT_EXPECTATION_GRACE_MS} (15 min — the platform's own
   * declared-normal settlement lag). Shrink it for a short window.
   */
  readonly expectationGraceMs?: number
}

function usd(nano: number): string {
  return `$${(nano / NANO_PER_USD).toFixed(2)}`
}

function hours(ms: number): string {
  return `${(ms / MS_PER_HOUR).toFixed(1)}h`
}

/** Trust order, least trustworthy first — a mixed aggregate reports the weakest. */
const BASIS_TRUST: readonly BilledDurationBasis[] = ['unknown', 'reference-span', 'rate', 'reported']

function weakestBasis(a: BilledDurationBasis, b: BilledDurationBasis): BilledDurationBasis {
  return BASIS_TRUST.indexOf(a) <= BASIS_TRUST.indexOf(b) ? a : b
}

/**
 * How long one settlement billed for, and how confidently we know it.
 *
 * The ledger row does not store a duration — this is the whole reason the check
 * is subtle. Three ways to recover it, best first:
 *
 * 1. `reported` — the product's ledger view exposed it. Exact.
 * 2. `rate` — `charge / pricePerHour`. Exact, because the platform computes the
 *    charge as `(durationMs / 3_600_000) * costPerHour` and nothing else enters
 *    it. Requires the product to know its box's price.
 * 3. `reference-span` — `settledAt - intervalStart`, both read off the row. An
 *    UPPER bound, not the duration: a correct settlement delayed by the
 *    platform's durable settlement queue reads longer here than it billed. It is
 *    exact for the failure this module exists to catch, because billing "up to
 *    now" makes the settlement instant and the interval end the same moment.
 */
function resolveBilledMs(
  row: SettlementRow,
  ratePerHourNano: number | null,
): { ms: number; basis: BilledDurationBasis } {
  if (row.billedMs !== null) return { ms: row.billedMs, basis: 'reported' }

  const charge = chargeNanoUsd(row)
  if (ratePerHourNano !== null && ratePerHourNano > 0 && charge > 0) {
    return { ms: (charge / ratePerHourNano) * MS_PER_HOUR, basis: 'rate' }
  }

  const reference = parseSettlementReference(row.referenceId)
  if (reference?.intervalStartMs != null && row.createdAt > reference.intervalStartMs) {
    return { ms: row.createdAt - reference.intervalStartMs, basis: 'reference-span' }
  }

  return { ms: 0, basis: 'unknown' }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/**
 * What an `unknown-box` finding can honestly claim about WHOSE box it is.
 *
 * Three different statements, because the reader's next action differs: chase a
 * charge inside our own billing identity, chase a charge nothing attributes,
 * or first go and declare an ownership rule so the question can be answered at
 * all. A single message covering all three would be the vaguest of the three.
 */
function unknownBoxAttribution(
  ownership: SpendOwnershipRule | null,
  verdict: SpendOwnershipVerdict,
): string {
  if (!ownership) {
    return (
      ' No ownership rule was declared for this pass, so a sibling product\'s box on the same ' +
      'wallet reads exactly like a charge that is not ours — this finding could be either.'
    )
  }
  if (verdict === 'undecidable') {
    return (
      ` The ownership rule (${ownership.label}) could not decide it: the settlement carries no ` +
      'billing-key attribution to exclude it by, so it is reported rather than dropped.'
    )
  }
  return ` The ownership rule (${ownership.label}) attributes it to THIS product.`
}

function unknownBoxRemedy(
  ownership: SpendOwnershipRule | null,
  verdict: SpendOwnershipVerdict,
  sandboxId: string,
): string {
  const lookup = `Look up ${sandboxId} on the platform before disputing.`
  if (!ownership) {
    return (
      'Declare `ownership` (see `ownedByBillingKeys`) so a sibling product\'s box stops reading as ' +
      'a discrepancy — without it this check cannot tell one from a charge that is not ours. ' +
      'Until then, treat this as one of three things: a sibling product on the same wallet, a box ' +
      `provisioned outside the recorded seam, or a box that is not ours at all. ${lookup}`
    )
  }
  if (verdict === 'undecidable') {
    return (
      'An unattributable charge on a shared wallet is exactly what a phantom charge looks like, so ' +
      'it is reported by design rather than excluded. Confirm the row genuinely predates key ' +
      `attribution before dismissing it. ${lookup}`
    )
  }
  return (
    'This box is inside this product\'s own billing attribution and the product never recorded it, ' +
    'so it is either a provision that bypassed the recorded seam or a charge that is not ours. ' +
    `${lookup}`
  )
}

function emptyFinding(check: SpendCheckId): Omit<SpendFinding, 'message' | 'remedy'> {
  return {
    check,
    sandboxId: null,
    workspaceId: null,
    referenceIds: [],
    settledNanoUsd: 0,
    settledMs: null,
    durationBasis: null,
    ceilingMs: null,
    overageMs: null,
    ceilingBasis: null,
    windowNanoUsd: null,
    trailingMedianNanoUsd: null,
    velocityRatio: null,
    windowStartAt: null,
    windowEndAt: null,
    balanceNanoUsd: null,
    balanceFloorNanoUsd: null,
    expectedBoxes: null,
    settledBoxes: null,
    liveMsInWindow: null,
  }
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

/**
 * The `silent-ledger` findings — the only ones whose subject is the CHECK.
 *
 * Three distinct shapes, because the reader's next action differs in each:
 *
 * - **the whole expectation is silent** — every box this product had live in the
 *   window settled nothing. One aggregate finding, because there is one cause
 *   and N per-box findings would spread it across N pages.
 * - **one box is silent** while its siblings settled normally. Per-box, because
 *   the cause is specific to that box and the rest of the pass is working.
 * - **the pass examined nobody and expected nothing** — no window declared, no
 *   settlement claimed. It cannot tell an idle window from a check that stopped
 *   checking, and says so instead of answering optimistically.
 */
function silentLedgerFindings(input: {
  readonly expectation: SpendExpectationSummary
  readonly unsettled: readonly SpendBoxLiveness[]
  readonly coverage: SpendCoverage
  readonly ownership: SpendOwnershipRule | null
  readonly workspaceId: string | null
  readonly rowsExamined: number
  readonly boxesExamined: number
  readonly ownedBoxes: number
  readonly foreignBoxes: number
}): SpendFinding[] {
  const { expectation, unsettled, ownership, workspaceId } = input
  const scope = ownership ? `the ownership rule (${ownership.label})` : 'no ownership rule (none declared)'

  if (input.coverage === 'unverified') {
    return [
      {
        ...emptyFinding('silent-ledger'),
        workspaceId,
        expectedBoxes: 0,
        settledBoxes: 0,
        message:
          `This pass examined none of this product's settlements — ${input.rowsExamined} row(s) read, ` +
          `${input.boxesExamined} box(es), ${input.foreignBoxes} excluded by ${scope}, 0 claimed as ` +
          'this product\'s — and no expectation was declared, so it cannot tell a genuinely idle ' +
          'window from a check that stopped checking. A clean bill is not one of the answers ' +
          'available here.',
        remedy:
          'Declare `window` and implement `listLiveBetween` on the expectation store, so this pass ' +
          'can state what it EXPECTED to be billed for and an empty result becomes an answer ' +
          'instead of a silence. Until then, verify the ledger fetch by hand for this window ' +
          'before treating the account as checked.',
      },
    ]
  }

  if (unsettled.length === 0) return []
  const window = expectation.window
  const span = window ? ` in the window ${iso(window.startAt)} → ${iso(window.endAt)}` : ''

  // Every expected box silent: one cause, one finding.
  if (unsettled.length === expectation.expectedBoxes) {
    return [
      {
        ...emptyFinding('silent-ledger'),
        workspaceId,
        expectedBoxes: expectation.expectedBoxes,
        settledBoxes: 0,
        ...(window ? { windowStartAt: window.startAt, windowEndAt: window.endAt } : {}),
        message:
          `Nothing settled against ANY of the ${expectation.expectedBoxes} box(es) this product had ` +
          `live${span}, out of ${expectation.liveBoxes} that overlapped it. ` +
          `${input.rowsExamined} row(s) were read and ${input.foreignBoxes} box(es) excluded by ${scope}. ` +
          'A window in which this product ran boxes and was billed for none of them is far more ' +
          'likely to be a broken check than a free week — an empty or mis-scoped ledger fetch, a ' +
          'rotated key the ownership rule does not name, or a feed that quietly stopped returning ' +
          'rows all produce exactly this shape. Treat this report as unverified, not as clean.',
        remedy:
          'Check the fetch before the bill: re-run the transactions query for this exact window by ' +
          'hand and compare the row count with `rowsExamined` above. If the rows are there, the ' +
          'ownership rule is excluding them — compare its key ids against the key the boxes were ' +
          `created under. Boxes expected: ${expectation.unsettledSandboxIds.join(', ')}.`,
      },
    ]
  }

  // A subset: the pass is working, these boxes are the anomaly.
  return unsettled.map((box) => ({
    ...emptyFinding('silent-ledger'),
    sandboxId: box.sandboxId,
    workspaceId: box.workspaceId || workspaceId,
    expectedBoxes: expectation.expectedBoxes,
    settledBoxes: expectation.settledBoxes,
    liveMsInWindow: box.liveMsInWindow,
    ...(window ? { windowStartAt: window.startAt, windowEndAt: window.endAt } : {}),
    message:
      `Sandbox ${box.sandboxId} was live for ${hours(box.liveMsInWindow)}${span} and nothing settled ` +
      `against it, while ${expectation.settledBoxes} of this product's other expected box(es) settled ` +
      `normally. Its life ended on basis ${box.basis} at ${iso(box.liveUntil)}.`,
    remedy:
      'One silent box beside working siblings is not a discount. Check, in order: whether its ' +
      'settlement is merely late (the platform treats up to 900 s of compute-settlement lag as ' +
      'normal, and `expectationGraceMs` is the dial for it); whether this box was created under a ' +
      'key the ownership rule does not claim, so its charges are landing on another product\'s ' +
      `report; and whether the expectation ledger's own record for ${box.sandboxId} is stale.`,
  }))
}

/**
 * Diff what the platform charged against what the product believes it asked for.
 *
 * Never disputes anything and never writes: the output is a report a human acts
 * on. The platform's ledger stays authoritative — this only ever produces the
 * evidence for a conversation with it.
 */
export async function reconcileSpend(options: ReconcileSpendOptions): Promise<SpendReport> {
  const asOf = options.asOf ?? Date.now()
  const toleranceMs = options.toleranceMs ?? DEFAULT_CEILING_TOLERANCE_MS
  const workspaceId = options.workspaceId ?? null
  const skip = new Set(options.skip ?? [])
  const checksRun = SPEND_CHECKS.filter((check) => !skip.has(check))
  const runs = (check: SpendCheckId): boolean => !skip.has(check)

  const ownership = options.ownership ?? null
  const graceMs = options.expectationGraceMs ?? DEFAULT_EXPECTATION_GRACE_MS
  // A malformed window would expect nothing and certify an unchecked account,
  // which is the failure this whole addition exists to close — so it throws
  // rather than degrading to a pass that examines nobody.
  if (options.window) assertSpendWindow(options.window)

  const findings: SpendFinding[] = []
  let settledNanoUsd = 0
  let creditedNanoUsd = 0
  let ownedBoxes = 0
  let ownedNanoUsd = 0
  let undecidableBoxes = 0
  let foreignNanoUsd = 0
  const foreignSandboxIds: string[] = []
  /** Boxes this pass claimed — the join key the expectation check settles against. */
  const ownedSandboxIds = new Set<string>()

  // ── group charges by the box they are attributable to ──────────────────────
  const byBox = new Map<string, SettlementRow[]>()
  for (const row of options.rows) {
    if (row.amountNanoUsd < 0) settledNanoUsd += -row.amountNanoUsd
    else creditedNanoUsd += row.amountNanoUsd
    if (row.amountNanoUsd >= 0) continue
    const sandboxId = settlementSandboxId(row)
    if (!sandboxId) continue
    const bucket = byBox.get(sandboxId)
    if (bucket) bucket.push(row)
    else byBox.set(sandboxId, [row])
  }

  const rateOf = (record: SpendBoxRecord | null, sandboxId: string): number | null => {
    const rate = options.nanoUsdPerHour
    if (rate === undefined) return null
    if (typeof rate === 'number') return rate
    return rate(record, sandboxId) ?? null
  }

  for (const [sandboxId, rows] of byBox) {
    const record = await options.store.load(sandboxId)
    const referenceIds = rows.map((row) => row.referenceId ?? row.id)
    const charged = rows.reduce((sum, row) => sum + chargeNanoUsd(row), 0)

    // A box the product RECORDED is this product's by construction, and no
    // ownership rule may un-own it. That is what stops a wrong or over-narrow
    // rule from hiding an over-ceiling finding: the ledger decides recorded-ness,
    // the rule decides attribution, and the rule only ever gets a say about the
    // residue neither of them has claimed.
    const verdict: SpendOwnershipVerdict = record
      ? 'mine'
      : ownership
        ? decideBoxOwnership(ownership, sandboxId, rows)
        : 'mine'

    if (verdict === 'foreign') {
      foreignSandboxIds.push(sandboxId)
      foreignNanoUsd += charged
      continue
    }
    ownedBoxes += 1
    ownedNanoUsd += charged
    ownedSandboxIds.add(sandboxId)
    if (verdict === 'undecidable') undecidableBoxes += 1

    // ── unknown-box ──────────────────────────────────────────────────────────
    if (!record) {
      if (runs('unknown-box')) {
        findings.push({
          ...emptyFinding('unknown-box'),
          sandboxId,
          workspaceId,
          referenceIds,
          settledNanoUsd: charged,
          message:
            `${usd(charged)} settled across ${rows.length} row(s) against sandbox ${sandboxId}, ` +
            'which this product has no record of ever asking for.' +
            unknownBoxAttribution(ownership, verdict),
          remedy: unknownBoxRemedy(ownership, verdict, sandboxId),
        })
      }
      continue
    }

    // ── over-ceiling ─────────────────────────────────────────────────────────
    if (!runs('over-ceiling')) continue

    const ceiling = computeExpectedCeiling(record, { asOf, toleranceMs })
    const ratePerHourNano = rateOf(record, sandboxId)

    let settledMs = 0
    let basis: BilledDurationBasis = 'reported'
    let anyMeasured = false
    for (const row of rows) {
      const resolved = resolveBilledMs(row, ratePerHourNano)
      if (resolved.basis === 'unknown') {
        basis = weakestBasis(basis, 'unknown')
        continue
      }
      anyMeasured = true
      settledMs += resolved.ms
      basis = weakestBasis(basis, resolved.basis)
    }
    if (!anyMeasured) continue
    if (settledMs <= ceiling.ceilingMs) continue

    const overageMs = settledMs - ceiling.ceilingMs
    const confidence = ceiling.bounded
      ? ''
      : ' The product could not bound this box from its own observations (an unfinished detached ' +
        'run, and no max lifetime), so the ceiling rests on the reconciliation instant: this ' +
        'settlement bills time outside the box\'s own life, not merely more than expected.'
    const spanCaveat =
      basis === 'reference-span'
        ? ' Duration is derived from the settlement instant minus the interval start, which ' +
          'overstates a settlement the platform merely posted late — confirm before disputing.'
        : ''

    findings.push({
      ...emptyFinding('over-ceiling'),
      sandboxId,
      workspaceId: record.workspaceId || workspaceId,
      referenceIds,
      settledNanoUsd: charged,
      settledMs,
      durationBasis: basis,
      ceilingMs: ceiling.ceilingMs,
      overageMs,
      ceilingBasis: ceiling.basis,
      message:
        `Sandbox ${sandboxId} settled ${hours(settledMs)} (${usd(charged)}) across ${rows.length} ` +
        `row(s), against an expected ceiling of ${hours(ceiling.ceilingMs)} — over by ` +
        `${hours(overageMs)}. Ceiling basis: ${ceiling.basis}; duration basis: ${basis}.` +
        confidence +
        spanCaveat,
      remedy:
        `Dispute ${referenceIds.join(', ')} against the platform ledger with both numbers. ` +
        (ceiling.basis === 'stopped' || ceiling.basis === 'deleted'
          ? 'The product recorded this box as no longer running before the billed time ended, so ' +
            'either the stop did not take or the interval was settled at the wrong boundary.'
          : 'Freeze the open interval before anything deletes this box — deleting a box with an ' +
            'open compute interval settles the whole gap at once.'),
    })
  }

  // ── velocity ───────────────────────────────────────────────────────────────
  if (runs('velocity') && options.velocity !== false) {
    const cfg = { ...DEFAULT_VELOCITY, ...(options.velocity ?? {}) }
    const buckets = new Map<number, { nano: number; references: string[] }>()
    for (const row of options.rows) {
      const charge = chargeNanoUsd(row)
      if (charge === 0) continue
      // Velocity is decided per ROW, not per box, because a row naming no
      // sandbox at all still counts toward what this product spent. A sibling's
      // burst is excluded rather than paged on: a product cannot dispute a
      // charge it did not incur, and leaving them in makes one product's
      // incident wake every product on the wallet.
      if (ownership && ownership.decide({ row, sandboxId: settlementSandboxId(row) }) === 'foreign') {
        continue
      }
      const bucketStart = Math.floor(row.createdAt / cfg.windowMs) * cfg.windowMs
      const bucket = buckets.get(bucketStart)
      if (bucket) {
        bucket.nano += charge
        bucket.references.push(row.referenceId ?? row.id)
      } else {
        buckets.set(bucketStart, { nano: charge, references: [row.referenceId ?? row.id] })
      }
    }

    const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < ordered.length; i++) {
      const entry = ordered[i]
      if (!entry) continue
      const [windowStartAt, bucket] = entry
      if (i < cfg.minTrailingWindows) continue
      const trailing = ordered.slice(0, i).map(([, prior]) => prior.nano)
      const trailingMedian = median(trailing)
      const threshold = Math.max(trailingMedian * cfg.multiple, cfg.minAbsoluteNanoUsd)
      if (bucket.nano <= threshold) continue
      const ratio = trailingMedian > 0 ? bucket.nano / trailingMedian : Number.POSITIVE_INFINITY

      findings.push({
        ...emptyFinding('velocity'),
        workspaceId,
        referenceIds: bucket.references,
        settledNanoUsd: bucket.nano,
        windowNanoUsd: bucket.nano,
        trailingMedianNanoUsd: trailingMedian,
        velocityRatio: ratio,
        windowStartAt,
        message:
          `${usd(bucket.nano)} settled in the window starting ${new Date(windowStartAt).toISOString()} ` +
          `across ${bucket.references.length} row(s), against a trailing median of ` +
          `${usd(trailingMedian)} over ${trailing.length} prior window(s) — ` +
          `${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : 'no prior spend to compare against'}, ` +
          `over the ${cfg.multiple}x threshold.` +
          (ownership
            ? ` Counted over this product's own rows only (${ownership.label}); the wallet total ` +
              'for the window is higher when a sibling product settled into it.'
            : ' Counted over every row on the wallet, which on a shared account includes any ' +
              'sibling product\'s spend.'),
        remedy:
          'A burst of this shape is what a settlement defect looks like from the consumer side: ' +
          'long-dormant intervals cashed out at once. Check whether these rows carry interval ' +
          'starts far older than the settlement instant before treating it as real usage.',
      })
    }
  }

  // ── negative-balance ───────────────────────────────────────────────────────
  if (runs('negative-balance') && options.balance) {
    const floor = options.balance.floorNanoUsd ?? 0
    if (options.balance.nanoUsd < floor) {
      findings.push({
        ...emptyFinding('negative-balance'),
        workspaceId,
        settledNanoUsd: Math.max(0, floor - options.balance.nanoUsd),
        balanceNanoUsd: options.balance.nanoUsd,
        balanceFloorNanoUsd: floor,
        message:
          `Observed balance ${usd(options.balance.nanoUsd)} is below the floor ${usd(floor)}.`,
        remedy:
          'Stop provisioning new compute for this owner until the balance is explained. A negative ' +
          'balance that nobody is watching is how a billing defect becomes settled money.',
      })
    }
  }

  const ownershipSummary: SpendOwnershipSummary = {
    declared: ownership !== null,
    label: ownership?.label ?? null,
    ownedBoxes,
    ownedNanoUsd,
    undecidableBoxes,
    foreignBoxes: foreignSandboxIds.length,
    foreignNanoUsd,
    foreignSandboxIds,
  }

  // ── silent-ledger: what did we EXPECT to be billed for? ────────────────────
  //
  // Every rule above is driven by a settlement row, so all of them go quiet
  // together when the rows stop arriving. This is the one that reads the other
  // direction — off the expectation ledger the pass already has — and it needs
  // both halves: a window the caller declares (deriving it from the rows would
  // be circular) and a store that can list its own boxes.
  const window = options.window ?? null
  const canList = typeof options.store.listLiveBetween === 'function'
  let expectation: SpendExpectationSummary = undeclaredExpectation(graceMs)
  let unsettled: SpendBoxLiveness[] = []

  if (window && canList) {
    const candidates = await options.store.listLiveBetween!(window)
    // The store may over-return; liveness is re-derived here so the definition
    // of "live" lives in one place rather than once per product's SQL.
    const live = candidates
      .map((record) => boxLivenessInWindow(record, window, { graceMs }))
      .filter((box) => box.overlaps)
    const expected = live.filter((box) => box.expectSettlement)
    unsettled = expected.filter((box) => !ownedSandboxIds.has(box.sandboxId))
    expectation = {
      declared: true,
      window,
      graceMs,
      liveBoxes: live.length,
      expectedBoxes: expected.length,
      settledBoxes: expected.length - unsettled.length,
      unsettledSandboxIds: unsettled.map((box) => box.sandboxId),
    }
  }

  // A pass that claimed one of its own settlements HAS examined something. Past
  // that, only a declared expectation can tell "nothing was billed because
  // nothing ran" from "nothing was billed because the check broke".
  const coverage: SpendCoverage =
    ownedBoxes > 0
      ? 'verified'
      : expectation.declared
        ? expectation.expectedBoxes > 0
          ? 'verified'
          : 'nothing-expected'
        : 'unverified'

  if (runs('silent-ledger')) {
    findings.push(
      ...silentLedgerFindings({
        expectation,
        unsettled,
        coverage,
        ownership,
        workspaceId,
        rowsExamined: options.rows.length,
        boxesExamined: byBox.size,
        ownedBoxes,
        foreignBoxes: foreignSandboxIds.length,
      }),
    )
  }

  return {
    // `coverage` is the second half of the gate deliberately: skipping the
    // `silent-ledger` check removes its findings, never the verdict, so no
    // combination of options can make an examined-nobody pass report clean.
    ok: findings.length === 0 && coverage !== 'unverified',
    coverage,
    findings,
    checksRun,
    rowsExamined: options.rows.length,
    boxesExamined: byBox.size,
    settledNanoUsd,
    creditedNanoUsd,
    ownership: ownershipSummary,
    expectation,
    asOf,
  }
}
