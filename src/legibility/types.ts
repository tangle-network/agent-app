/**
 * The vocabulary of the legibility gate: what a finding is, what a suppression
 * is, and what a product configures.
 *
 * Kept in its own module so the checks, the report formatter and the bin all
 * agree on one shape, and so a consumer can import the types without pulling in
 * `node:fs`.
 */

/** The checks this gate runs. Each is individually suppressible, by name. */
export type LegibilityCheckId =
  /** Words on screen that belong to the codebase, not to the reader. */
  | 'engineering-vocabulary'
  /** An empty/zero state whose subtree offers no next action. */
  | 'dead-end-empty-state'
  /** A success state set without inspecting the response that would deny it. */
  | 'unchecked-success'
  /** A `catch` that neither surfaces the failure nor rethrows it. */
  | 'silent-failure'
  /** A route no navigation entry and no in-source link can reach. */
  | 'unreachable-capability'
  /** A suppression comment that names a check but gives no reason. */
  | 'suppression-without-reason'

export const LEGIBILITY_CHECKS: readonly LegibilityCheckId[] = [
  'engineering-vocabulary',
  'dead-end-empty-state',
  'unchecked-success',
  'silent-failure',
  'unreachable-capability',
  'suppression-without-reason',
]

/** One defect, at one place, with the fix named. */
export interface LegibilityFinding {
  readonly check: LegibilityCheckId
  /** Path as reported — relative to the working directory when it is inside it. */
  readonly file: string
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
  /** What is wrong, in one sentence a reviewer can act on. */
  readonly message: string
  /** What to do about it. Every finding carries one; a finding without a fix is a complaint. */
  readonly remedy: string
  /** The offending source, trimmed to one readable line. */
  readonly evidence: string
}

/** A suppression that was honoured, with the reason its author wrote. */
export interface LegibilitySuppression {
  readonly check: LegibilityCheckId
  readonly reason: string
  readonly file: string
  readonly line: number
}

export interface LegibilityReport {
  readonly ok: boolean
  readonly findings: readonly LegibilityFinding[]
  /** Honoured suppressions — printed, never silent. */
  readonly suppressed: readonly LegibilitySuppression[]
  readonly filesScanned: number
  readonly checksRun: readonly LegibilityCheckId[]
}

/** A banned term plus the sentence that replaces it. */
export interface BannedTerm {
  /** Matched case-insensitively at word boundaries against visible copy. */
  readonly term: string
  /** What to write instead — printed with the finding. */
  readonly instead: string
}

export interface VocabularyOptions {
  /** Replaces the default list outright. */
  readonly terms?: readonly BannedTerm[]
  /** Added to the default list — the common case for a product's own jargon. */
  readonly extraTerms?: readonly BannedTerm[]
  /** Removed from the default list, for a word that is genuinely the reader's. */
  readonly allowTerms?: readonly string[]
  /**
   * Additional JSX attributes / object keys whose string value is user-visible
   * copy (the defaults cover `title`, `label`, `placeholder`, `empty*`, …).
   */
  readonly extraCopyKeys?: readonly string[]
  /**
   * Additional call names whose first string argument is user-visible copy
   * (defaults cover `toast*`, `alert`, `setError`, `new Error`).
   */
  readonly extraCopyCalls?: readonly string[]
  /**
   * Also read strings filling an object key named like copy
   * (`description: '…'`). OFF by default: measured as the tier that reports
   * system prompts, MCP tool descriptions and document templates — text no
   * reader ever sees. Turn it on when your data modules really do hold UI copy.
   */
  readonly includeObjectCopy?: boolean
}

export interface EmptyStateOptions {
  /** Extra tags that count as an action (defaults: button, a, input, form, *Button, *Link, …). */
  readonly extraActionTags?: readonly string[]
  /** Extra props that count as an action (defaults: onClick, onSubmit, href, to, action, …). */
  readonly extraActionProps?: readonly string[]
  /** Extra regexes (as source strings) that identify empty-state copy. */
  readonly extraEmptyPatterns?: readonly string[]
  /**
   * Also report a zero-state that sits directly under a heading. OFF by
   * default: measured as the largest false-positive class — a titled section
   * with nothing in it labels a screen the reader is already oriented on, and a
   * detail page carrying four of them buries the one screen that is entirely
   * empty.
   */
  readonly reportSectionZeroStates?: boolean
}

export interface SuccessOptions {
  /**
   * Callees that resolve on a failed request instead of throwing. `fetch` is the
   * default and the reason this check exists; add your own thin wrapper here.
   */
  readonly httpCalls?: readonly string[]
  /** Extra identifiers that mean "the user has been told it worked". */
  readonly extraSuccessSignals?: readonly string[]
  /**
   * Calls that inspect a response and throw on a bad status
   * (`assertOk(res)`). Their presence in the same function counts as checking.
   */
  readonly okGuards?: readonly string[]
}

export interface SilentFailureOptions {
  /** Extra identifiers that count as surfacing a failure to the user. */
  readonly extraErrorSinks?: readonly string[]
  /**
   * Path substrings whose modules cannot reach a browser, and whose handlers
   * are therefore not this check's business. Defaults to react-router's
   * server-only conventions (`/.server/`, `/routes/api.`); pass `[]` to read
   * every module, at the measured cost of a large false-positive class
   * (best-effort telemetry, audit writes and cache fallbacks).
   */
  readonly readerlessPaths?: readonly string[]
}

export interface ReachabilityOptions {
  /**
   * A react-router `routes.ts` (the `@react-router/dev/routes` shape:
   * `route()` / `index()` / `layout()` / `prefix()`).
   */
  readonly routeConfigFile?: string
  /** Route paths supplied directly, for a product on another router. */
  readonly routePaths?: readonly string[]
  /** Files that define navigation. Their path literals are the nav entries. */
  readonly navFiles?: readonly string[]
  /** Route paths (or prefixes ending in `/*`) that need no door — defaults to `api/*`. */
  readonly ignore?: readonly string[]
  /**
   * Treat a route whose module is not a `.tsx` file as a resource endpoint
   * rather than a screen. Default true — react-router resource routes are `.ts`.
   */
  readonly ignoreNonTsxRoutes?: boolean
}

/** What a product writes in `legibility.config.mjs`. */
export interface LegibilityConfig {
  /** Source directories to scan, recursively. At least one. */
  readonly srcDirs: readonly string[]
  /** Turn a check off wholesale. Prefer a per-line suppression with a reason. */
  readonly checks?: Partial<Record<LegibilityCheckId, boolean>>
  readonly vocabulary?: VocabularyOptions
  readonly emptyState?: EmptyStateOptions
  readonly success?: SuccessOptions
  readonly silentFailure?: SilentFailureOptions
  readonly reachability?: ReachabilityOptions
  /** Path substrings to skip, added to the defaults (tests, fixtures, generated). */
  readonly ignorePaths?: readonly string[]
}

/** A finding before file/line resolution — what a check returns. */
export interface RawFinding {
  readonly check: LegibilityCheckId
  readonly offset: number
  readonly message: string
  readonly remedy: string
  readonly evidence: string
}
