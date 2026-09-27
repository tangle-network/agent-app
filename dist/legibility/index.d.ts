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
import { type LegibilityConfig, type LegibilityReport } from './types';
export { LEGIBILITY_CHECKS } from './types';
export type { BannedTerm, EmptyStateOptions, LegibilityCheckId, LegibilityConfig, LegibilityFinding, LegibilityReport, LegibilitySuppression, ReachabilityOptions, SilentFailureOptions, SuccessOptions, VocabularyOptions, } from './types';
export { formatLegibilityReport, legibilityReportToJson, type FormatOptions } from './report';
export { DEFAULT_BANNED_TERMS, COPY_KEYS, COPY_CALLS } from './checks/vocabulary';
export { READERLESS_PATHS } from './checks/silent-failure';
export { parseRouteConfig, staticSegments, type RouteEntry } from './checks/reachability';
export { scanSources, scanFile, buildScannedFile, type ScannedFile } from './scan';
export { scanSource, type JsxAttribute, type JsxElement, type ScannedSource, type SegmentKind, type SourceSegment, } from './source';
/**
 * Run the gate over a product's source.
 *
 * Pure of process state apart from reading files: no `process.exit`, no logging.
 * The bin decides what to do with the report; a product embedding this in its
 * own tooling decides something else.
 */
export declare function checkLegibility(config: LegibilityConfig): LegibilityReport;
