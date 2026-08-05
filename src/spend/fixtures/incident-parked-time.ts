/**
 * The 2026-08-05 parked-time settlement incident, as a fixture.
 *
 * A gate calibrated only against invented data proves nothing about the failure
 * it was built for, so this reconstructs the real one. What comes from the
 * receipts on agent-dev-container#4422 and its runbook, and what is
 * reconstructed, is marked per field below — because a fixture that quietly
 * blends the two is how a calibration stops meaning anything.
 *
 * MEASURED (from the incident receipts):
 *   - The reporter's refund totalled $514.161090533, one of eight wallets
 *     refunded for a combined $614.31.
 *   - 23 settlements, interval starts in July, durations 124–268 h, all settled
 *     inside one burst in the 02:40–04:00 UTC window on 2026-08-05.
 *   - Two sub-cent rows in the same window were GENUINE short intervals and
 *     were deliberately not refunded.
 *   - The ledger reference id is `sandbox:stop:<sandboxId>:<intervalStart>`
 *     with the interval start in epoch ms; amounts are signed nanodollars,
 *     negative for a charge; the group key is `sandbox:<sandboxId>`.
 *   - Both shipped products run `idleTimeoutSeconds: 3600` and
 *     `maxLifetimeSeconds: 86400`.
 *
 * RECONSTRUCTED (the per-row split is not published in the issue):
 *   - How the 23 durations distribute inside 124–268 h — spread linearly.
 *   - The implied price, derived so the 23 amounts sum to the refunded total to
 *     the nanodollar ($0.114055/h for the 2 vCPU / 4 GB box both products run).
 *   - The fourteen ordinary days of prior spend, which the receipts do not
 *     enumerate but which the velocity rule needs in order to have a trailing
 *     median at all.
 *
 * One published figure is NOT reproduced here: the brief's aggregate of ~10 718
 * billed hours cannot be reconciled with 23 rows of 124–268 h, whose arithmetic
 * maximum is 6 164 h. The per-row bounds are the more specific claim and are
 * what this uses; the aggregate may span more rows or more wallets than the
 * reporter's 23. Nothing in the calibration depends on it.
 */
import type { SettlementRow, SpendBoxRecord } from '../types'

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** The reporter's refund, to the nanodollar. */
export const REPORTER_REFUND_NANO_USD = 514_161_090_533

/** The burst: 23 settlements inside seven minutes. */
const BURST_START = Date.parse('2026-08-05T02:47:00.000Z')
const BURST_SPAN_MS = 7 * MINUTE_MS
const INCIDENT_ROWS = 23

/** Both shipped products ask for exactly these. */
const PRODUCT_IDLE_TIMEOUT_SECONDS = 3600
const PRODUCT_MAX_LIFETIME_SECONDS = 86_400

/** The reconciliation instant — shortly after the burst, as an operator would run it. */
const INCIDENT_AS_OF = Date.parse('2026-08-05T04:00:00.000Z')

function settlementRow(input: {
  sandboxId: string
  intervalStartMs: number
  settledAtMs: number
  chargeNanoUsd: number
}): SettlementRow {
  return {
    id: `tx_${input.sandboxId}_${input.intervalStartMs}`,
    referenceId: `sandbox:stop:${input.sandboxId}:${input.intervalStartMs}`,
    amountNanoUsd: -input.chargeNanoUsd,
    type: 'compute',
    product: 'sandbox',
    groupKey: `sandbox:${input.sandboxId}`,
    createdAt: input.settledAtMs,
    description: 'sandbox compute',
    costBasisNanoUsd: null,
    billedMs: null,
  }
}

/**
 * A box as the product WOULD have recorded it: resumed, worked briefly, then
 * left alone. Never stopped and never deleted — neither shipped product stops
 * or deletes a box, so this is the shape the expectation ledger really holds.
 */
function boxRecord(input: {
  sandboxId: string
  createdAt: number
  activityMs: number
}): SpendBoxRecord {
  return {
    sandboxId: input.sandboxId,
    workspaceId: 'ws_reporter',
    createdAt: input.createdAt,
    idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
    maxLifetimeSeconds: PRODUCT_MAX_LIFETIME_SECONDS,
    lastActivityAt: input.createdAt + input.activityMs,
    openDetachedRunIds: [],
    stoppedAt: null,
    deletedAt: null,
  }
}

export interface IncidentFixture {
  /** Every settled row an operator's fetch would return, oldest first. */
  readonly rows: readonly SettlementRow[]
  /** The expectation ledger a product that had adopted `/spend` would hold. */
  readonly records: readonly SpendBoxRecord[]
  /** The 23 over-billed boxes. */
  readonly incidentSandboxIds: readonly string[]
  /** The two boxes whose short intervals in the same window were genuine. */
  readonly genuineSandboxIds: readonly string[]
  readonly asOf: number
}

/**
 * Build the incident. Deterministic — no clock, no randomness — so the
 * calibration test asserts exact numbers rather than ranges.
 */
export function incidentFixture(): IncidentFixture {
  const rows: SettlementRow[] = []
  const records: SpendBoxRecord[] = []

  // ── fourteen ordinary days before the burst ────────────────────────────────
  // Reconstructed. Every day stays under the velocity rule's $1.00 absolute
  // floor, so the trailing history cannot itself trip the rule that the burst
  // must trip.
  let seed = 20_260_722
  const nextUnit = (): number => {
    // A small LCG, so the fixture is reproducible without a dependency.
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  for (let day = 0; day < 14; day++) {
    const dayStart = Date.parse('2026-07-22T00:00:00.000Z') + day * 24 * HOUR_MS
    const rowsToday = 3 + Math.floor(nextUnit() * 3)
    for (let n = 0; n < rowsToday; n++) {
      const sandboxId = `sb_ordinary_${day}_${n}`
      const intervalStartMs = dayStart + Math.floor(nextUnit() * 12 * HOUR_MS)
      // Ordinary intervals: ten minutes to an hour and a half.
      const durationMs = Math.round((10 + nextUnit() * 80) * MINUTE_MS)
      const settledAtMs = intervalStartMs + durationMs
      rows.push(
        settlementRow({
          sandboxId,
          intervalStartMs,
          settledAtMs,
          // Same price as the incident boxes, so the two are comparable.
          chargeNanoUsd: Math.round((durationMs / HOUR_MS) * 114_055_255),
        }),
      )
      records.push(
        boxRecord({
          sandboxId,
          createdAt: intervalStartMs,
          // Worked right up to the settlement — an honest short session.
          activityMs: durationMs,
        }),
      )
    }
  }

  // ── the burst: 23 parked boxes, cashed out at once ─────────────────────────
  const durationsMs: number[] = []
  for (let i = 0; i < INCIDENT_ROWS; i++) {
    // 124 h to 268 h, spread linearly across the 23 rows.
    durationsMs.push(Math.round(124 * HOUR_MS + (268 - 124) * HOUR_MS * (i / (INCIDENT_ROWS - 1))))
  }
  const totalDurationMs = durationsMs.reduce((sum, ms) => sum + ms, 0)

  const incidentSandboxIds: string[] = []
  let allocated = 0
  for (let i = 0; i < INCIDENT_ROWS; i++) {
    const sandboxId = `sb_parked_${String(i).padStart(2, '0')}`
    incidentSandboxIds.push(sandboxId)
    const durationMs = durationsMs[i] as number
    // The burst settles all 23 inside seven minutes.
    const settledAtMs = BURST_START + Math.round((BURST_SPAN_MS * i) / (INCIDENT_ROWS - 1))
    const intervalStartMs = settledAtMs - durationMs
    // Amounts sum to the refunded total exactly; the last row absorbs rounding.
    const charge =
      i === INCIDENT_ROWS - 1
        ? REPORTER_REFUND_NANO_USD - allocated
        : Math.round((durationMs / totalDurationMs) * REPORTER_REFUND_NANO_USD)
    allocated += charge
    rows.push(settlementRow({ sandboxId, intervalStartMs, settledAtMs, chargeNanoUsd: charge }))
    // The box resumed, was used for well under an hour, then sat parked for
    // days. Nothing stopped it, because no product stops a box.
    records.push(
      boxRecord({
        sandboxId,
        createdAt: intervalStartMs,
        activityMs: Math.round((12 + (i % 7) * 6) * MINUTE_MS),
      }),
    )
  }

  // ── the two genuine sub-cent rows in the same window ───────────────────────
  const genuineSandboxIds: string[] = []
  for (const [n, minutes] of [4, 7].entries()) {
    const sandboxId = `sb_genuine_${n}`
    genuineSandboxIds.push(sandboxId)
    const durationMs = minutes * MINUTE_MS
    const settledAtMs = BURST_START + 3 * MINUTE_MS
    const intervalStartMs = settledAtMs - durationMs
    rows.push(
      settlementRow({
        sandboxId,
        intervalStartMs,
        settledAtMs,
        chargeNanoUsd: Math.round((durationMs / HOUR_MS) * 114_055_255),
      }),
    )
    records.push(boxRecord({ sandboxId, createdAt: intervalStartMs, activityMs: durationMs }))
  }

  rows.sort((a, b) => a.createdAt - b.createdAt)

  return {
    rows,
    records,
    incidentSandboxIds,
    genuineSandboxIds,
    asOf: INCIDENT_AS_OF,
  }
}
