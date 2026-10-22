/**
 * Shared vocabulary and mechanics of syncing a sandbox's Vault copy with KV:
 * the baseline schema, the typed failures a sync reports, the filesystem
 * incarnation a baseline is bound to, and how changed paths are grouped into
 * mutation batches so a rename (a delete and a put of the same bytes) always
 * commits together. Products own the scan, the reads and the hydration walk.
 */
import { isWorkspaceFileExportable } from '../../web/file-export'
import { compareIncarnationBaseline, type FilesystemIncarnationLike } from '../server'
import type { VaultSandboxBaseline } from './revisions'

export const VAULT_SANDBOX_BASELINE_SCHEMA = 'vault-sandbox-baseline-v3' as const
const VAULT_SANDBOX_BASELINE_V2_SCHEMA = 'vault-sandbox-baseline-v2'
const VAULT_SANDBOX_BASELINE_V1_SCHEMA = 'vault-sandbox-baseline-v1'

export interface NormalizedVaultSandboxBaseline {
  baseline: VaultSandboxBaseline | null
  /** True when the stored blob used the v1 or v2 schema. Its file entries remain
   *  valid text baselines, but they carry no binary/onDiskHash metadata, so
   *  hydration must rewrite every head to materialize binary attachments as
   *  decoded bytes. v1 pagination progress is dropped so hydration restarts
   *  from the first page. */
  legacy: boolean
}

/** A stored baseline in the current schema, with entries outside the workspace export boundary dropped. */
export function normalizeVaultSandboxBaseline(stored: VaultSandboxBaseline | null): NormalizedVaultSandboxBaseline {
  if (!stored) return { baseline: null, legacy: false }
  stored = { ...stored, files: Object.fromEntries(Object.entries(stored.files).filter(([path]) => isWorkspaceFileExportable(path))) }
  const schema: string = stored.schema
  if (schema === VAULT_SANDBOX_BASELINE_SCHEMA) return { baseline: stored, legacy: false }
  if (schema === VAULT_SANDBOX_BASELINE_V2_SCHEMA) return { baseline: stored, legacy: true }
  if (schema === VAULT_SANDBOX_BASELINE_V1_SCHEMA) {
    const { progress: _progress, ...rest } = stored
    return { baseline: { ...rest, schema: VAULT_SANDBOX_BASELINE_V2_SCHEMA }, legacy: true }
  }
  return { baseline: null, legacy: false }
}

export interface SandboxVaultSyncProgress {
  phase: 'reconcile' | 'hydrate'
  processedPaths: number
  totalPaths: number | null
  remainingPaths: number | null
  committedGroups: number
}

export interface SandboxVaultPathRejection {
  path: string
  stage: 'authority' | 'manifest' | 'read' | 'commit'
  code: string
  message: string
}

export interface SandboxVaultSyncChange {
  path: string
  kind: 'put' | 'delete'
  contentHash: string | null
  expectedRevision: string | null
}

export function sandboxVaultRejection(
  path: string,
  stage: SandboxVaultPathRejection['stage'],
  code: string,
  error: unknown,
): SandboxVaultPathRejection {
  return {
    path,
    stage,
    code,
    message: error instanceof Error ? error.message : String(error),
  }
}

export class VaultHydrationError extends Error {
  readonly code = 'vault.hydration_failed'

  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'VaultHydrationError'
  }
}

export class VaultHydrationIncompleteError extends Error {
  readonly code = 'vault.hydration_incomplete'
  readonly retryable = true
  readonly progress: SandboxVaultSyncProgress

  constructor(progress: SandboxVaultSyncProgress, detail?: string) {
    super(`Vault hydration is incomplete (${progress.processedPaths} heads processed)${detail ? `: ${detail}` : ''}`)
    this.name = 'VaultHydrationIncompleteError'
    this.progress = progress
  }
}

export class VaultFilesystemIncarnationError extends Error {
  readonly code: 'vault.filesystem_incarnation_missing' | 'vault.filesystem_incarnation_not_ready'
  readonly retryable = true

  constructor(
    code: VaultFilesystemIncarnationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'VaultFilesystemIncarnationError'
    this.code = code
  }
}

export interface ReadySandboxFilesystemIncarnation {
  id: string
  provenance: 'fresh' | 'restored' | 'unknown'
}

/** The box's filesystem incarnation, or the typed reason a sync must not trust it yet. */
export function readReadySandboxFilesystemIncarnation(
  box: object,
): { succeeded: true; value: ReadySandboxFilesystemIncarnation } | {
  succeeded: false
  error: VaultFilesystemIncarnationError
} {
  const candidate = box as FilesystemIncarnationLike
  const comparison = compareIncarnationBaseline(undefined, candidate)
  if (comparison.verdict === 'unidentified') {
    return {
      succeeded: false,
      error: new VaultFilesystemIncarnationError(
        'vault.filesystem_incarnation_missing',
        'Sandbox filesystem incarnation identity is unavailable',
      ),
    }
  }
  if (comparison.verdict === 'not-ready') {
    return {
      succeeded: false,
      error: new VaultFilesystemIncarnationError(
        'vault.filesystem_incarnation_not_ready',
        `Sandbox filesystem incarnation ${candidate.filesystemIncarnationId} is ${String(comparison.readiness ?? 'not ready')}`,
      ),
    }
  }
  if (comparison.verdict !== 'no-baseline') {
    throw new Error(`Unexpected filesystem incarnation comparison verdict: ${comparison.verdict}`)
  }
  return {
    succeeded: true,
    value: {
      id: candidate.filesystemIncarnationId!,
      provenance: candidate.filesystemIncarnationProvenance!,
    },
  }
}

export interface SandboxVaultRenameItem {
  path: string
  kind: 'put' | 'delete' | null
  contentHash: string | null
}

/**
 * Units of work in path order: a delete paired with a put of the same content
 * (a rename) forms one two-item unit, everything else is a unit of one.
 */
export function buildSandboxVaultRenameUnits<T>(
  items: T[],
  describe: (item: T) => SandboxVaultRenameItem,
  orderedItems = items,
): T[][] {
  const putsByHash = new Map<string, T[]>()
  for (const item of items) {
    const candidate = describe(item)
    if (candidate.kind !== 'put' || candidate.contentHash === null) continue
    const puts = putsByHash.get(candidate.contentHash) ?? []
    puts.push(item)
    putsByHash.set(candidate.contentHash, puts)
  }
  const paired = new Set<T>()
  const units: T[][] = []
  for (const deletion of orderedItems) {
    const candidate = describe(deletion)
    if (candidate.kind !== 'delete' || candidate.contentHash === null) continue
    const destination = putsByHash.get(candidate.contentHash)?.find((put) => !paired.has(put))
    if (!destination) continue
    paired.add(deletion)
    paired.add(destination)
    units.push([deletion, destination].sort((left, right) => describe(left).path.localeCompare(describe(right).path)))
  }
  for (const item of orderedItems) if (!paired.has(item)) units.push([item])
  units.sort((left, right) => describe(left[0]!).path.localeCompare(describe(right[0]!).path))
  return units
}

/** Changes packed into mutation groups of at most `groupSize`, never splitting a rename. */
export function groupSandboxVaultChanges<T extends SandboxVaultRenameItem>(changes: T[], groupSize: number): T[][] {
  const units = buildSandboxVaultRenameUnits(changes, (change) => change)
  const groups: T[][] = []
  let current: T[] = []
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > groupSize) {
      groups.push(current)
      current = []
    }
    current.push(...unit)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Map `values` with at most `concurrency` mappers in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
