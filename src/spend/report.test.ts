import { describe, expect, it } from 'vitest'

import { formatSpendReport } from './report'
import type { SpendFinding, SpendReport } from './types'

/**
 * The formatter feeds the ALERT path. A throw here does not lose a line of a
 * report — it takes down the page the pass was about to send, which is the one
 * outcome `/alerting` is built to prevent. So a report or finding that arrives
 * with a field missing has to render, and has to render as "not measured"
 * rather than as an invented number.
 *
 * The shape below is real: a product on an older agent-app assembles a report
 * with no `expectation` block and findings with only the fields its own check
 * sets, and `formatSpendReport` reached `new Date(undefined).toISOString()`.
 */
function partialFinding(): SpendFinding {
  return {
    check: 'over-ceiling',
    message: 'settled 200h against a 24h ceiling',
    remedy: 'dispute with the platform',
    sandboxId: 'sandbox-1',
    workspaceId: 'ws-1',
    referenceIds: ['tx-1'],
    settledNanoUsd: 22_800_000_000,
    settledMs: 720_000_000,
    durationBasis: 'reference-span',
    ceilingMs: 3_600_000,
    overageMs: 716_400_000,
    ceilingBasis: 'idle-timeout',
    windowNanoUsd: null,
    trailingMedianNanoUsd: null,
    velocityRatio: null,
    windowStartAt: null,
    balanceNanoUsd: null,
    balanceFloorNanoUsd: null,
    // `windowEndAt`, `expectedBoxes`, `settledBoxes` and `liveMsInWindow` are
    // deliberately absent — this is the shape that threw.
  } as unknown as SpendFinding
}

function partialReport(): SpendReport {
  return {
    ok: false,
    findings: [partialFinding()],
    checksRun: ['over-ceiling'],
    rowsExamined: 1,
    boxesExamined: 1,
    settledNanoUsd: 22_800_000_000,
    creditedNanoUsd: 0,
    coverage: 'verified',
    ownership: {
      declared: false,
      label: null,
      ownedBoxes: 1,
      ownedNanoUsd: 22_800_000_000,
      undecidableBoxes: 0,
      foreignBoxes: 0,
      foreignNanoUsd: 0,
      foreignSandboxIds: [],
    },
    asOf: Date.parse('2026-08-06T09:00:00.000Z'),
    // `expectation` absent — the block a report from before liveness carries.
  } as unknown as SpendReport
}

describe('formatSpendReport — never throws on the alert path', () => {
  it('renders a report carrying no expectation block', () => {
    const text = formatSpendReport(partialReport())
    expect(text).toContain('expectation: NOT DECLARED')
  })

  it('renders an absent measured field as not-measured, never as a date or NaN', () => {
    const text = formatSpendReport(partialReport())
    expect(text).toContain('window end: —')
    expect(text).toContain('live in window: —')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Invalid Date')
  })

  it('still prints the numbers the finding DID measure', () => {
    const text = formatSpendReport(partialReport())
    expect(text).toContain('amount: $22.80')
    expect(text).toContain('settled: 200.00h')
  })
})
