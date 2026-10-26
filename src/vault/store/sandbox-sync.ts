/**
 * Shared vocabulary and mechanics of syncing a sandbox's Vault copy with KV:
 * the baseline schema, the typed failures a sync reports, the filesystem
 * incarnation a baseline is bound to, how changed paths are grouped into
 * mutation batches so a rename (a delete and a put of the same bytes) always
 * commits together, and the configuration the sync engine
 * (`createSandboxVaultSync`) runs with.
 */
import { isWorkspaceFileExportable } from '../../web/file-export'
import { compareIncarnationBaseline, type FilesystemIncarnationLike } from '../server'
import type {
  VaultHeadState,
  VaultMutationRequest,
  VaultMutationResult,
  VaultSandboxBaseline,
} from './revisions'
import type { VaultFrontmatterCodec, VaultHeadListOptions, VaultHeadListPage } from './store'
import type { VaultBoxStateView, VaultBoxSyncRecord } from './box-state'

/** The store calls the sync engine makes; `createVaultStore` returns all of them. */
export interface SandboxVaultSyncStore {
  codec: VaultFrontmatterCodec
  listVaultHeadPage(workspaceId: string, options?: VaultHeadListOptions): Promise<VaultHeadListPage>
  readVaultFileState(workspaceId: string, filePath: string): Promise<VaultHeadState>
  commitVaultMutation(request: VaultMutationRequest): Promise<VaultMutationResult>
  readVaultSandboxBaseline(workspaceId: string, sandboxId: string): Promise<VaultSandboxBaseline | null>
  writeVaultSandboxBaseline(baseline: VaultSandboxBaseline): Promise<void>
  readVaultBoxState(workspaceId: string): Promise<VaultBoxStateView | null>
  recordVaultBoxSync(workspaceId: string, record: VaultBoxSyncRecord): Promise<void>
  invalidateVaultBoxSync(workspaceId: string): Promise<void>
}

export interface SandboxVaultSyncConfig {
  /** The product's Vault store, bound for this request. */
  vault: SandboxVaultSyncStore
  /** Absolute box directory that holds the workspace's Vault files, such as `/home/agent/vault`. */
  root: string
  /**
   * The box directory a stored baseline without `mirrorRoot` describes, for a
   * product that moved its Vault directory (default: `root`). Reconciliation
   * reads the directory a baseline describes; hydration trusts only a baseline
   * of `root`.
   */
  legacyRoot?: string
  /**
   * How a file missing from the box reaches the Vault. `rename-only` (default)
   * commits a box delete only as half of a same-content rename; every other
   * delete goes through the Vault API. `guarded` commits box deletes unless one
   * scan would remove most of the baseline (agent-app's deletion guard).
   */
  deletes?: 'rename-only' | 'guarded'
  /** Extension to MIME type overrides for binary files the box produces (agent-app's `sniffMime` defaults otherwise). */
  fileTypes?: Readonly<Record<string, string>>
  /**
   * Names what hydration writes. A recorded sync is trusted only under the same
   * contract, so a release that changes what lands on the box bumps it and every
   * box re-hydrates on its next turn. Defaults to `SANDBOX_VAULT_SYNC_CONTRACT`.
   */
  contract?: string
}

/** The engine's own hydration contract; a product appends its own when its box layout changes. */
export const SANDBOX_VAULT_SYNC_CONTRACT = 'agent-app-sandbox-vault-sync-v1'

/** The body prefix of a Vault document whose remainder is base64-encoded binary bytes. */
export const VAULT_BASE64_BODY_MARKER = '[base64]\n'

/** The base64 payload of a Vault document that stores a binary file, or null for a text document. */
export function vaultBinaryPayload(codec: VaultFrontmatterCodec, raw: string): string | null {
  const parsed = codec.parse(raw)
  if (!parsed.succeeded || parsed.frontmatter.encoding !== 'base64' || !parsed.body.startsWith(VAULT_BASE64_BODY_MARKER)) {
    return null
  }
  return parsed.body.slice(VAULT_BASE64_BODY_MARKER.length).trim()
}

/** The Vault document that stores a binary file the box produced: the product's frontmatter plus the base64 body. */
export function vaultBinaryDocument(codec: VaultFrontmatterCodec, fields: Record<string, unknown>, base64: string): string {
  return codec.serialize({ ...fields, encoding: 'base64' }, `${VAULT_BASE64_BODY_MARKER}${base64}`)
}

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

/** A baseline without `mirrorRoot` describes the product's `legacyRoot`, else its `root`. */
export function baselineDescribesRoot(baseline: VaultSandboxBaseline, root: string, legacyRoot?: string): boolean {
  return (baseline.mirrorRoot ?? legacyRoot ?? root) === root
}
