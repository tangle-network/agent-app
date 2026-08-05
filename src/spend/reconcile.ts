import { DEFAULT_CEILING_TOLERANCE_MS, computeExpectedCeiling } from './ceiling'
import { chargeNanoUsd, parseSettlementReference, settlementSandboxId } from './reference'
import type { SpendLedgerStorePort } from './store'
import {
  SPEND_CHECKS,
  type BilledDurationBasis,
  type CeilingBasis,
  type SettlementRow,
  type SpendBoxRecord,
  type SpendCheckId,
  type SpendFinding,
  type SpendReport,
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
   * MUST be scoped to boxes this product owns. Products bill to a shared company
   * key, so an unscoped fetch returns every sibling product's settlements and
   * every one is a correct — and useless — `unknown-box` finding.
   */
  readonly rows: readonly SettlementRow[]
  /** The product's expectation ledger. */
  readonly store: SpendLedgerStorePort
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
    balanceNanoUsd: null,
    balanceFloorNanoUsd: null,
  }
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

  const findings: SpendFinding[] = []
  let settledNanoUsd = 0
  let creditedNanoUsd = 0

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
            'which this product has no record of ever asking for.',
          remedy:
            'Either the fetch is not scoped to this product\'s own boxes (fix the scope — a shared ' +
            'billing key returns every sibling product\'s settlements), or a box was provisioned ' +
            'outside the recorded seam, or the platform billed a box that is not ours. Identify ' +
            `which by looking up ${sandboxId} on the platform before disputing.`,
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
          `over the ${cfg.multiple}x threshold.`,
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

  return {
    ok: findings.length === 0,
    findings,
    checksRun,
    rowsExamined: options.rows.length,
    boxesExamined: byBox.size,
    settledNanoUsd,
    creditedNanoUsd,
    asOf,
  }
}
