/**
 * CALIBRATION — the reconciler against the incident it exists for.
 *
 * A gate that cannot be shown to catch its own motivating failure is
 * indistinguishable from one that does nothing. This runs the 2026-08-05
 * parked-time settlements (agent-dev-container#4422) through the reconciler and
 * pins exactly which rules fire, on how many rows, with what numbers.
 *
 * It pins BOTH adoption states, because they are genuinely different products:
 *
 *   - a product that has adopted the expectation ledger sees `over-ceiling`,
 *     with the numbers for a dispute;
 *   - a product that has only wired the reconciler sees `unknown-box`, which is
 *     weaker evidence but still catches the incident on day one.
 *
 * It also pins the NEGATIVE case: the two rows in the same window that were
 * genuine short intervals must not be reported, or the alert is noise.
 */
import { describe, expect, it } from 'vitest'
import { incidentFixture, REPORTER_REFUND_NANO_USD } from './fixtures/incident-parked-time'
import { reconcileSpend } from './reconcile'
import { createInMemorySpendLedgerStore } from './store'
import type { SpendCheckId, SpendFinding } from './types'

function seededStore(records: readonly { sandboxId: string }[]) {
  const store = createInMemorySpendLedgerStore()
  for (const record of records) store.put(record as never)
  return store
}

function byCheck(findings: readonly SpendFinding[], check: SpendCheckId): SpendFinding[] {
  return findings.filter((finding) => finding.check === check)
}

describe('the 2026-08-05 parked-time incident', () => {
  it('reconstructs the reporter refund to the nanodollar', () => {
    const fixture = incidentFixture()
    const parked = fixture.rows.filter((row) =>
      fixture.incidentSandboxIds.some((id) => row.referenceId?.includes(id)),
    )
    expect(parked).toHaveLength(23)
    const total = parked.reduce((sum, row) => sum - row.amountNanoUsd, 0)
    expect(total).toBe(REPORTER_REFUND_NANO_USD)
    // Every duration inside the published 124–268 h bounds.
    for (const row of parked) {
      const intervalStart = Number(row.referenceId?.split(':')[3])
      const hours = (row.createdAt - intervalStart) / 3_600_000
      expect(hours).toBeGreaterThanOrEqual(124)
      expect(hours).toBeLessThanOrEqual(268)
    }
  })

  it('flags every over-billed box when the product keeps an expectation ledger', async () => {
    const fixture = incidentFixture()
    const report = await reconcileSpend({
      rows: fixture.rows,
      store: seededStore(fixture.records),
      asOf: fixture.asOf,
      workspaceId: 'ws_reporter',
    })

    expect(report.ok).toBe(false)

    const overCeiling = byCheck(report.findings, 'over-ceiling')
    expect(overCeiling).toHaveLength(23)
    expect(new Set(overCeiling.map((finding) => finding.sandboxId))).toEqual(
      new Set(fixture.incidentSandboxIds),
    )

    // The whole refunded amount is accounted for by the findings.
    const flagged = overCeiling.reduce((sum, finding) => sum + finding.settledNanoUsd, 0)
    expect(flagged).toBe(REPORTER_REFUND_NANO_USD)

    // Every finding carries both numbers a dispute needs, and the overage is
    // enormous: a box bounded by a 24 h max lifetime billed at least 124 h.
    for (const finding of overCeiling) {
      expect(finding.ceilingBasis).toBe('idle-timeout')
      expect(finding.durationBasis).toBe('reference-span')
      expect(finding.settledMs).toBeGreaterThanOrEqual(124 * 3_600_000)
      expect(finding.ceilingMs).toBeLessThan(3 * 3_600_000)
      expect(finding.overageMs).toBeGreaterThan(121 * 3_600_000)
      expect(finding.referenceIds[0]).toMatch(/^sandbox:stop:sb_parked_\d\d:\d+$/)
    }

    // No box is reported twice, and neither genuine row is reported at all.
    for (const genuine of fixture.genuineSandboxIds) {
      expect(report.findings.some((finding) => finding.sandboxId === genuine)).toBe(false)
    }
  })

  it('flags the burst on velocity, against fourteen ordinary days of trailing spend', async () => {
    const fixture = incidentFixture()
    const report = await reconcileSpend({
      rows: fixture.rows,
      store: seededStore(fixture.records),
      asOf: fixture.asOf,
    })

    const velocity = byCheck(report.findings, 'velocity')
    expect(velocity).toHaveLength(1)
    const [burst] = velocity
    expect(burst?.windowStartAt).toBe(Date.parse('2026-08-05T00:00:00.000Z'))
    // The burst window carries the whole refund plus the two genuine rows.
    expect(burst?.windowNanoUsd).toBeGreaterThan(REPORTER_REFUND_NANO_USD)
    expect(burst?.trailingMedianNanoUsd).toBeGreaterThan(0)
    expect(burst?.velocityRatio).toBeGreaterThan(100)
    // The fourteen ordinary days stayed under the absolute floor, so the only
    // window that fires is the incident's.
    expect(burst?.trailingMedianNanoUsd).toBeLessThan(1_000_000_000)
  })

  it('still catches the incident on day one, before any lifecycle bookkeeping exists', async () => {
    const fixture = incidentFixture()
    const report = await reconcileSpend({
      rows: fixture.rows,
      // An empty expectation ledger — the reconciler wired, nothing recorded.
      store: createInMemorySpendLedgerStore(),
      asOf: fixture.asOf,
    })

    expect(report.ok).toBe(false)
    const unknown = byCheck(report.findings, 'unknown-box')
    // Every settled box is unknown, so the 23 are in there — weaker evidence
    // than an over-ceiling, and still enough to notice $514 leaving.
    expect(unknown.length).toBe(report.boxesExamined)
    const flaggedParked = unknown
      .filter((finding) => fixture.incidentSandboxIds.includes(finding.sandboxId ?? ''))
      .reduce((sum, finding) => sum + finding.settledNanoUsd, 0)
    expect(flaggedParked).toBe(REPORTER_REFUND_NANO_USD)
    // With no records there is no ceiling to break, so that rule stays silent
    // rather than inventing a bound.
    expect(byCheck(report.findings, 'over-ceiling')).toHaveLength(0)
  })

  it('reports a negative balance when the product can see one', async () => {
    const fixture = incidentFixture()
    const report = await reconcileSpend({
      rows: fixture.rows,
      store: seededStore(fixture.records),
      asOf: fixture.asOf,
      // One of the eight refunded wallets was left at -$27.28.
      balance: { nanoUsd: -27_280_000_000 },
    })
    const negative = byCheck(report.findings, 'negative-balance')
    expect(negative).toHaveLength(1)
    expect(negative[0]?.balanceNanoUsd).toBe(-27_280_000_000)
    expect(negative[0]?.balanceFloorNanoUsd).toBe(0)
  })

  it('derives the same durations from the box price as from the reference span', async () => {
    const fixture = incidentFixture()
    const report = await reconcileSpend({
      rows: fixture.rows,
      store: seededStore(fixture.records),
      asOf: fixture.asOf,
      // The price both products' boxes actually run at.
      nanoUsdPerHour: 114_055_255,
    })
    const overCeiling = byCheck(report.findings, 'over-ceiling')
    expect(overCeiling).toHaveLength(23)
    for (const finding of overCeiling) {
      // The exact basis, not the upper-bound one.
      expect(finding.durationBasis).toBe('rate')
      // Within a second of the span-derived duration: for THIS defect the two
      // agree, because billing "up to now" makes the settlement instant and the
      // interval end the same moment. That agreement is the tell.
      const spanDerived = finding.referenceIds.map((reference) => {
        const start = Number(reference.split(':')[3])
        const row = fixture.rows.find((candidate) => candidate.referenceId === reference)
        return (row?.createdAt ?? 0) - start
      })
      const spanTotal = spanDerived.reduce((sum, ms) => sum + ms, 0)
      expect(Math.abs((finding.settledMs ?? 0) - spanTotal)).toBeLessThan(1000)
    }
  })
})
