/**
 * The direction every settlement-driven rule is blind to: were we NOT billed for
 * something we DID ask for?
 *
 * Each shape below produced `ok: true` before this existed — the check stopped
 * checking while looking green, which is the failure class the module exists to
 * prevent, reproduced inside the module. The negatives matter as much as the
 * positives: an idle product that pages every day is a muted alert, so a window
 * in which nothing of this product's was alive must stay clean.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPECTATION_GRACE_MS,
  assessAllExcluded,
  boxLivenessInWindow,
} from './liveness'
import { ownedByBillingKeys } from './ownership'
import { reconcileSpend } from './reconcile'
import { createInMemorySpendLedgerStore } from './store'
import type { SettlementRow, SpendBoxRecord, SpendWindow } from './types'

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const USD = 1_000_000_000

const WINDOW: SpendWindow = { startAt: T0, endAt: T0 + DAY }

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
  keyId?: string | null
}): SettlementRow {
  const sandboxId = over.sandboxId ?? 'sb_1'
  const intervalStartMs = over.intervalStartMs ?? T0
  return {
    id: `tx_${sandboxId}_${intervalStartMs}`,
    referenceId: `sandbox:stop:${sandboxId}:${intervalStartMs}`,
    amountNanoUsd: -(over.chargeNanoUsd ?? USD),
    type: 'compute',
    product: 'sandbox',
    groupKey: `sandbox:${sandboxId}`,
    createdAt: over.settledAtMs ?? T0 + 2 * HOUR,
    description: null,
    costBasisNanoUsd: null,
    billedMs: null,
    ...(over.keyId !== undefined ? { keyId: over.keyId } : {}),
  }
}

function storeWith(...records: SpendBoxRecord[]) {
  const store = createInMemorySpendLedgerStore()
  for (const row of records) store.put(row)
  return store
}

describe('boxLivenessInWindow', () => {
  it('derives the live interval from the same horizon the ceiling uses', () => {
    const live = boxLivenessInWindow(record(), WINDOW)
    expect(live.liveFrom).toBe(T0)
    // last activity + the idle timeout, exactly as computeExpectedCeiling folds it
    expect(live.liveUntil).toBe(T0 + 2 * HOUR)
    expect(live.basis).toBe('idle-timeout')
    expect(live.overlaps).toBe(true)
    expect(live.liveMsInWindow).toBe(2 * HOUR)
    expect(live.expectSettlement).toBe(true)
  })

  it('honours a recorded stop and a delete over the idle window', () => {
    const stopped = boxLivenessInWindow(record({ stoppedAt: T0 + 20 * MINUTE }), WINDOW)
    expect(stopped.basis).toBe('stopped')
    expect(stopped.liveUntil).toBe(T0 + 20 * MINUTE)

    const deleted = boxLivenessInWindow(
      record({ stoppedAt: T0 + 20 * MINUTE, deletedAt: T0 + 30 * MINUTE }),
      WINDOW,
    )
    expect(deleted.basis).toBe('deleted')
    expect(deleted.liveUntil).toBe(T0 + 30 * MINUTE)
  })

  it('does not overlap a window the box died before, or was created after', () => {
    const before = boxLivenessInWindow(record({ stoppedAt: T0 + HOUR }), {
      startAt: T0 + 10 * DAY,
      endAt: T0 + 11 * DAY,
    })
    expect(before.overlaps).toBe(false)
    expect(before.liveMsInWindow).toBe(0)
    expect(before.expectSettlement).toBe(false)

    const after = boxLivenessInWindow(record({ createdAt: T0 + 10 * DAY, lastActivityAt: T0 + 10 * DAY }), WINDOW)
    expect(after.overlaps).toBe(false)
  })

  it('expects nothing of a box that came up inside the settlement lag', () => {
    // Live for five minutes before the window closed: real, and no settlement
    // for it is due yet.
    const fresh = boxLivenessInWindow(
      record({ createdAt: T0 + DAY - 5 * MINUTE, lastActivityAt: T0 + DAY - 5 * MINUTE }),
      WINDOW,
    )
    expect(fresh.overlaps).toBe(true)
    expect(fresh.liveMsInWindow).toBe(5 * MINUTE)
    expect(fresh.expectSettlement).toBe(false)
    expect(DEFAULT_EXPECTATION_GRACE_MS).toBe(15 * MINUTE)
  })
})

describe('silent-ledger', () => {
  it('reports expected boxes that nothing settled against', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: storeWith(record(), record({ sandboxId: 'sb_2' })),
      window: WINDOW,
      asOf: T0 + DAY,
      velocity: false,
    })

    expect(report.ok).toBe(false)
    expect(report.expectation.declared).toBe(true)
    expect(report.expectation.expectedBoxes).toBe(2)
    expect(report.expectation.settledBoxes).toBe(0)
    expect(report.expectation.unsettledSandboxIds).toEqual(['sb_1', 'sb_2'])

    const findings = report.findings.filter((finding) => finding.check === 'silent-ledger')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.expectedBoxes).toBe(2)
    expect(findings[0]?.settledBoxes).toBe(0)
    expect(findings[0]?.windowStartAt).toBe(WINDOW.startAt)
    expect(findings[0]?.windowEndAt).toBe(WINDOW.endAt)
    // The reader must know the CHECK is suspect, not the bill.
    expect(findings[0]?.message).toContain('more likely to be a broken check than a free week')
    expect(findings[0]?.remedy).toContain('Check the fetch before the bill')
  })

  it('reports one silent box per finding when its siblings settled normally', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_1' })],
      store: storeWith(record(), record({ sandboxId: 'sb_2', workspaceId: 'ws_2' })),
      window: WINDOW,
      asOf: T0 + DAY,
      velocity: false,
    })

    const findings = report.findings.filter((finding) => finding.check === 'silent-ledger')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.sandboxId).toBe('sb_2')
    expect(findings[0]?.workspaceId).toBe('ws_2')
    expect(findings[0]?.liveMsInWindow).toBe(2 * HOUR)
    expect(report.expectation.settledBoxes).toBe(1)
    // A per-box anomaly, not a broken feed: the remedy leads with settlement lag
    // and key attribution rather than with re-running the whole fetch.
    expect(findings[0]?.remedy).toContain('merely late')
  })

  it('stays silent for a genuinely idle product with no box live in the window', async () => {
    const report = await reconcileSpend({
      rows: [],
      // The box lived, and died, ten days before this window opened. The store's
      // coarse predicate still hands it over — the reconciler re-derives.
      store: storeWith(record({ stoppedAt: T0 + HOUR })),
      window: { startAt: T0 + 10 * DAY, endAt: T0 + 11 * DAY },
      asOf: T0 + 11 * DAY,
    })

    expect(report.ok).toBe(true)
    expect(report.coverage).toBe('nothing-expected')
    expect(report.expectation.liveBoxes).toBe(0)
    expect(report.expectation.expectedBoxes).toBe(0)
    expect(report.findings).toHaveLength(0)
  })

  it('expects nothing of a box that only came up inside the settlement lag', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: storeWith(
        record({ createdAt: T0 + DAY - 5 * MINUTE, lastActivityAt: T0 + DAY - 5 * MINUTE }),
      ),
      window: WINDOW,
      asOf: T0 + DAY,
    })
    expect(report.expectation.liveBoxes).toBe(1)
    expect(report.expectation.expectedBoxes).toBe(0)
    expect(report.ok).toBe(true)
  })

  it('reports a stale ownership rule that excluded every box while ours were live', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_other', keyId: 'key_rotated' })],
      store: storeWith(record()),
      // The product rotated its platform key and never updated the rule.
      ownership: ownedByBillingKeys(['key_current']),
      window: WINDOW,
      asOf: T0 + DAY,
      velocity: false,
    })

    expect(report.ok).toBe(false)
    expect(report.ownership.ownedBoxes).toBe(0)
    expect(report.ownership.foreignBoxes).toBe(1)
    const findings = report.findings.filter((finding) => finding.check === 'silent-ledger')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('rotated key')

    const assessment = assessAllExcluded(report)
    expect(assessment.pathological).toBe(true)
    expect(assessment.basis).toBe('expected-boxes-live')
  })
})

describe('a pass that examined nobody', () => {
  it('cannot render as a clean bill', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + DAY,
    })

    expect(report.ok).toBe(false)
    expect(report.coverage).toBe('unverified')
    expect(report.rowsExamined).toBe(0)
    const findings = report.findings.filter((finding) => finding.check === 'silent-ledger')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('examined none of this product\'s settlements')
    expect(findings[0]?.remedy).toContain('listLiveBetween')
  })

  it('cannot be made clean by skipping the check that reports it', async () => {
    const report = await reconcileSpend({
      rows: [],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + DAY,
      skip: ['silent-ledger'],
    })
    // The skip removes the finding, never the verdict.
    expect(report.findings).toHaveLength(0)
    expect(report.coverage).toBe('unverified')
    expect(report.ok).toBe(false)
  })

  it('cannot be made clean by a store that cannot list its own boxes', async () => {
    const base = createInMemorySpendLedgerStore()
    base.put(record())
    const { listLiveBetween: _dropped, ...withoutListing } = base
    const report = await reconcileSpend({
      rows: [],
      store: withoutListing,
      window: WINDOW,
      asOf: T0 + DAY,
    })
    expect(report.expectation.declared).toBe(false)
    expect(report.coverage).toBe('unverified')
    expect(report.ok).toBe(false)
  })

  it('is still verified when it claimed one of its own settlements', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({})],
      store: storeWith(record()),
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.coverage).toBe('verified')
    expect(report.expectation.declared).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('refuses a window that expects nothing by construction', async () => {
    await expect(
      reconcileSpend({
        rows: [],
        store: createInMemorySpendLedgerStore(),
        window: { startAt: T0 + DAY, endAt: T0 },
        asOf: T0 + DAY,
      }),
    ).rejects.toThrow(/ends at or before it starts/)
  })
})

describe('assessAllExcluded', () => {
  async function excludedReport(over: { window?: SpendWindow; records?: SpendBoxRecord[] }) {
    return await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_sibling', keyId: 'key_sibling' })],
      store: storeWith(...(over.records ?? [])),
      ownership: ownedByBillingKeys(['key_ours']),
      ...(over.window ? { window: over.window } : {}),
      asOf: T0 + DAY,
      velocity: false,
    })
  }

  it('does not page an idle product beside a busy sibling', async () => {
    const report = await excludedReport({
      window: { startAt: T0 + 10 * DAY, endAt: T0 + 11 * DAY },
      records: [record({ stoppedAt: T0 + HOUR })],
    })
    const assessment = assessAllExcluded(report)
    expect(assessment.pathological).toBe(false)
    expect(assessment.basis).toBe('nothing-expected')
    expect(assessment.reason).toContain('idle product beside a busy sibling')
  })

  it('fails closed when no expectation was declared', async () => {
    const report = await excludedReport({})
    const assessment = assessAllExcluded(report)
    expect(assessment.pathological).toBe(true)
    expect(assessment.basis).toBe('not-declared')
    expect(assessment.reason).toContain('declare `window`')
  })

  it('says nothing at all when the pass examined its own settlements', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ keyId: 'key_ours' })],
      store: storeWith(record()),
      ownership: ownedByBillingKeys(['key_ours']),
      asOf: T0 + DAY,
      velocity: false,
    })
    const assessment = assessAllExcluded(report)
    expect(assessment.pathological).toBe(false)
    expect(assessment.basis).toBe('not-all-excluded')
  })
})

describe('the existing detections are untouched', () => {
  it('still reports over-ceiling on a recorded box inside a declared window', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ settledAtMs: T0 + 200 * HOUR })],
      store: storeWith(record()),
      window: { startAt: T0, endAt: T0 + 210 * HOUR },
      asOf: T0 + 210 * HOUR,
      velocity: false,
    })
    const overCeiling = report.findings.filter((finding) => finding.check === 'over-ceiling')
    expect(overCeiling).toHaveLength(1)
    expect(overCeiling[0]?.settledMs).toBe(200 * HOUR)
    // The box settled, so nothing is silent about it.
    expect(report.findings.filter((finding) => finding.check === 'silent-ledger')).toHaveLength(0)
  })

  it('still reports an unknown box, and does not also call it silent', async () => {
    const report = await reconcileSpend({
      rows: [stopRow({ sandboxId: 'sb_stranger' })],
      store: storeWith(record()),
      window: WINDOW,
      asOf: T0 + DAY,
      velocity: false,
    })
    expect(report.findings.map((finding) => finding.check).sort()).toEqual([
      'silent-ledger',
      'unknown-box',
    ])
    // sb_1 was live and settled nothing; sb_stranger settled and was never asked
    // for. Two different defects, two different findings, neither swallowing the
    // other.
    const silent = report.findings.find((finding) => finding.check === 'silent-ledger')
    expect(silent?.sandboxId).toBeNull()
    expect(report.expectation.unsettledSandboxIds).toEqual(['sb_1'])
  })
})
