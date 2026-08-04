/**
 * The report a product reads in its CI log.
 *
 * A gate is only as good as the sentence a developer reads at 6pm with a red
 * build. So every finding prints three things and never fewer: WHERE
 * (`file:line:col`, clickable in every terminal and editor), WHAT is wrong in
 * the reader's terms, and WHAT TO DO about it. A finding without a remedy is a
 * complaint, and complaints get suppressed rather than fixed.
 *
 * Honoured suppressions are counted in the summary and listed on request. A
 * suppression that nobody can see is a disabled check with extra steps.
 */

import { LEGIBILITY_CHECKS, type LegibilityCheckId, type LegibilityFinding, type LegibilityReport } from './types'

export interface FormatOptions {
  /** Print every honoured suppression with its reason. */
  readonly listSuppressions?: boolean
  /** Wrap check names in ANSI colour. Off by default — CI logs keep the bytes. */
  readonly colour?: boolean
}

/** One line per check, in the order they are declared. */
const CHECK_TITLES: Record<LegibilityCheckId, string> = {
  'engineering-vocabulary': 'Engineering vocabulary on screen',
  'dead-end-empty-state': 'Empty states with no next action',
  'unchecked-success': 'Success reported without reading the response',
  'silent-failure': 'Failures the reader never learns about',
  'unreachable-capability': 'Capabilities with no door',
  'suppression-without-reason': 'Suppressions that suppress nothing',
}

export function formatLegibilityReport(report: LegibilityReport, options: FormatOptions = {}): string {
  const lines: string[] = []
  const bold = (text: string): string => (options.colour ? `[1m${text}[0m` : text)

  if (report.ok) {
    lines.push(
      `legibility OK — ${report.filesScanned} file(s), ${report.checksRun.length} check(s), no findings` +
        (report.suppressed.length > 0 ? ` (${report.suppressed.length} suppressed with a reason)` : ''),
    )
    if (options.listSuppressions) lines.push('', ...suppressionLines(report))
    return lines.join('\n')
  }

  lines.push(
    `legibility FAILED — ${report.findings.length} finding(s) across ${report.filesScanned} file(s).`,
    'Each one is a place a reader is left guessing. Fix it, or suppress that line with a written reason.',
    '',
  )

  for (const check of LEGIBILITY_CHECKS) {
    const findings = report.findings.filter((finding) => finding.check === check)
    if (findings.length === 0) continue
    lines.push(`${bold(CHECK_TITLES[check])}  [${check}]  ${findings.length}`)
    for (const finding of findings) lines.push(...findingLines(finding))
    lines.push('')
  }

  if (report.suppressed.length > 0) {
    lines.push(
      `${report.suppressed.length} finding(s) suppressed with a written reason` +
        (options.listSuppressions ? ':' : ' — run with --list-suppressions to read them.'),
    )
    if (options.listSuppressions) lines.push(...suppressionLines(report))
    lines.push('')
  }

  lines.push('Suppress one deliberate instance with a reason on the line above it:')
  lines.push('  // legibility-ignore <check> — why this instance is right')
  return lines.join('\n')
}

function findingLines(finding: LegibilityFinding): string[] {
  return [
    `  ${finding.file}:${finding.line}:${finding.column}`,
    `    ${finding.message}`,
    `    → ${finding.remedy}`,
    ...(finding.evidence ? [`    ${finding.evidence}`] : []),
  ]
}

function suppressionLines(report: LegibilityReport): string[] {
  return report.suppressed.map(
    (suppression) => `  ${suppression.file}:${suppression.line}  ${suppression.check} — ${suppression.reason}`,
  )
}

/** The machine-readable form, for a product that posts findings somewhere. */
export function legibilityReportToJson(report: LegibilityReport): string {
  return JSON.stringify(report, null, 2)
}
