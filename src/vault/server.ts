/**
 * Server-only policy sibling of the React `./vault` client surface. Pure
 * decision logic — no I/O, no logging, ZERO imports — extracted from
 * gtm-agent's local guard (gtm#612) after it lost 48 production vault files:
 * a half-mounted sandbox scanned cleanly and reconciliation derived a
 * mass-deletion batch from an empty manifest. The #265/#332 audit ruled both
 * checks here universal shell mechanism, not gtm-specific, so they live here
 * once instead of being re-forked per product.
 *
 * Two independent checks:
 *  - `assessVaultDeletionBatch` — blast-radius refusal. Given the live
 *    baseline and what a reconciliation pass proposes to delete, decide
 *    whether the batch is safe to apply or must be refused. Refusal is a
 *    SUCCESSFUL outcome, not a thrown error: content changes still apply,
 *    only the deletions are withheld. What to do with a refusal (log, alert,
 *    retry the scan) stays the caller's job.
 *  - `compareIncarnationBaseline` — filesystem-incarnation comparison. Given
 *    a recorded baseline incarnation id and the sandbox's current identity
 *    fields, decide whether the sandbox filesystem is the same one the
 *    baseline was captured against, fail-closed on anything not clearly
 *    identified and ready.
 *
 * Both are pure functions over caller-supplied data: no manifest reads, no
 * sandbox calls, no console output. The caller pre-filters tombstoned
 * entries (this module only ever sees the LIVE path set) and owns everything
 * that happens after a verdict comes back.
 */

/** Refuse a deletion batch once it would remove at least this fraction of the
 *  live baseline (both this and `VAULT_DELETION_REFUSAL_MIN_LIVE_FILES` must
 *  hold — a tiny vault can lose all its files without tripping this ratio
 *  gate; `refusesAllFiles` catches that case separately). */
export const VAULT_DELETION_REFUSAL_RATIO = 0.75

/** The blast-radius ratio gate only engages once the live baseline is at
 *  least this large, so a 2-file vault losing 1 file (50%) is not refused on
 *  ratio alone. */
export const VAULT_DELETION_REFUSAL_MIN_LIVE_FILES = 10

/** Overrides for `assessVaultDeletionBatch`'s two thresholds. Both default to
 *  the exported constants above. */
export interface VaultDeletionPolicy {
  refusalRatio?: number
  minLiveFiles?: number
}

export interface VaultDeletionAssessment {
  /** True when no refusal reason fired. */
  allowed: boolean
  /** Precedence when multiple reasons would fire: `empty-manifest` beats
   *  `all-files` beats `ratio-exceeded` (most specific first — an empty scan
   *  IS an all-files deletion, but the diagnostic that matters is "the scan
   *  came back empty", not "it deleted everything"). Undefined when allowed. */
  reason?: 'empty-manifest' | 'all-files' | 'ratio-exceeded'
  /** wouldDelete / baselineLive, or 0 when the baseline is itself empty. */
  deletionRatio: number
  wouldDelete: number
  /** The paths that would be deleted, sorted — mirrors gtm's `.sort()` so log
   *  output and any snapshot fixture are byte-stable. */
  wouldDeletePaths: string[]
  baselineLive: number
}

/**
 * Decide whether a reconciliation pass's proposed deletions are safe to
 * apply against the live baseline.
 *
 * `manifestEmpty: true` means the filesystem scan that produced
 * `proposedDeletions` came back with nothing — the caller could not have
 * derived a meaningful proposed-deletions list, so this treats the FULL live
 * baseline as would-delete regardless of what `proposedDeletions` contains.
 * That is what distinguishes `'empty-manifest'` from `'all-files'`: an empty
 * scan structurally implies every baseline path would be deleted, but the
 * diagnostic that matters to a caller is "the scan was empty", not merely
 * "everything would go".
 */
export function assessVaultDeletionBatch(input: {
  /** LIVE (non-tombstoned) baseline path set — the caller pre-filters, as gtm does. */
  baselinePaths: readonly string[]
  /** Paths a reconciliation pass proposes to delete; intersected with `baselinePaths` internally. */
  proposedDeletions: readonly string[]
  manifestEmpty?: boolean
  policy?: VaultDeletionPolicy
}): VaultDeletionAssessment {
  const refusalRatio = input.policy?.refusalRatio ?? VAULT_DELETION_REFUSAL_RATIO
  const minLiveFiles = input.policy?.minLiveFiles ?? VAULT_DELETION_REFUSAL_MIN_LIVE_FILES
  const manifestEmpty = input.manifestEmpty ?? false

  const baselineLive = input.baselinePaths.length
  const proposedSet = new Set(input.proposedDeletions)
  const wouldDeletePaths = manifestEmpty
    ? [...input.baselinePaths].sort()
    : input.baselinePaths.filter((p) => proposedSet.has(p)).sort()
  const wouldDelete = wouldDeletePaths.length
  const deletionRatio = baselineLive > 0 ? wouldDelete / baselineLive : 0

  const refusesEmptyManifest = manifestEmpty && baselineLive > 0
  const refusesAllFiles = wouldDelete > 0 && wouldDelete === baselineLive
  const refusesBlastRadius = baselineLive >= minLiveFiles && deletionRatio >= refusalRatio

  const reason = refusesEmptyManifest
    ? ('empty-manifest' as const)
    : refusesAllFiles
      ? ('all-files' as const)
      : refusesBlastRadius
        ? ('ratio-exceeded' as const)
        : undefined

  return {
    allowed: reason === undefined,
    reason,
    deletionRatio,
    wouldDelete,
    wouldDeletePaths,
    baselineLive,
  }
}

/** The subset of a sandbox's filesystem-incarnation identity this module
 *  needs. A product's real incarnation type is structurally compatible —
 *  no import required. */
export interface FilesystemIncarnationLike {
  filesystemIncarnationId?: string
  filesystemIncarnationProvenance?: 'fresh' | 'restored' | 'unknown'
  filesystemIncarnationReadiness?: 'transitioning' | 'ready'
}

/**
 * Result of comparing a recorded baseline incarnation id against the
 * sandbox's current identity. A discriminated union over `verdict` so a
 * caller's `switch` gets compile-time coverage instead of a stringly-typed
 * status it can forget to branch on.
 */
export type IncarnationComparison =
  | { verdict: 'match' }
  | { verdict: 'mismatch'; baselineId: string; currentId: string }
  | { verdict: 'not-ready'; readiness: string | undefined }
  | { verdict: 'unidentified' }
  | { verdict: 'no-baseline' }

/**
 * Compare a recorded baseline filesystem-incarnation id against a sandbox's
 * current incarnation fields. Check order mirrors gtm's gate sequence and is
 * itself a tested fail-closed property — each earlier check short-circuits
 * the ones after it, so a box with BOTH bad readiness and a mismatched id
 * resolves `'not-ready'`, never `'mismatch'`:
 *
 *  1. `unidentified` — the current id is missing/empty, or the provenance is
 *     not one of `fresh`/`restored`/`unknown`.
 *  2. `not-ready` — readiness is anything other than the literal string
 *     `'ready'` (this also catches `undefined`).
 *  3. `no-baseline` — no baseline id was ever recorded to compare against.
 *  4. `mismatch` — the baseline id and current id disagree.
 *  5. `match` — same incarnation.
 */
export function compareIncarnationBaseline(
  baselineId: string | undefined,
  current: FilesystemIncarnationLike,
): IncarnationComparison {
  const currentId = current.filesystemIncarnationId
  const provenance = current.filesystemIncarnationProvenance
  const isValidProvenance = provenance === 'fresh' || provenance === 'restored' || provenance === 'unknown'

  if (typeof currentId !== 'string' || currentId.length === 0 || !isValidProvenance) {
    return { verdict: 'unidentified' }
  }

  if (current.filesystemIncarnationReadiness !== 'ready') {
    return { verdict: 'not-ready', readiness: current.filesystemIncarnationReadiness }
  }

  if (baselineId === undefined) {
    return { verdict: 'no-baseline' }
  }

  if (baselineId !== currentId) {
    return { verdict: 'mismatch', baselineId, currentId }
  }

  return { verdict: 'match' }
}
