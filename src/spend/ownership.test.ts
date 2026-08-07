/**
 * The scoping split, and the thing it is NOT allowed to cost.
 *
 * The defect: `/v1/billing/transactions?product=sandbox` is scoped to the
 * WALLET, and `sandbox` is the platform's service taxonomy, so a Tangle account
 * running two of our products hands each one the other's boxes and every one is
 * a false `unknown-box`.
 *
 * The trap: filtering the residue down to boxes already in the expectation
 * ledger removes the false findings AND removes the check, because "billed for a
 * box we never asked for" is exactly a box that is not in the ledger. So the
 * pair of tests that matter are adjacent — a sibling's box must be silent and a
 * phantom charge inside our own attribution must still fire, on settlement rows
 * that are otherwise identical.
 */
import { describe, expect, it } from 'vitest'
import { decideBoxOwnership, ownedByBillingKeys } from './ownership'
import { reconcileSpend } from './reconcile'
import { formatSpendReport } from './report'
import { createInMemorySpendLedgerStore } from './store'
import type { SettlementRow, SpendBoxRecord } from './types'

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const USD = 1_000_000_000

const GTM_KEY = 'key_gtm_prod'
const LEGAL_KEY = 'key_legal_prod'

function record(over: Partial<SpendBoxRecord> = {}): SpendBoxRecord {
  return {
    sandboxId: 'sandbox-aaaaaaaaaaaa',
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

/**
 * A settlement in the platform's real shape: the sandbox id is the minted
 * `sandbox-<hex>` project ref, which carries no product signal at all — the
 * whole reason ownership rides on `keyId`.
 */
function stopRow(over: {
  sandboxId?: string
  keyId?: string | null
  intervalStartMs?: number
  settledAtMs?: number
  chargeNanoUsd?: number
}): SettlementRow {
  const sandboxId = over.sandboxId ?? 'sandbox-aaaaaaaaaaaa'
  const intervalStartMs = over.intervalStartMs ?? T0
  return {
    id: `tx_${sandboxId}_${intervalStartMs}`,
    referenceId: `sandbox:stop:${sandboxId}:${intervalStartMs}`,
    amountNanoUsd: -(over.chargeNanoUsd ?? USD),
    type: 'compute',
    product: 'sandbox',
    groupKey: `sandbox:${sandboxId}`,
    createdAt: over.settledAtMs ?? T0 + 2 * HOUR,
    description: 'Sandbox compute: 2vCPU/4GB × 2.00h',
    costBasisNanoUsd: null,
    billedMs: null,
    ...(over.keyId === undefined ? { keyId: GTM_KEY } : { keyId: over.keyId }),
  }
}

function storeWith(...records: SpendBoxRecord[]) {
  const store = createInMemorySpendLedgerStore()
  for (const row of records) store.put(row)
  return store
}

/** gtm's own reconciliation: its box recorded, its key declared. */
async function gtmReconcile(rows: readonly SettlementRow[], declareOwnership = true) {
  return await reconcileSpend({
    rows: [...rows],
    store: storeWith(record()),
    asOf: T0 + DAY,
    velocity: false,
    ...(declareOwnership ? { ownership: ownedByBillingKeys([GTM_KEY]) } : {}),
  })
}

describe('a sibling product on the same wallet', () => {
  it('is not a finding — the reported defect, reproduced and closed', async () => {
    const report = await gtmReconcile([
      // gtm's own box, recorded, inside its bound.
      stopRow({ intervalStartMs: T0 + 30 * 60_000, settledAtMs: T0 + HOUR }),
      // legal-agent's box on the same wallet: same product taxonomy, same
      // shape, different platform key.
      stopRow({ sandboxId: 'sandbox-bbbbbbbbbbbb', keyId: LEGAL_KEY, chargeNanoUsd: 3 * USD }),
    ])

    expect(report.ok).toBe(true)
    expect(report.findings).toHaveLength(0)
    // Excluded, not invisible: the numbers and the id are on the report.
    expect(report.ownership.declared).toBe(true)
    expect(report.ownership.foreignBoxes).toBe(1)
    expect(report.ownership.foreignNanoUsd).toBe(3 * USD)
    expect(report.ownership.foreignSandboxIds).toEqual(['sandbox-bbbbbbbbbbbb'])
    expect(report.ownership.ownedBoxes).toBe(1)
    // And the pass still says it read both — scoping narrows the verdict, not
    // the accounting.
    expect(report.boxesExamined).toBe(2)
    expect(report.settledNanoUsd).toBe(4 * USD)
  })

  it('is still reported as a finding when no ownership rule is declared', async () => {
    const report = await gtmReconcile(
      [stopRow({ sandboxId: 'sandbox-bbbbbbbbbbbb', keyId: LEGAL_KEY, chargeNanoUsd: 3 * USD })],
      false,
    )
    // Unchanged behaviour for a consumer that has not adopted the option — but
    // it is loud rather than silent about what it could not tell apart.
    expect(report.findings.map((finding) => finding.check)).toEqual(['unknown-box'])
    expect(report.ownership.declared).toBe(false)
    expect(report.findings[0]?.message).toContain('No ownership rule was declared')
    expect(report.findings[0]?.remedy).toContain('ownedByBillingKeys')
  })
})

describe('a phantom charge inside this product\'s own attribution', () => {
  it('is STILL a finding — the detection the split must not trade away', async () => {
    const report = await gtmReconcile([
      // Same wallet, same taxonomy, same shape as the sibling row above. The
      // only difference is the key the platform stamped, and it is ours.
      stopRow({ sandboxId: 'sandbox-cccccccccccc', keyId: GTM_KEY, chargeNanoUsd: 3 * USD }),
    ])

    expect(report.ok).toBe(false)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.check).toBe('unknown-box')
    expect(report.findings[0]?.sandboxId).toBe('sandbox-cccccccccccc')
    expect(report.findings[0]?.settledNanoUsd).toBe(3 * USD)
    expect(report.findings[0]?.message).toContain('attributes it to THIS product')
    expect(report.ownership.foreignBoxes).toBe(0)
  })

  it('keeps the incident\'s day-one catch: nothing recorded, everything ours, everything reported', async () => {
    const rows = Array.from({ length: 23 }, (_, i) =>
      stopRow({
        sandboxId: `sandbox-parked${String(i).padStart(6, '0')}`,
        keyId: GTM_KEY,
        intervalStartMs: T0,
        settledAtMs: T0 + 124 * HOUR,
        chargeNanoUsd: 22 * USD,
      }),
    )
    const report = await reconcileSpend({
      rows,
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 130 * HOUR,
      velocity: false,
      ownership: ownedByBillingKeys([GTM_KEY]),
    })
    expect(report.findings.filter((finding) => finding.check === 'unknown-box')).toHaveLength(23)
    expect(report.ownership.foreignBoxes).toBe(0)
  })
})

describe('the boundary between them', () => {
  it('claims a settlement with no key attribution — fail closed, and says why', async () => {
    const report = await gtmReconcile([
      stopRow({ sandboxId: 'sandbox-dddddddddddd', keyId: null, chargeNanoUsd: 3 * USD }),
    ])

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.check).toBe('unknown-box')
    expect(report.findings[0]?.message).toContain('could not decide it')
    expect(report.findings[0]?.remedy).toContain('exactly what a phantom charge looks like')
    expect(report.ownership.undecidableBoxes).toBe(1)
    expect(report.ownership.ownedBoxes).toBe(1)
    expect(report.ownership.foreignBoxes).toBe(0)
  })

  it('never lets a rule un-own a box the product itself recorded', async () => {
    // The record says this box is gtm's; the ownership rule, wrongly narrow,
    // would call it legal's. The ledger wins, so over-ceiling still fires.
    const report = await reconcileSpend({
      rows: [stopRow({ keyId: LEGAL_KEY, settledAtMs: T0 + 200 * HOUR })],
      store: storeWith(record()),
      asOf: T0 + 210 * HOUR,
      velocity: false,
      ownership: ownedByBillingKeys([GTM_KEY]),
    })
    expect(report.findings.map((finding) => finding.check)).toEqual(['over-ceiling'])
    expect(report.ownership.foreignBoxes).toBe(0)
  })

  it('claims a box if ANY of its rows claims it, so a mixed box is never dropped', () => {
    const rule = ownedByBillingKeys([GTM_KEY])
    const mixed = [
      stopRow({ sandboxId: 'sandbox-eeeeeeeeeeee', keyId: LEGAL_KEY }),
      stopRow({ sandboxId: 'sandbox-eeeeeeeeeeee', keyId: GTM_KEY, intervalStartMs: T0 + HOUR }),
    ]
    expect(decideBoxOwnership(rule, 'sandbox-eeeeeeeeeeee', mixed)).toBe('mine')
    expect(decideBoxOwnership(rule, 'sandbox-eeeeeeeeeeee', [mixed[0] as SettlementRow])).toBe('foreign')
    expect(
      decideBoxOwnership(rule, 'sandbox-eeeeeeeeeeee', [
        stopRow({ sandboxId: 'sandbox-eeeeeeeeeeee', keyId: LEGAL_KEY }),
        stopRow({ sandboxId: 'sandbox-eeeeeeeeeeee', keyId: null, intervalStartMs: T0 + HOUR }),
      ]),
    ).toBe('undecidable')
  })
})

describe('velocity under a declared scope', () => {
  function ourDailyRows(days: number, perDayNanoUsd: number): SettlementRow[] {
    return Array.from({ length: days }, (_, day) =>
      stopRow({
        sandboxId: `sandbox-day${String(day).padStart(9, '0')}`,
        keyId: GTM_KEY,
        intervalStartMs: T0 + day * DAY,
        settledAtMs: T0 + day * DAY + 30 * 60_000,
        chargeNanoUsd: perDayNanoUsd,
      }),
    )
  }

  it('does not page this product for a sibling product\'s burst', async () => {
    const report = await reconcileSpend({
      rows: [
        ...ourDailyRows(6, 2 * USD),
        stopRow({
          sandboxId: 'sandbox-siblingburst',
          keyId: LEGAL_KEY,
          intervalStartMs: T0 + 6 * DAY,
          settledAtMs: T0 + 6 * DAY + 60_000,
          chargeNanoUsd: 400 * USD,
        }),
      ],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 7 * DAY,
      skip: ['unknown-box'],
      ownership: ownedByBillingKeys([GTM_KEY]),
    })
    expect(report.findings.filter((finding) => finding.check === 'velocity')).toHaveLength(0)
    expect(report.ownership.foreignNanoUsd).toBe(400 * USD)
  })

  it('still fires on this product\'s own burst', async () => {
    const report = await reconcileSpend({
      rows: [
        ...ourDailyRows(6, 2 * USD),
        stopRow({
          sandboxId: 'sandbox-ourburst00',
          keyId: GTM_KEY,
          intervalStartMs: T0 + 6 * DAY,
          settledAtMs: T0 + 6 * DAY + 60_000,
          chargeNanoUsd: 400 * USD,
        }),
      ],
      store: createInMemorySpendLedgerStore(),
      asOf: T0 + 7 * DAY,
      skip: ['unknown-box'],
      ownership: ownedByBillingKeys([GTM_KEY]),
    })
    const velocity = report.findings.filter((finding) => finding.check === 'velocity')
    expect(velocity).toHaveLength(1)
    expect(velocity[0]?.velocityRatio).toBe(200)
    expect(velocity[0]?.message).toContain('own rows only')
  })
})

describe('the rendered report', () => {
  it('names what it excluded even when the verdict is clean', async () => {
    const report = await gtmReconcile([
      stopRow({ intervalStartMs: T0 + 30 * 60_000, settledAtMs: T0 + HOUR }),
      stopRow({ sandboxId: 'sandbox-bbbbbbbbbbbb', keyId: LEGAL_KEY, chargeNanoUsd: 3 * USD }),
    ])
    const text = formatSpendReport(report)
    expect(report.ok).toBe(true)
    // An "OK" with nothing else would be indistinguishable from a rule so
    // narrow it verified nothing.
    expect(text).toContain('scope: billing key key_gtm_prod')
    expect(text).toContain('1 box(es) $3.00 excluded as another product\'s')
    expect(text).toContain('excluded: sandbox-bbbbbbbbbbbb')
  })

  it('announces an undeclared scope rather than reading as a scoped pass', async () => {
    const report = await gtmReconcile([stopRow({ intervalStartMs: T0 + 30 * 60_000, settledAtMs: T0 + HOUR })], false)
    expect(formatSpendReport(report)).toContain('scope: NOT DECLARED')
  })

  it('separates the fail-closed boxes from the ones it positively claimed', async () => {
    const report = await gtmReconcile([
      stopRow({ sandboxId: 'sandbox-dddddddddddd', keyId: null, chargeNanoUsd: 3 * USD }),
    ])
    expect(formatSpendReport(report)).toContain('carried no billing-key attribution')
  })
})

describe('ownedByBillingKeys', () => {
  it('refuses an empty key list rather than owning nothing', () => {
    expect(() => ownedByBillingKeys([])).toThrow(/at least one key id/)
    expect(() => ownedByBillingKeys(['  '])).toThrow(/at least one key id/)
  })

  it('names itself, so a report says what it excluded by', () => {
    expect(ownedByBillingKeys([GTM_KEY, ' key_gtm_staging ']).label).toBe(
      'billing key key_gtm_prod, key_gtm_staging',
    )
  })
})
