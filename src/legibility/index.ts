/**
 * `@tangle-network/agent-app/legibility` — the understandability gate a product
 * runs over its OWN source, in its OWN CI.
 *
 * ── Why this is code and not a document ──────────────────────────────────────
 *
 * `docs/product-surfaces.md` opened by reporting an audit that scored product
 * clarity 2-4/10 and concluded "mechanism is not the gap; meaning is". It was
 * well argued and it changed nothing: the verticals then shipped 11 of 21 empty
 * states with no next action, the word "materialized" in user-facing error copy,
 * a Settings page that answered "Saved" to a 404, and two correct deterministic
 * engines — a statute-citing contract redline and a court-deadline calculator
 * with 59 golden tests — that no navigation entry or link reached.
 *
 * Every one of those is mechanically detectable from source. So they are checks,
 * they name `file:line`, and they fail a build. The same shape as `/peer-floors`
 * and `/theme-contract`: a node-only checker the CONSUMER runs against its own
 * tree, because that is the only place the defect exists.
 *
 * ── The rule that keeps it alive ─────────────────────────────────────────────
 *
 * A gate that cannot be silenced per-instance gets silenced per-repo. So every
 * finding is individually suppressible — and a suppression with no written
 * reason is itself a finding, and suppresses nothing. Exemptions stay as visible
 * as failures; that is the whole difference between a gate and a flag someone
 * flipped in a rush.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *     import { checkLegibility, formatLegibilityReport } from '@tangle-network/agent-app/legibility'
 *     const report = checkLegibility({ srcDirs: ['src'], reachability: { routeConfigFile: 'src/routes.ts', navFiles: ['src/components/sidebar.tsx'] } })
 *     console.log(formatLegibilityReport(report))
 *
 * or, in CI, the bin: `agent-app-legibility-check --src src --routes src/routes.ts --nav src/components/sidebar.tsx`.
 */

import { checkEmptyStates } from './checks/empty-state'
import { checkReachability } from './checks/reachability'
import { checkSilentFailure } from './checks/silent-failure'
import { checkUncheckedSuccess } from './checks/success'
import { checkVocabulary } from './checks/vocabulary'
import { scanSources, type ScannedFile } from './scan'
import { buildSuppressionIndex } from './suppress'
import {
  LEGIBILITY_CHECKS,
  type LegibilityCheckId,
  type LegibilityConfig,
  type LegibilityFinding,
  type LegibilityReport,
  type LegibilitySuppression,
  type RawFinding,
} from './types'

export { LEGIBILITY_CHECKS } from './types'
export type {
  BannedTerm,
  EmptyStateOptions,
  LegibilityCheckId,
  LegibilityConfig,
  LegibilityFinding,
  LegibilityReport,
  LegibilitySuppression,
  ReachabilityOptions,
  SilentFailureOptions,
  SuccessOptions,
  VocabularyOptions,
} from './types'
export { formatLegibilityReport, legibilityReportToJson, type FormatOptions } from './report'
export { DEFAULT_BANNED_TERMS, COPY_KEYS, COPY_CALLS } from './checks/vocabulary'
// `readerlessPaths` REPLACES this default rather than extending it, so a
// consumer adding one server path needs the default to spread.
export { READERLESS_PATHS } from './checks/silent-failure'
export { parseRouteConfig, staticSegments, type RouteEntry } from './checks/reachability'
export { scanSources, scanFile, buildScannedFile, type ScannedFile } from './scan'
export {
  scanSource,
  type JsxAttribute,
  type JsxElement,
  type ScannedSource,
  type SegmentKind,
  type SourceSegment,
} from './source'

/** Is a check switched on? Every check is on unless the config turns it off. */
function enabled(config: LegibilityConfig, check: LegibilityCheckId): boolean {
  return config.checks?.[check] !== false
}

/**
 * Run the gate over a product's source.
 *
 * Pure of process state apart from reading files: no `process.exit`, no logging.
 * The bin decides what to do with the report; a product embedding this in its
 * own tooling decides something else.
 */
export function checkLegibility(config: LegibilityConfig): LegibilityReport {
  if (config.srcDirs.length === 0) throw new Error('checkLegibility: srcDirs must name at least one directory')

  const files = scanSources(config.srcDirs, config.ignorePaths ?? [])
  const findings: LegibilityFinding[] = []
  const suppressed: LegibilitySuppression[] = []

  const collect = (file: ScannedFile, raw: readonly RawFinding[]): void => {
    const index = buildSuppressionIndex(file)
    for (const finding of [...raw, ...index.selfFindings]) {
      if (!enabled(config, finding.check)) continue
      const { line, column } = file.positionAt(finding.offset)
      const reason = finding.check === 'suppression-without-reason' ? null : index.reasonFor(finding.check, line)
      if (reason !== null) {
        suppressed.push({ check: finding.check, reason, file: file.display, line })
        continue
      }
      findings.push({
        check: finding.check,
        file: file.display,
        line,
        column,
        message: finding.message,
        remedy: finding.remedy,
        evidence: finding.evidence,
      })
    }
  }

  for (const file of files) {
    const raw: RawFinding[] = []
    if (enabled(config, 'engineering-vocabulary')) raw.push(...checkVocabulary(file, config.vocabulary))
    if (enabled(config, 'dead-end-empty-state')) raw.push(...checkEmptyStates(file, config.emptyState))
    if (enabled(config, 'unchecked-success')) raw.push(...checkUncheckedSuccess(file, config.success))
    if (enabled(config, 'silent-failure')) raw.push(...checkSilentFailure(file, config.silentFailure))
    collect(file, raw)
  }

  if (enabled(config, 'unreachable-capability') && config.reachability) {
    const result = checkReachability({ files, options: config.reachability })
    // The route config is the file the findings point INTO, so its own
    // suppression comments are the ones that govern them.
    if (result.routeFile) collect(result.routeFile, result.findings)
    else for (const finding of result.findings) findings.push(withoutFile(finding))
  }

  findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
  )

  return {
    ok: findings.length === 0,
    findings,
    suppressed,
    filesScanned: files.length,
    checksRun: LEGIBILITY_CHECKS.filter((check) => enabled(config, check)),
  }
}

/** A finding with no file behind it — only possible for `routePaths` input. */
function withoutFile(finding: RawFinding): LegibilityFinding {
  return {
    check: finding.check,
    file: '(routePaths)',
    line: 0,
    column: 0,
    message: finding.message,
    remedy: finding.remedy,
    evidence: finding.evidence,
  }
}
