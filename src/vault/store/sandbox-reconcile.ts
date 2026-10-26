/**
 * Reconciliation: commit what the box changed in its Vault directory back to
 * the workspace Vault. The box's manifest is diffed against the baseline of
 * its filesystem incarnation; a change commits only against the revision the
 * baseline recorded, so a concurrent Vault edit becomes a conflict with both
 * copies kept. A box can delete a Vault file only as part of a same-content
 * rename; every other durable delete belongs to the authenticated Vault API.
 */
import { isWorkspaceFileExportable } from '../../web/file-export'
import { sniffMime } from '../../web/mime'
import { readSandboxBinaryBytes, shellQuote, statSandboxFileSize, type SandboxExecChannel } from '../../sandbox/binary-read'
import { sha256Hex } from '../../crypto/digest'
import { validateVaultFilePath, vaultHeadKey, VaultStorageKeyError } from './paths'
import type { VaultMutationConflict, VaultSandboxBaseline } from './revisions'
import {
  buildSandboxVaultRenameUnits,
  groupSandboxVaultChanges,
  mapWithConcurrency,
  normalizeVaultSandboxBaseline,
  readReadySandboxFilesystemIncarnation,
  sandboxVaultRejection,
  vaultBinaryDocument,
  VAULT_SANDBOX_BASELINE_SCHEMA,
  VaultFilesystemIncarnationError,
  VaultHydrationError,
  VaultHydrationIncompleteError,
  type ReadySandboxFilesystemIncarnation,
  type SandboxVaultPathRejection,
  type SandboxVaultSyncChange,
  type SandboxVaultSyncConfig,
  type SandboxVaultSyncProgress,
} from './sandbox-sync'

/** The box calls reconciliation makes; a `@tangle-network/sandbox` instance satisfies it. */
export interface VaultReconcileBox extends SandboxExecChannel {
  id: string
  filesystemIncarnationId?: unknown
  filesystemIncarnationProvenance?: unknown
  filesystemIncarnationReadiness?: unknown
  read(path: string, options?: { sessionId?: string }): Promise<string>
}

const VAULT_IO_CONCURRENCY = 8
const VAULT_SYNC_GROUP_SIZE = 32
const VAULT_SYNC_MAX_GROUPS = 4
const INVALID_UTF8_SIDECAR_MESSAGE = 'File is not valid UTF-8; request base64 instead'

const vaultReconciliationTasks = new Map<string, Promise<SandboxVaultSyncResult>>()

export interface SandboxVaultSyncResult {
  succeeded: boolean
  complete: boolean
  rejectedPaths: SandboxVaultPathRejection[]
  binaryDriftPaths: string[]
  refusedDeletionPaths: string[]
  pathsMissingFromBox: string[]
  operationId: string | null
  changes: SandboxVaultSyncChange[]
  appliedPaths: string[]
  conflicts: VaultMutationConflict[]
  progress: SandboxVaultSyncProgress
  blockedReason?:
    | 'filesystem_incarnation_missing'
    | 'filesystem_incarnation_not_ready'
    | 'vault_directory_missing'
    | 'sandbox_deletion_denied'
  baselineResetReason?: 'baseline_missing' | 'filesystem_incarnation_changed'
}

/**
 * Fail the caller when reconciliation could not establish what the box holds,
 * and report a divergence it deliberately parked.
 *
 * A conflict is a steady state, not a failure: the box edit and the KV head
 * both survive, and the next hydration skips the path so neither overwrites the
 * other. It must not throw — the divergence persists until a human resolves it,
 * so throwing would fail every later turn on the workspace for as long as the
 * conflict stands. The log is the surfacing channel; `conflicts` on the result
 * is the structured one.
 */
export function assertSandboxVaultReconciliation(
  workspaceId: string,
  reconciliation: SandboxVaultSyncResult,
): void {
  if (!reconciliation.succeeded) {
    if (reconciliation.blockedReason === 'filesystem_incarnation_missing') {
      throw new VaultFilesystemIncarnationError(
        'vault.filesystem_incarnation_missing',
        'Sandbox filesystem incarnation identity is unavailable',
      )
    }
    if (reconciliation.blockedReason === 'filesystem_incarnation_not_ready') {
      throw new VaultFilesystemIncarnationError(
        'vault.filesystem_incarnation_not_ready',
        'Sandbox filesystem incarnation is not ready',
      )
    }
    const detail = reconciliation.rejectedPaths
      .map((rejection) => `${rejection.path}: ${rejection.message}`)
      .join('; ')
    throw new VaultHydrationError(
      `Sandbox Vault reconciliation failed for ${workspaceId}`,
      new Error(detail || 'reconciliation failed without a path diagnostic'),
    )
  }
  if (reconciliation.refusedDeletionPaths.length > 0) {
    console.error('[sandbox] sandbox Vault deletion refused; use the authenticated Vault API', {
      workspaceId,
      paths: reconciliation.refusedDeletionPaths,
    })
  }
  if (!reconciliation.complete) {
    throw new VaultHydrationIncompleteError(
      reconciliation.progress,
      'sandbox-to-KV reconciliation has more mutation groups to commit',
    )
  }
  if (reconciliation.conflicts.length > 0) {
    console.error('[sandbox] sandbox Vault edits diverged from their KV heads; both copies retained', {
      workspaceId,
      conflicts: reconciliation.conflicts.map((conflict) => ({
        path: conflict.path,
        expectedRevision: conflict.expectedRevision,
        currentRevision: conflict.currentRevision,
      })),
    })
  }
}

export interface SandboxVaultSyncOptions {
  sessionId?: string
  operationId?: string
  onStaged?: (checkpoint: {
    operationId: string
    changes: SandboxVaultSyncChange[]
  }) => Promise<void>
}

interface SandboxVaultManifestEntry {
  path: string
  contentHash: string
}

interface SandboxVaultManifestResult {
  entries: Map<string, SandboxVaultManifestEntry>
  rejectedPaths: SandboxVaultPathRejection[]
  directoryPresent: boolean
}

interface SandboxVaultFileSnapshot {
  content: string
  contentHash: string
  binary?: boolean
  onDiskHash?: string
}

interface SandboxVaultPendingChange {
  path: string
  kind: 'put' | 'delete'
  content?: string
  contentHash: string | null
  expectedRevision: string | null
}

function blockedSandboxVaultSync(
  root: string,
  error: VaultFilesystemIncarnationError | SandboxVaultPathRejection,
  reason: NonNullable<SandboxVaultSyncResult['blockedReason']>,
  totalPaths = 0,
): SandboxVaultSyncResult {
  const rejection = error instanceof VaultFilesystemIncarnationError
    ? sandboxVaultRejection(root, 'authority', error.code, error)
    : error
  return {
    succeeded: false,
    complete: false,
    rejectedPaths: [rejection],
    binaryDriftPaths: [],
    refusedDeletionPaths: [],
    pathsMissingFromBox: [],
    operationId: null,
    changes: [],
    appliedPaths: [],
    conflicts: [],
    progress: {
      phase: 'reconcile',
      processedPaths: 0,
      totalPaths,
      remainingPaths: totalPaths,
      committedGroups: 0,
    },
    blockedReason: reason,
  }
}

async function readSandboxVaultManifest(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  workspaceId: string,
  sessionId?: string,
): Promise<SandboxVaultManifestResult> {
  const command = `if [ ! -d ${shellQuote(config.root)} ]; then printf '%s' 'Sandbox Vault directory is missing' >&2; exit 42; fi; find ${shellQuote(config.root)} -name '.*' -prune -o -type f -exec sha256sum -z -- {} +`
  let listing: Awaited<ReturnType<VaultReconcileBox['exec']>>
  try {
    listing = sessionId
      ? await box.exec(command, { sessionId })
      : await box.exec(command)
  } catch (error) {
    throw new Error(`Failed to list sandbox Vault for ${workspaceId}`, { cause: error })
  }
  if (listing.exitCode === 42) {
    return {
      entries: new Map(),
      rejectedPaths: [sandboxVaultRejection(
        config.root,
        'manifest',
        'sandbox.vault_directory_missing',
        new Error(`Sandbox Vault directory is missing for ${workspaceId}`),
      )],
      directoryPresent: false,
    }
  }
  if (listing.exitCode !== 0) {
    throw new Error(`Failed to list sandbox Vault for ${workspaceId}: ${listing.stderr}`)
  }

  const rootPrefix = `${config.root}/`
  const entries = new Map<string, SandboxVaultManifestEntry>()
  const rejectedPaths: SandboxVaultPathRejection[] = []
  for (const record of listing.stdout.split('\0').filter(Boolean)) {
    const parsed = /^([a-f0-9]{64}) [ *]([\s\S]+)$/.exec(record)
    const absolutePath = parsed?.[2] ?? record
    const path = absolutePath.startsWith(rootPrefix)
      ? absolutePath.slice(rootPrefix.length)
      : absolutePath
    try {
      if (!parsed) throw new Error('Sandbox Vault manifest contains a malformed sha256sum record')
      if (!absolutePath.startsWith(rootPrefix)) {
        throw new Error('Sandbox Vault manifest path is outside the Vault root')
      }
      if (!isWorkspaceFileExportable(path)) continue
      validateVaultFilePath(path)
      vaultHeadKey(workspaceId, path)
      if (entries.has(path)) throw new Error('Sandbox Vault manifest contains a duplicate path')
      entries.set(path, { path, contentHash: parsed[1]! })
    } catch (error) {
      rejectedPaths.push(sandboxVaultRejection(
        path,
        'manifest',
        error instanceof VaultStorageKeyError ? error.code : 'sandbox.invalid_path',
        error,
      ))
    }
  }
  return { entries, rejectedPaths, directoryPresent: true }
}

function isInvalidUtf8Error(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { code?: unknown }).code === 'INVALID_UTF8') return true
  return error.message.includes(INVALID_UTF8_SIDECAR_MESSAGE)
}

async function readChangedSandboxBinaryFile(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  entry: SandboxVaultManifestEntry,
  sessionId?: string,
): Promise<SandboxVaultFileSnapshot> {
  const absolutePath = `${config.root}/${entry.path}`
  const stat = await statSandboxFileSize(box, absolutePath, { sessionId })
  if (!stat.succeeded) {
    throw new Error(`Failed to stat binary Vault file ${entry.path}: ${stat.error}`)
  }
  const read = await readSandboxBinaryBytes(box, absolutePath, stat.value, { sessionId })
  if (!read.succeeded) {
    throw new Error(`Failed to read binary Vault file ${entry.path}: ${read.error}`)
  }
  const { bytes, size } = read.value
  const onDiskHash = await sha256Hex(bytes)
  if (entry.contentHash !== onDiskHash) {
    throw new Error('Sandbox Vault file changed after its manifest was captured')
  }
  const filename = entry.path.split('/').pop() || entry.path
  const content = vaultBinaryDocument(config.vault.codec, {
    type: 'upload',
    created: new Date().toISOString().split('T')[0],
    originalName: filename,
    size,
    encoding: 'base64',
    mime: sniffMime(filename, config.fileTypes),
  }, bytesToBase64(bytes))
  return {
    content,
    contentHash: await sha256Hex(content),
    binary: true,
    onDiskHash,
  }
}

async function readChangedSandboxFile(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  entry: SandboxVaultManifestEntry,
  sessionId?: string,
): Promise<SandboxVaultFileSnapshot> {
  const absolutePath = `${config.root}/${entry.path}`
  let content: string
  try {
    content = sessionId
      ? await box.read(absolutePath, { sessionId })
      : await box.read(absolutePath)
  } catch (error) {
    if (isInvalidUtf8Error(error)) {
      return readChangedSandboxBinaryFile(config, box, entry, sessionId)
    }
    throw error
  }
  const contentHash = await sha256Hex(content)
  if (entry.contentHash !== contentHash) {
    throw new Error('Sandbox Vault file changed after its manifest was captured')
  }
  return { content, contentHash }
}

export async function reconcileSandboxVault(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  workspaceId: string,
  options: SandboxVaultSyncOptions = {},
): Promise<SandboxVaultSyncResult> {
  if (!box.id) throw new Error(`Cannot reconcile Vault for ${workspaceId}: sandbox id is missing`)
  const incarnation = readReadySandboxFilesystemIncarnation(box)
  if (!incarnation.succeeded) {
    const reason = incarnation.error.code === 'vault.filesystem_incarnation_missing'
      ? 'filesystem_incarnation_missing'
      : 'filesystem_incarnation_not_ready'
    return blockedSandboxVaultSync(config.root, incarnation.error, reason)
  }
  const reconciliationKey = [
    config.root,
    workspaceId,
    box.id,
    incarnation.value.id,
    options.sessionId ?? 'sandbox-root',
  ].join(':')
  const existingTask = vaultReconciliationTasks.get(reconciliationKey)
  if (existingTask) return existingTask

  const task = reconcileSandboxVaultFilesToKv(
    config,
    box,
    workspaceId,
    box.id,
    incarnation.value,
    options,
  )
  vaultReconciliationTasks.set(reconciliationKey, task)
  try {
    return await task
  } finally {
    if (vaultReconciliationTasks.get(reconciliationKey) === task) {
      vaultReconciliationTasks.delete(reconciliationKey)
    }
  }
}

async function reconcileSandboxVaultFilesToKv(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  workspaceId: string,
  sandboxId: string,
  incarnation: ReadySandboxFilesystemIncarnation,
  options: SandboxVaultSyncOptions,
): Promise<SandboxVaultSyncResult> {
  const storedBaseline = await config.vault.readVaultSandboxBaseline(workspaceId, sandboxId)
  const { baseline, legacy } = normalizeVaultSandboxBaseline(storedBaseline)
  if (!baseline
    || baseline.schema !== VAULT_SANDBOX_BASELINE_SCHEMA
    || baseline.filesystemIncarnationId !== incarnation.id) {
    return {
      succeeded: true,
      complete: true,
      rejectedPaths: [],
      binaryDriftPaths: [],
      refusedDeletionPaths: [],
      pathsMissingFromBox: [],
      operationId: options.operationId ?? null,
      changes: [],
      appliedPaths: [],
      conflicts: [],
      progress: {
        phase: 'reconcile',
        processedPaths: 0,
        totalPaths: 0,
        remainingPaths: 0,
        committedGroups: 0,
      },
      baselineResetReason: baseline
        ? 'filesystem_incarnation_changed'
        : 'baseline_missing',
    }
  }

  const manifest = await readSandboxVaultManifest(config, box, workspaceId, options.sessionId)
  if (!manifest.directoryPresent) {
    return blockedSandboxVaultSync(
      config.root,
      manifest.rejectedPaths[0]!,
      'vault_directory_missing',
      Object.keys(baseline.files).length,
    )
  }

  const liveBaselinePaths = Object.entries(baseline.files)
    .filter(([, file]) => !file.deleted)
    .map(([path]) => path)
  const wouldDeletePaths = liveBaselinePaths
    .filter((path) => !manifest.entries.has(path))
    .sort()
  // A missing box path can remove a KV head only as an atomic, same-content
  // rename. The authenticated Vault API owns all other durable deletes.
  const renameTargets = new Map<string, number>()
  for (const [path, entry] of manifest.entries) {
    const base = baseline.files[path]
    if (base && !base.deleted) continue
    renameTargets.set(entry.contentHash, (renameTargets.get(entry.contentHash) ?? 0) + 1)
  }
  const refusedDeletionPaths = wouldDeletePaths.filter((path) => {
    const hash = baseline.files[path]?.contentHash
    const available = hash ? renameTargets.get(hash) ?? 0 : 0
    if (available === 0) return true
    renameTargets.set(hash!, available - 1)
    return false
  })

  if (baseline.progress?.operation === 'hydrate') {
    return {
      succeeded: manifest.rejectedPaths.length === 0,
      complete: true,
      rejectedPaths: manifest.rejectedPaths,
      binaryDriftPaths: [],
      refusedDeletionPaths,
      pathsMissingFromBox: wouldDeletePaths,
      operationId: options.operationId ?? null,
      changes: [],
      appliedPaths: [],
      conflicts: [],
      progress: {
        phase: 'reconcile',
        processedPaths: 0,
        totalPaths: manifest.entries.size,
        remainingPaths: 0,
        committedGroups: 0,
      },
      ...(refusedDeletionPaths.length > 0
        ? { blockedReason: 'sandbox_deletion_denied' as const }
        : {}),
    }
  }

  const rejectedPaths = [...manifest.rejectedPaths]
  const binaryDriftPaths: string[] = []
  const candidatePaths = new Set<string>()
  for (const [path, entry] of manifest.entries) {
    const base = baseline.files[path]
    if (base?.binary) {
      if (entry.contentHash !== base.onDiskHash) binaryDriftPaths.push(path)
      continue
    }
    if (!base || base.deleted || base.contentHash !== entry.contentHash) {
      candidatePaths.add(path)
    }
  }
  for (const path of wouldDeletePaths) {
    if (!refusedDeletionPaths.includes(path)) candidatePaths.add(path)
  }

  const candidatePathList = [...candidatePaths]
  const candidateUnits = buildSandboxVaultRenameUnits(
    candidatePathList,
    (path) => {
      const base = baseline.files[path]
      const entry = manifest.entries.get(path)
      if ((!base || base.deleted) && entry) {
        return { path, kind: 'put', contentHash: entry.contentHash }
      }
      if (base && !base.deleted && !entry && base.contentHash) {
        return { path, kind: 'delete', contentHash: base.contentHash }
      }
      return { path, kind: null, contentHash: null }
    },
    [...candidatePathList].sort(),
  )
  const candidateBudget = VAULT_SYNC_GROUP_SIZE * VAULT_SYNC_MAX_GROUPS
  const selectedCandidatePaths: string[] = []
  for (const unit of candidateUnits) {
    if (
      selectedCandidatePaths.length > 0
      && selectedCandidatePaths.length + unit.length > candidateBudget
    ) {
      break
    }
    selectedCandidatePaths.push(...unit)
  }

  const snapshots = new Map<string, SandboxVaultFileSnapshot>()
  await mapWithConcurrency(
    selectedCandidatePaths.filter((path) => manifest.entries.has(path)),
    VAULT_IO_CONCURRENCY,
    async (path) => {
      const entry = manifest.entries.get(path)
      if (!entry) throw new Error(`Sandbox Vault manifest entry is missing for ${path}`)
      try {
        snapshots.set(path, await readChangedSandboxFile(config, box, entry, options.sessionId))
      } catch (error) {
        rejectedPaths.push(sandboxVaultRejection(
          path,
          'read',
          'sandbox.read_failed',
          error,
        ))
      }
    },
  )

  const readableCandidates = selectedCandidatePaths
    .filter((path) => !manifest.entries.has(path) || snapshots.has(path))
  const currentStates = new Map(await mapWithConcurrency(
    readableCandidates,
    VAULT_IO_CONCURRENCY,
    async (path) => [path, await config.vault.readVaultFileState(workspaceId, path)] as const,
  ))
  const changes: SandboxVaultPendingChange[] = []
  for (const path of readableCandidates.sort()) {
    const snapshot = snapshots.get(path)
    const current = currentStates.get(path)
    if (!current) throw new Error(`Vault state missing for ${path}`)
    const base = baseline.files[path]
    if (!base) {
      if (!snapshot || (!current.deleted && current.contentHash === snapshot.contentHash)) {
        continue
      }
      changes.push({
        path,
        kind: 'put',
        content: snapshot.content,
        contentHash: snapshot.contentHash,
        expectedRevision: null,
      })
      continue
    }
    if (snapshot) {
      if (!base.deleted && base.contentHash === snapshot.contentHash) continue
      changes.push({
        path,
        kind: 'put',
        content: snapshot.content,
        contentHash: snapshot.contentHash,
        expectedRevision: base.revision,
      })
    } else if (!base.deleted) {
      changes.push({
        path,
        kind: 'delete',
        contentHash: base.contentHash,
        expectedRevision: base.revision,
      })
    }
  }

  const pendingPutsByHash = new Map<string, number>()
  for (const change of changes) {
    if (change.kind !== 'put' || !change.contentHash) continue
    pendingPutsByHash.set(change.contentHash, (pendingPutsByHash.get(change.contentHash) ?? 0) + 1)
  }
  const authorizedChanges = changes.filter((change) => {
    if (change.kind !== 'delete') return true
    const hash = change.contentHash
    const available = hash ? pendingPutsByHash.get(hash) ?? 0 : 0
    if (!hash || available === 0) {
      refusedDeletionPaths.push(change.path)
      return false
    }
    pendingPutsByHash.set(hash, available - 1)
    return true
  })
  refusedDeletionPaths.sort()
  const groups = groupSandboxVaultChanges(authorizedChanges, VAULT_SYNC_GROUP_SIZE)
  const groupsToCommit = groups.slice(0, VAULT_SYNC_MAX_GROUPS)
  const stagedChanges = groupsToCommit.flat().map((change): SandboxVaultSyncChange => ({
    path: change.path,
    kind: change.kind,
    expectedRevision: change.expectedRevision,
    contentHash: change.kind === 'put' ? change.contentHash : null,
  }))
  const stagedFingerprint = await sha256Hex(JSON.stringify(stagedChanges))
  const operationId = options.operationId
    ?? (stagedChanges.length > 0 ? `sandbox:${sandboxId}:${stagedFingerprint}` : null)
  if (operationId && options.onStaged) {
    await options.onStaged({ operationId, changes: stagedChanges })
  }

  const appliedPaths: string[] = []
  const appliedFiles: Array<{
    path: string
    revision: string
    contentHash: string | null
    deleted: boolean
  }> = []
  const conflicts: VaultMutationConflict[] = []
  for (const group of groupsToCommit) {
    const fingerprint = await sha256Hex(JSON.stringify(group.map((change) => ({
      path: change.path,
      kind: change.kind,
      expectedRevision: change.expectedRevision,
      contentHash: change.contentHash,
    }))))
    try {
      const result = await config.vault.commitVaultMutation({
        workspaceId,
        operationId: options.operationId
          ? `${options.operationId}:${fingerprint}`
          : `sandbox:${sandboxId}:${fingerprint}`,
        writer: { kind: 'sandbox', id: sandboxId },
        changes: group.map(({ contentHash: _contentHash, ...change }) => change),
      })
      if (result.status === 'applied') {
        appliedFiles.push(...result.files)
        appliedPaths.push(...result.files.map((file) => file.path))
      } else {
        conflicts.push(...result.conflicts)
      }
    } catch (error) {
      for (const change of group) {
        rejectedPaths.push(sandboxVaultRejection(
          change.path,
          'commit',
          'vault.commit_failed',
          error,
        ))
      }
    }
  }

  if (appliedFiles.length > 0 || binaryDriftPaths.length > 0) {
    const baselineFiles: VaultSandboxBaseline['files'] = legacy
      ? Object.fromEntries(Object.entries(baseline.files).map(([path, file]) => [
          path,
          file.deleted ? file : { ...file, revision: null },
        ]))
      : { ...baseline.files }
    for (const file of appliedFiles) {
      const snapshot = snapshots.get(file.path)
      baselineFiles[file.path] = snapshot?.binary
        ? {
            revision: file.revision,
            contentHash: file.contentHash,
            deleted: file.deleted,
            binary: true,
            onDiskHash: snapshot.onDiskHash ?? null,
          }
        : {
            revision: file.revision,
            contentHash: file.contentHash,
            deleted: file.deleted,
          }
    }
    for (const path of binaryDriftPaths) {
      baselineFiles[path] = {
        revision: null,
        contentHash: null,
        deleted: false,
        binary: true,
        onDiskHash: null,
      }
    }
    await config.vault.writeVaultSandboxBaseline({
      schema: VAULT_SANDBOX_BASELINE_SCHEMA,
      workspaceId,
      sandboxId,
      filesystemIncarnationId: incarnation.id,
      files: baselineFiles,
      updatedAt: new Date().toISOString(),
    })
  }

  const processedPaths = selectedCandidatePaths.length
  const remainingPaths = candidatePaths.size - processedPaths
  return {
    succeeded: rejectedPaths.length === 0,
    complete: remainingPaths === 0,
    rejectedPaths,
    binaryDriftPaths,
    refusedDeletionPaths,
    pathsMissingFromBox: wouldDeletePaths,
    ...(refusedDeletionPaths.length > 0
      ? { blockedReason: 'sandbox_deletion_denied' as const }
      : {}),
    operationId,
    changes: stagedChanges,
    appliedPaths,
    conflicts,
    progress: {
      phase: 'reconcile',
      processedPaths,
      totalPaths: candidatePaths.size,
      remainingPaths,
      committedGroups: groupsToCommit.length,
    },
  }
}

/**
 * The live baseline paths when the box's Vault directory holds no file at all:
 * a box that lost its disk would otherwise read as a member deleting every
 * file. Empty when the box still has files or the baseline is not this box's.
 */
export async function probeSandboxVaultLoss(
  config: SandboxVaultSyncConfig,
  box: VaultReconcileBox,
  workspaceId: string,
): Promise<string[]> {
  if (!box.id) return []
  const incarnation = readReadySandboxFilesystemIncarnation(box)
  if (!incarnation.succeeded) return []
  const { baseline } = normalizeVaultSandboxBaseline(
    await config.vault.readVaultSandboxBaseline(workspaceId, box.id),
  )
  if (
    !baseline
    || baseline.schema !== VAULT_SANDBOX_BASELINE_SCHEMA
    || baseline.filesystemIncarnationId !== incarnation.value.id
  ) {
    return []
  }
  const livePaths = Object.entries(baseline.files)
    .filter(([, file]) => !file.deleted)
    .map(([path]) => path)
  if (livePaths.length === 0) return []
  try {
    const result = await box.exec(
      `find ${shellQuote(config.root)} -type f -print -quit 2>/dev/null`,
    )
    if (result.stdout.trim().length > 0) return []
  } catch {
    return []
  }
  return livePaths
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
