import type {
  SpendExpectationSummary,
  SpendFinding,
  SpendOwnershipSummary,
  SpendReport,
} from './types'

const NANO_PER_USD = 1_000_000_000

function usd(nano: number | null | undefined): string {
  // Nullish for the same reason the date rows are: an absent field must read as
  // "not measured", never as `$NaN`, and never as a throw on the alert path.
  return nano == null ? '—' : `$${(nano / NANO_PER_USD).toFixed(2)}`
}

/**
 * Render a reconciliation for a human deciding whether to open a dispute.
 *
 * Every finding prints its numbers, not a summary of them: the reader's next
 * action is a conversation with the platform about specific reference ids, and a
 * report that made them re-derive the durations would just be re-read alongside
 * the raw rows anyway.
 */
export function formatSpendReport(report: SpendReport): string {
  const lines: string[] = []
  lines.push(
    `spend reconciliation — ${report.rowsExamined} row(s), ${report.boxesExamined} box(es), ` +
      `${usd(report.settledNanoUsd)} charged, ${usd(report.creditedNanoUsd)} credited, ` +
      `as of ${new Date(report.asOf).toISOString()}`,
  )
  lines.push(`checks: ${report.checksRun.join(', ') || '(none)'}`)
  for (const line of ownershipLines(report.ownership)) lines.push(line)
  for (const line of expectationLines(report.expectation)) lines.push(line)

  if (report.ok) {
    lines.push('')
    lines.push('OK — no discrepancy between the product\'s expectations and the settled ledger.')
    return lines.join('\n')
  }

  // A pass that examined nobody is not clean and is not a dispute either. Say
  // which of the two this is before the reader starts reading findings as
  // charges to argue about.
  if (report.coverage === 'unverified') {
    lines.push('')
    lines.push(
      'UNVERIFIED — this pass examined none of this product\'s settlements and could not say what ' +
        'it expected, so it cannot certify the bill either way. Read the finding below as "do not ' +
        'trust this report", not as "dispute this charge".',
    )
  }

  lines.push('')
  lines.push(`${report.findings.length} finding(s):`)
  for (const finding of report.findings) {
    lines.push('')
    lines.push(`  [${finding.check}] ${finding.message}`)
    for (const [label, value] of measuredFields(finding)) lines.push(`    ${label}: ${value}`)
    if (finding.referenceIds.length > 0) {
      lines.push(`    rows: ${finding.referenceIds.join(', ')}`)
    }
    lines.push(`    → ${finding.remedy}`)
  }
  return lines.join('\n')
}

/**
 * What the pass claimed and what it set aside — printed on EVERY report,
 * clean ones included.
 *
 * A clean report that does not say what it looked at is the failure this
 * closes: an over-narrow ownership rule and a genuinely quiet account produce
 * the same "OK" line, and only the excluded numbers tell them apart. The
 * excluded box ids are printed in full for the same reason — an exclusion a
 * reader cannot audit is one they have to take on trust.
 */
function ownershipLines(ownership: SpendOwnershipSummary): string[] {
  if (!ownership.declared) {
    return [
      `scope: NOT DECLARED — all ${ownership.ownedBoxes} settled box(es) claimed as this ` +
        'product\'s. A sibling product\'s box on this wallet is reported as unknown-box; pass ' +
        '`ownership` (see `ownedByBillingKeys`) to tell the two apart.',
    ]
  }
  const lines = [
    `scope: ${ownership.label} — ${ownership.ownedBoxes} box(es) ${usd(ownership.ownedNanoUsd)} ` +
      `owned, ${ownership.foreignBoxes} box(es) ${usd(ownership.foreignNanoUsd)} excluded as ` +
      'another product\'s',
  ]
  if (ownership.undecidableBoxes > 0) {
    lines.push(
      `       ${ownership.undecidableBoxes} of the owned box(es) carried no billing-key ` +
        'attribution and were claimed fail-closed',
    )
  }
  if (ownership.foreignSandboxIds.length > 0) {
    lines.push(`       excluded: ${ownership.foreignSandboxIds.join(', ')}`)
  }
  return lines
}

/**
 * What this pass expected to be billed for — printed on EVERY report, clean ones
 * included, for the same reason the scope line is.
 *
 * An undeclared expectation is the difference between "we were billed for
 * everything we asked for" and "we found nothing to complain about in whatever
 * rows arrived", and only this line tells a reader which report they are
 * holding.
 */
function expectationLines(expectation: SpendExpectationSummary | undefined): string[] {
  // A report assembled before this block existed carries no expectation at all.
  // That is exactly what "NOT DECLARED" describes, and the formatter feeds the
  // ALERT path — a throw here takes down the page it was about to send.
  if (!expectation?.declared) {
    return [
      'expectation: NOT DECLARED — this pass is driven entirely by the settlement rows it was ' +
        'handed, so it can say nothing about a box it asked for and was never billed for. Pass ' +
        '`window` and implement `listLiveBetween` on the expectation store to close that direction.',
    ]
  }
  const window = expectation.window
  const span = window ? `${new Date(window.startAt).toISOString()} → ${new Date(window.endAt).toISOString()}` : '—'
  const lines = [
    `expectation: ${span} — ${expectation.liveBoxes} box(es) live, ${expectation.expectedBoxes} ` +
      `expected to settle (≥ ${(expectation.graceMs / 60_000).toFixed(0)} min live), ` +
      `${expectation.settledBoxes} did`,
  ]
  if (expectation.unsettledSandboxIds.length > 0) {
    lines.push(`       nothing settled against: ${expectation.unsettledSandboxIds.join(', ')}`)
  }
  return lines
}

/** Every measured field a finding carries, including the ones it left null. */
function measuredFields(finding: SpendFinding): Array<[string, string]> {
  // Nullish, not `=== null`: a field a caller left off is `undefined`, and the
  // date rows below turn that into `new Date(undefined).toISOString()`, which
  // throws RangeError on the alert path. An absent value renders as the same
  // em dash a null renders as — the formatter never invents a number.
  const ms = (value: number | null | undefined): string =>
    value == null ? '—' : `${(value / 3_600_000).toFixed(2)}h`
  return [
    ['sandbox', finding.sandboxId ?? '—'],
    ['workspace', finding.workspaceId ?? '—'],
    ['amount', usd(finding.settledNanoUsd)],
    ['settled', ms(finding.settledMs)],
    ['ceiling', ms(finding.ceilingMs)],
    ['overage', ms(finding.overageMs)],
    ['ceiling basis', finding.ceilingBasis ?? '—'],
    ['duration basis', finding.durationBasis ?? '—'],
    ['window', finding.windowStartAt == null ? '—' : new Date(finding.windowStartAt).toISOString()],
    ['window end', finding.windowEndAt == null ? '—' : new Date(finding.windowEndAt).toISOString()],
    ['window spend', usd(finding.windowNanoUsd)],
    ['trailing median', usd(finding.trailingMedianNanoUsd)],
    ['ratio', finding.velocityRatio == null ? '—' : `${finding.velocityRatio.toFixed(1)}x`],
    ['balance', usd(finding.balanceNanoUsd)],
    ['balance floor', usd(finding.balanceFloorNanoUsd)],
    ['expected boxes', finding.expectedBoxes == null ? '—' : String(finding.expectedBoxes)],
    ['settled boxes', finding.settledBoxes == null ? '—' : String(finding.settledBoxes)],
    ['live in window', ms(finding.liveMsInWindow)],
  ]
}

/** The report as a plain JSON value, for an alerting pipeline. */
export function spendReportToJson(report: SpendReport): string {
  return JSON.stringify(report, null, 2)
}
