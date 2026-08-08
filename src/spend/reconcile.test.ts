/**
 * Each rule in isolation, plus the two ways the reconciler is allowed to be
 * WRONG and must say so: a duration derived from the reference span overstates a
 * late settlement, and an unbounded box produces a weaker finding than a bounded
 * one. A checker that hid either would be reporting confidence it has not
 * earned.
 */
import { describe, expect, it } from 'vitest'
import { reconcileSpend } from './reconcile'
import { createInMemorySpendLedgerStore } from './store'
import type { SettlementRow, SpendBoxRecord } from './types'

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const USD = 1_000_000_000

function record(over: Partial<SpendBoxRecord> = {}): SpendBoxRecord {
  return {
    sandboxId: 'sb_1',
    workspaceId: 'ws_1',
    createdAt: T0,
    idleTimeoutSeconds: 3600,
    maxLifetimeSeconds: 86_400,
    lastActivityAt: T0 + HOUR,
    openDetachedRunIds: [],
    stoppedAt: null,
    deletedAt: null,
    ...over,
  }
}

function stopRow(over: {
  sandboxId?: string
  intervalStartMs?: number
  settledAtMs?: number
  chargeNanoUsd?: number
  billedMs?: number | null
}): SettlementRow {
  const sandboxId = over.sandboxId ?? 'sb_1'
  const intervalStartMs = over.intervalStartMs ?? T0
  const settledAtMs = over.settledAtMs ?? T0 + 2 * HOUR
  return {
    id: `tx_${sandboxId}_${intervalStartMs}`,
    referenceId: `sandbox:stop:${sandboxId}:${intervalStartMs}`,
    amountNanoUsd: -(over.chargeNanoUsd ?? USD),
    type: 'compute',
    product: 'sandbox',
    groupKey: `sandbox:${sandboxId}`,
    createdAt: settledAtMs,
    description: null,
    costBasisNanoUsd: null,
    billedMs: over.billedMs ?? null,
  }
}

function storeWith(...records: SpendBoxRecord[]) {
  const store = createInMemorySpendLedgerStore()
  for (const row of records) store.put(row)
  return store
}

describe('unknown-box', () => {
  it('reports a settlement against a box the product never asked for', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_stranger', chargeNanoUsd: 7 * USD })],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.ok).toBe(false)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.check).toBe('unknown-box')
    expect(report.findings[0]?.sandboxId).toBe('sb_stranger')
    expect(report.findings[0]?.settledNanoUsd).toBe(7 * USD)
    // With no ownership rule the reconciler cannot tell a sibling product's box
    // from a charge that is not ours, so the remedy leads with declaring one
    // rather than with a cause it has no evidence for.
    expect(report.findings[0]?.remedy).toContain('ownedByBillingKeys')
    expect(report.findings[0]?.message).toContain('No ownership rule was declared')
  })

  it('stays silent on a known box, and on rows that name no sandbox at all', async () => {
    const report = await reconcileSpend({
      rows: [
        stopRow({ intervalStartMs: T0 + 30 * 60_000, settledAtMs: T0 + HOUR }),
        // A refund: positive amount, no group key, no sandbox reference.
        {
          id: 'tx_refund',
          referenceId: 'refund:sandbox-settlement:incident:user_1',
          amountNanoUsd: 500 * USD,
          type: 'refund',
          product: null,
          groupKey: null,
          createdAt: T0 + HOUR,
          description: 'refund',
          costBasisNanoUsd: null,
          billedMs: null,
        },
      ],
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.ok).toBe(true)
    expect(report.creditedNanoUsd).toBe(500 * USD)
  })

  it('does not also report over-ceiling for an unknown box — there is no bound to break', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_stranger', settledAtMs: T0 + 900 * HOUR })],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 1000 * HOUR,
      velocity: false,
    })
    expect(report.findings.map((finding) => finding.check)).toEqual(['unknown-box'])
  })
})

describe('over-ceiling', () => {
  it('reports a settled duration past the bound, with both numbers', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR })],
      store: storeWith(record()),
      asOf: T0 + 210 * HOUR,
      velocity: false,
    })
    const finding = report.findings[0]
    expect(finding?.check).toBe('over-ceiling')
    expect(finding?.settledMs).toBe(200 * HOUR)
    expect(finding?.ceilingMs).toBe(2 * HOUR + 900_000)
    expect(finding?.overageMs).toBe(200 * HOUR - (2 * HOUR + 900_000))
    expect(finding?.ceilingBasis).toBe('idle-timeout')
  })

  it('stays silent inside the bound, and inside the tolerance just past it', async () => {
    const inside = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 2 * HOUR })],
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(inside.ok).toBe(true)

    // Two hours of bound, plus fourteen minutes — inside the 15-minute slack.
    const slack = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 2 * HOUR + 14 * 60_000 })],
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(slack.ok).toBe(true)
  })

  it('sums a box\'s intervals, catching many rows that individually look fine', async () => {
    // Six 40-minute intervals: each well inside the bound, four hours together.
    const rows = Array.from({ length: 6 }, (_, i) =>
      stopRow({
        intervalStartMs: T0 + i * 40 * 60_000,
        settledAtMs: T0 + (i + 1) * 40 * 60_000,
      }),
    )
    const report = await reconcileSpend({
      rows,
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.findings[0]?.check).toBe('over-ceiling')
    expect(report.findings[0]?.settledMs).toBe(4 * HOUR)
    expect(report.findings[0]?.referenceIds).toHaveLength(6)
  })

  it('flags a stop that did not take, rather than trusting the product\'s own bookkeeping', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 40 * HOUR })],
      store: storeWith(record({ stoppedAt: T0 + 90 * 60_000 })),
      asOf: T0 + 50 * HOUR,
      velocity: false,
    })
    expect(report.findings[0]?.ceilingBasis).toBe('stopped')
    expect(report.findings[0]?.remedy).toContain('stop did not take')
  })

  it('names the reference-span caveat, because that basis overstates a late settlement', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR })],
      store: storeWith(record()),
      asOf: T0 + 210 * HOUR,
      velocity: false,
    })
    expect(report.findings[0]?.durationBasis).toBe('reference-span')
    expect(report.findings[0]?.message).toContain('overstates a settlement the platform merely posted late')
  })

  it('prefers a reported duration, then a price-derived one, over the span', async () => {
    const reported = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR, billedMs: 30 * 60_000 })],
      store: storeWith(record()),
      asOf: T0 + 210 * HOUR,
      velocity: false,
    })
    // The row says it billed half an hour, so the 200-hour span is irrelevant.
    expect(reported.ok).toBe(true)

    const priced = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR, chargeNanoUsd: 10 * USD })],
      store: storeWith(record()),
      asOf: T0 + 210 * HOUR,
      nanoUsdPerHour: 1 * USD,
      velocity: false,
    })
    expect(priced.findings[0]?.durationBasis).toBe('rate')
    expect(priced.findings[0]?.settledMs).toBe(10 * HOUR)
  })

  it('says so when the box could not be bounded at all', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR })],
      store: storeWith(record({ maxLifetimeSeconds: null, openDetachedRunIds: ['run_1'] })),
      // The settlement bills past the reconciliation instant itself.
      asOf: T0 + 150 * HOUR,
      velocity: false,
    })
    expect(report.findings[0]?.ceilingBasis).toBe('open-detached-run')
    expect(report.findings[0]?.message).toContain('could not bound this box')
  })

  it('skips a row whose duration cannot be derived at all, rather than assuming zero', async () => {
    const report = await reconcileSpend({
      rows: [
        {
          ...stopRow({}),
          referenceId: null,
          groupKey: 'sandbox:sb_1',
          billedMs: null,
        },
      ],
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.ok).toBe(true)
  })
})

describe('velocity', () => {
  function dailyRows(days: number, perDayNanoUsd: number): SettlementRow[] {
    return Array.from({ length: days }, (_, day) =>
      stopRow({
        sandboxId: `sb_day_${day}`,
        intervalStartMs: T0 + day * DAY,
        settledAtMs: T0 + day * DAY + 30 * 60_000,
        chargeNanoUsd: perDayNanoUsd,
      }),
    )
  }

  it('reports a window far above the trailing median', async () => {
    const rows = [
      ...dailyRows(6, 2 * USD),
      stopRow({
        sandboxId: 'sb_burst',
        intervalStartMs: T0 + 6 * DAY,
        settledAtMs: T0 + 6 * DAY + 60_000,
        chargeNanoUsd: 400 * USD,
      }),
    ]
    const report = await reconcileSpend({
      rows,
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 7 * DAY,
      skip: ['unknown-box'],
    })
    const velocity = report.findings.filter((finding) => finding.check === 'velocity')
    expect(velocity).toHaveLength(1)
    expect(velocity[0]?.trailingMedianNanoUsd).toBe(2 * USD)
    expect(velocity[0]?.velocityRatio).toBe(200)
  })

  it('stays silent on steady spend, and on a jump that is still under the absolute floor', async () => {
    const steady = await reconcileSpend({
      rows: dailyRows(10, 2 * USD),
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 11 * DAY,
      skip: ['unknown-box'],
    })
    expect(steady.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(0)

    // 100x the median, but the whole window is 30 cents.
    const tiny = await reconcileSpend({
      rows: [
        ...dailyRows(6, USD / 1000),
        stopRow({
          sandboxId: 'sb_small',
          intervalStartMs: T0 + 6 * DAY,
          settledAtMs: T0 + 6 * DAY + 60_000,
          chargeNanoUsd: USD / 10,
        }),
      ],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 7 * DAY,
      skip: ['unknown-box'],
    })
    expect(tiny.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(0)
  })

  it('needs history before it will call anything an anomaly', async () => {
    // A product's genuine first two days must not read as a spike.
    const report = await reconcileSpend({
      rows: [
        ...dailyRows(2, USD / 100),
        stopRow({
          sandboxId: 'sb_third',
          intervalStartMs: T0 + 2 * DAY,
          settledAtMs: T0 + 2 * DAY + 60_000,
          chargeNanoUsd: 500 * USD,
        }),
      ],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 3 * DAY,
      skip: ['unknown-box'],
    })
    expect(report.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(0)
  })

  it('takes its thresholds from the caller', async () => {
    const rows = [
      ...dailyRows(4, 10 * USD),
      stopRow({
        sandboxId: 'sb_burst',
        intervalStartMs: T0 + 4 * DAY,
        settledAtMs: T0 + 4 * DAY + 60_000,
        chargeNanoUsd: 21 * USD,
      }),
    ]
    const lenient = await reconcileSpend({
      rows,
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 5 * DAY,
      skip: ['unknown-box'],
      velocity: { multiple: 5 },
    })
    expect(lenient.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(0)

    const strict = await reconcileSpend({
      rows,
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 5 * DAY,
      skip: ['unknown-box'],
      velocity: { multiple: 2 },
    })
    expect(strict.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(1)
  })
})

describe('negative-balance', () => {
  // A window with an empty expectation ledger is what makes these passes
  // examine-nobody-but-legitimately: nothing was live, so nothing was expected,
  // and the balance rule is the only one with anything to say. Without it a
  // zero-row pass is `unverified` by construction — see `liveness.test.ts`.
  const idleWindow = { startAt: T0 - DAY, endAt: T0 }

  it('reports a balance under its floor', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: createInMemorySpendLedgerStore(),
      window: idleWindow,
      asOf: T0,
      balance: { nanoUsd: -15_810_000_000 },
    })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.check).toBe('negative-balance')
    expect(report.findings[0]?.balanceNanoUsd).toBe(-15_810_000_000)
  })

  it('honours a floor above zero, for an owner who must keep a buffer', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: createInMemorySpendLedgerStore(),
      window: idleWindow,
      asOf: T0,
      balance: { nanoUsd: 5 * USD, floorNanoUsd: 20 * USD },
    })
    expect(report.findings[0]?.balanceFloorNanoUsd).toBe(20 * USD)
  })

  it('stays out of the report entirely when the product cannot see a balance', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: createInMemorySpendLedgerStore(),
      window: idleWindow,
      asOf: T0,
    })
    expect(report.ok).toBe(true)
    // The check is still declared as run — it had nothing to look at, which is
    // different from having been skipped.
    expect(report.checksRun).toContain('negative-balance')
  })
})

describe('the report itself', () => {
  it('counts every row it read, including ones no rule looked at', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + HOUR }), stopRow({ sandboxId: 'sb_2', settledAtMs: T0 + HOUR })],
      store: storeWith(record(), record({ sandboxId: 'sb_2' })),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.rowsExamined).toBe(2)
    expect(report.boxesExamined).toBe(2)
    expect(report.settledNanoUsd).toBe(2 * USD)
  })

  it('leaves out the checks the caller skipped', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_stranger' })],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + DAY,
      skip: ['unknown-box', 'velocity'],
    })
    expect(report.checksRun).toEqual(['over-ceiling', 'negative-balance', 'silent-ledger'])
    // The settled box is claimed as this product's, so the pass examined
    // something and is entitled to say the bill is clean.
    expect(report.coverage).toBe('verified')
    expect(report.ok).toBe(true)
  })
})
