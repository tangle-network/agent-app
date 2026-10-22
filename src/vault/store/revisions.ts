/**
 * The Vault's revision model over a KV store: one head key per path, one
 * immutable revision record per write (committed or conflicting), and an
 * operation record that makes a multi-path batch visible all at once.
 *
 * `applyVaultMutationBatch` is the only writer. It must run under one writer
 * per workspace (the coordinator Durable Object, or the store's local queue);
 * readers use `readVaultHeadState`, which hides a batch that has not
 * committed by answering with its parent revision.
 */
import { sha256Hex } from '../../crypto/digest'
import type { KVStore } from '../../store'
import {
  validateVaultMutationKeys,
  vaultHeadKey,
  vaultOperationKey,
  vaultRevisionKey,
} from './paths'

export const VAULT_HEAD_SCHEMA = 'vault-head-v1'
export const VAULT_REVISION_SCHEMA = 'vault-revision-v1'
export const VAULT_OPERATION_SCHEMA = 'vault-operation-v1'
export const VAULT_READ_CONVERGENCE_TIMEOUT_MS = 2_000
export const VAULT_READ_CONVERGENCE_INITIAL_DELAY_MS = 25
export const VAULT_READ_CONVERGENCE_MAX_DELAY_MS = 250
/** Committed revisions of one path a lineage lookup reads before it gives up. */
export const VAULT_LINEAGE_MAX_REVISIONS = 32

export class VaultReadConvergenceError extends Error {
  readonly code = 'vault.read_not_converged'
  readonly retryable = true
  readonly workspaceId?: string
  readonly path?: string
  readonly expectedRevision?: string

  constructor(input: string | {
    message?: string
    workspaceId?: string
    path?: string
    expectedRevision?: string
  } = {}) {
    const detail = typeof input === 'string' ? { message: input } : input
    super(detail.message ?? 'Vault read did not converge before the retry deadline')
    this.name = 'VaultReadConvergenceError'
    this.workspaceId = detail.workspaceId
    this.path = detail.path
    this.expectedRevision = detail.expectedRevision
  }
}

export type VaultWriterKind = 'frontend' | 'sandbox' | 'system'
export type VaultLearningActor = 'agent' | 'owner' | 'maintenance' | 'unknown'

/** Who caused a write and through which surface. `source` values are product vocabulary. */
export interface VaultWriteProvenance {
  actor: VaultLearningActor
  source: string
  executionId?: string
  threadId?: string
  messageId?: string
}

export interface VaultWriter {
  kind: VaultWriterKind
  id?: string
  authKind?: 'operator'
  keyId?: string
  provenance?: VaultWriteProvenance
}

/**
 * Attribution recorded at the writer, without prompt text or inferred
 * execution identities. Defaults follow the writer kind; `allowedSources` is
 * the product's provenance vocabulary and anything outside it is refused.
 */
export function normalizeVaultWriterProvenance(writer: VaultWriter, allowedSources: readonly string[]): VaultWriter {
  const supplied = writer.provenance
  const actor = writer.authKind === 'operator' ? 'unknown' : supplied?.actor
    ?? (writer.kind === 'sandbox' ? 'agent' : writer.kind === 'frontend' ? 'owner' : 'unknown')
  if (!['agent', 'owner', 'maintenance', 'unknown'].includes(actor)) throw new Error('Invalid Vault provenance actor')
  const source = supplied?.source ?? (writer.kind === 'sandbox' ? 'sandbox-sync' : writer.kind === 'frontend' ? 'vault-api' : 'unknown')
  if (!allowedSources.includes(source)) throw new Error('Invalid Vault provenance source')
  const provenance: VaultWriteProvenance = { actor, source }
  for (const key of ['executionId', 'threadId', 'messageId'] as const) {
    const value = supplied?.[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > 128 || !/^(?:[A-Za-z0-9:_-]|%[A-Fa-f0-9]{2})+$/.test(value)) throw new Error(`Invalid Vault provenance ${key}`)
    provenance[key] = value
  }
  return { ...writer, provenance }
}

/** Who created the live entry and when; carried across updates, set again after a delete. */
export interface VaultCreation {
  by: string
  at: string
}

/** The actor a writer reads as in creation records. */
export function vaultWriterActor(writer: VaultWriter): string {
  if (writer.kind === 'sandbox') return writer.id ? `sandbox:${writer.id}` : 'vault:sandbox'
  return writer.id ?? `vault:${writer.kind}`
}

export interface VaultHeadMetadata {
  schema: typeof VAULT_HEAD_SCHEMA
  revision: string
  contentHash: string | null
  deleted: boolean
  operationId: string
  updatedAt: string
  writer: VaultWriter
  batchOperation?: boolean
  /** Writes to this path so far, deletes included; absent on heads written before it existed. */
  sequence?: number
  created?: VaultCreation
  /** Opaque tag a product adapter records to decode its own writes. */
  storeFormat?: string
}

interface VaultOperationState {
  schema: typeof VAULT_OPERATION_SCHEMA
  status: 'preparing' | 'committed'
}

export interface VaultRevisionMetadata {
  schema: typeof VAULT_REVISION_SCHEMA
  workspaceId: string
  path: string
  revision: string
  parentRevision: string | null
  contentHash: string | null
  /** Actual UTF8 bytes recorded by the immutable revision writer; absent on older revisions. */
  contentBytes?: number
  deleted: boolean
  operationId: string
  createdAt: string
  writer: VaultWriter
  outcome: 'committed' | 'conflict'
  batchOperation?: boolean
  sequence?: number
  storeFormat?: string
}

export interface VaultMutationChange {
  path: string
  kind: 'put' | 'delete'
  content?: string
  expectedRevision: string | null
  storeFormat?: string
}

export interface VaultMutationRequest {
  workspaceId: string
  operationId: string
  writer: VaultWriter
  changes: VaultMutationChange[]
}

export interface VaultMutationFileResult {
  path: string
  revision: string
  contentHash: string | null
  deleted: boolean
  /** Absent from a coordinator still running code from before the count existed. */
  sequence?: number
  updatedAt?: string
}

export interface VaultMutationConflict {
  path: string
  expectedRevision: string | null
  currentRevision: string | null
  conflictRevision: string
}

export type VaultMutationResult =
  | { status: 'applied'; files: VaultMutationFileResult[] }
  | { status: 'conflict'; conflicts: VaultMutationConflict[] }

export interface VaultHeadState {
  revision: string | null
  contentHash: string | null
  deleted: boolean
  content: string | null
  metadata: VaultHeadMetadata | null
  /** Set when `metadata` is null but the write count is known, as for a batch still in flight. */
  sequence?: number
}

/** What a mutation does to the writer before it is recorded (a product's provenance rules). */
export interface VaultMutationPolicy {
  normalizeWriter?: (writer: VaultWriter) => VaultWriter
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * The per-path write count: 0 for a path never written, and deletes count. A
 * head written before the count existed reads as 1, so the next write records
 * 2 and the count only grows.
 */
export function vaultHeadSequence(state: Pick<VaultHeadState, 'revision' | 'metadata' | 'sequence'>): number {
  return positiveInteger(state.sequence) ?? positiveInteger(state.metadata?.sequence) ?? (state.revision ? 1 : 0)
}

/** The recorded creation of a head, or null when the Vault recorded none. */
export function vaultHeadCreation(metadata: VaultHeadMetadata | null): VaultCreation | null {
  const created = metadata?.created
  return created && typeof created.by === 'string' && created.by && typeof created.at === 'string' && created.at
    ? { by: created.by, at: created.at }
    : null
}

export interface VaultVisibilityFence {
  schema: 'vault-visibility-fence-v1'
  path: string
  revision: string
  contentHash: string | null
  deleted: boolean
  operationId: string
  headVisible: boolean
  listVisible: boolean
  committedAt: string
}

export type VaultHeadReader = (
  workspaceId: string,
  path: string,
) => Promise<VaultHeadState>

export interface VaultConvergenceOptions {
  timeoutMs?: number
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
}

export interface VaultSandboxBaselineFile {
  revision: string | null
  contentHash: string | null
  deleted: boolean
  binary?: boolean
  onDiskHash?: string | null
}

export interface VaultSandboxProgress {
  operation: 'hydrate'
  cursor?: string
  processedHeadCount: number
  unseenBaselinePaths: string[]
}

/** What a sandbox's copy of the Vault held when it last agreed with KV. */
export interface VaultSandboxBaseline {
  schema: 'vault-sandbox-baseline-v2' | 'vault-sandbox-baseline-v3'
  workspaceId: string
  sandboxId: string
  /**
   * Control-plane filesystem identity that authorized this baseline. Required
   * by v3; absent only on legacy v2 records during rollout.
   */
  filesystemIncarnationId?: string
  /** Absent on retained baselines whose mirror is the legacy native cwd. */
  mirrorRoot?: string
  files: Record<string, VaultSandboxBaselineFile>
  progress?: VaultSandboxProgress
  updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseVaultHeadMetadata(value: unknown): VaultHeadMetadata | null {
  if (!isRecord(value) || value.schema !== VAULT_HEAD_SCHEMA) return null
  if (typeof value.revision !== 'string' || !value.revision) return null
  if (typeof value.deleted !== 'boolean') return null
  if (value.contentHash !== null && typeof value.contentHash !== 'string') return null
  if (typeof value.operationId !== 'string' || typeof value.updatedAt !== 'string') return null
  if (!isRecord(value.writer) || !['frontend', 'sandbox', 'system'].includes(String(value.writer.kind))) return null
  return value as unknown as VaultHeadMetadata
}

export function vaultHeadMatchesFence(
  state: Pick<VaultHeadState, 'revision' | 'contentHash' | 'deleted' | 'metadata'>,
  fence: VaultVisibilityFence,
): boolean {
  return state.revision === fence.revision
    && state.contentHash === fence.contentHash
    && state.deleted === fence.deleted
    && state.metadata?.operationId === fence.operationId
}

/** Read the head until it exposes the fenced revision, or throw `VaultReadConvergenceError`. */
export async function readVaultHeadStateConverged(
  kv: KVStore,
  workspaceId: string,
  path: string,
  fence: VaultVisibilityFence,
  options: VaultConvergenceOptions = {},
): Promise<VaultHeadState> {
  const timeoutMs = options.timeoutMs ?? VAULT_READ_CONVERGENCE_TIMEOUT_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const startedAt = now()
  let delayMs = VAULT_READ_CONVERGENCE_INITIAL_DELAY_MS

  while (true) {
    const state = await readVaultHeadState(kv, workspaceId, path)
    if (vaultHeadMatchesFence(state, fence)) return state

    const elapsedMs = now() - startedAt
    if (elapsedMs >= timeoutMs) {
      throw new VaultReadConvergenceError({
        message: `Vault head for ${path} did not expose fenced revision ${fence.revision} within ${timeoutMs}ms`,
        workspaceId,
        path,
        expectedRevision: fence.revision,
      })
    }
    const remainingMs = timeoutMs - elapsedMs
    await sleep(Math.min(delayMs, remainingMs))
    delayMs = Math.min(delayMs * 2, VAULT_READ_CONVERGENCE_MAX_DELAY_MS)
  }
}

/**
 * Workspace erasure runs with writers closed. A visible committed descendant
 * can supersede its fence, but only after its immutable lineage proves that
 * fence was included. Ordinary Vault reads keep exact-fence convergence.
 */
export async function readVaultHeadStateForErasure(
  kv: KVStore,
  workspaceId: string,
  path: string,
  fence: VaultVisibilityFence,
  options: VaultConvergenceOptions = {},
): Promise<VaultHeadState> {
  const head = await readVaultHeadState(kv, workspaceId, path)
  if (vaultHeadMatchesFence(head, fence)) return head
  let revision = head.metadata?.revision === head.revision && fence.path === path ? head.revision : null
  for (let read = 0; revision && read < VAULT_LINEAGE_MAX_REVISIONS; read++) {
    const record = await kv.getWithMetadata(vaultRevisionKey(workspaceId, revision, path))
    const metadata = record.metadata as VaultRevisionMetadata | null
    if (record.value === null || metadata?.schema !== VAULT_REVISION_SCHEMA
      || metadata.workspaceId !== workspaceId || metadata.path !== path || metadata.revision !== revision
      || metadata.outcome !== 'committed'
      || (metadata.parentRevision !== null && typeof metadata.parentRevision !== 'string')) break
    if (metadata.batchOperation && !await vaultOperationCommitted(kv, workspaceId, metadata.operationId, path)) break
    if (read === 0 && (metadata.contentHash !== head.contentHash || metadata.deleted !== head.deleted
      || metadata.operationId !== head.metadata?.operationId)) break
    if (revision === fence.revision) {
      if (metadata.contentHash !== fence.contentHash || metadata.deleted !== fence.deleted
        || metadata.operationId !== fence.operationId) break
      // A writer outside the closed coordinator must not race the proven head.
      const current = await readVaultHeadState(kv, workspaceId, path)
      if (current.revision !== head.revision || current.contentHash !== head.contentHash
        || current.deleted !== head.deleted || current.metadata?.operationId !== head.metadata?.operationId) break
      return head
    }
    revision = metadata.parentRevision
  }
  // A missing, unrelated or newer fence still requires its exact committed head.
  return readVaultHeadStateConverged(kv, workspaceId, path, fence, options)
}

export async function vaultOperationCommitted(kv: KVStore, workspaceId: string, operationId: string, path?: string): Promise<boolean> {
  const operation = await kv.get(vaultOperationKey(workspaceId, operationId, path))
  const state = operation ? JSON.parse(operation) as Partial<VaultOperationState> : null
  return state?.schema === VAULT_OPERATION_SCHEMA && state.status === 'committed'
}

/**
 * The head of `path` as readers must see it. A head written by a batch that
 * has not committed answers with its parent revision; a legacy value with no
 * metadata answers with a revision derived from its content.
 */
export async function readVaultHeadState(
  kv: KVStore,
  workspaceId: string,
  path: string,
): Promise<VaultHeadState> {
  const result = await kv.getWithMetadata(vaultHeadKey(workspaceId, path))
  const metadata = parseVaultHeadMetadata(result.metadata)
  if (metadata) {
    if (metadata.batchOperation) {
      if (!await vaultOperationCommitted(kv, workspaceId, metadata.operationId, path)) {
        const revision = await kv.getWithMetadata(vaultRevisionKey(workspaceId, metadata.revision, path))
        const revisionMetadata = revision.metadata as VaultRevisionMetadata | null
        const parentRevision = revisionMetadata?.parentRevision ?? null
        if (!parentRevision) {
          return { revision: null, contentHash: null, deleted: true, content: null, metadata: null }
        }
        const parent = await kv.getWithMetadata(vaultRevisionKey(workspaceId, parentRevision, path))
        const parentMetadata = parent.metadata as VaultRevisionMetadata | null
        if (!parentMetadata || parentMetadata.schema !== VAULT_REVISION_SCHEMA) {
          throw new Error(`Vault batch parent revision is missing: ${parentRevision}`)
        }
        return {
          revision: parentRevision,
          contentHash: parentMetadata.contentHash,
          deleted: parentMetadata.deleted,
          content: parentMetadata.deleted ? null : parent.value,
          metadata: null,
          sequence: positiveInteger(parentMetadata.sequence) ?? 1,
        }
      }
    }
    return {
      revision: metadata.revision,
      contentHash: metadata.contentHash,
      deleted: metadata.deleted,
      content: metadata.deleted ? null : result.value,
      metadata,
    }
  }
  if (result.value === null) {
    return { revision: null, contentHash: null, deleted: true, content: null, metadata: null }
  }
  const contentHash = await sha256Hex(result.value)
  const legacyRevision = await sha256Hex(`${path}\0${contentHash}`)
  return {
    revision: `legacy-${legacyRevision}`,
    contentHash,
    deleted: false,
    content: result.value,
    metadata: null,
  }
}

async function revisionIdFor(
  request: VaultMutationRequest,
  change: VaultMutationChange,
  contentHash: string | null,
): Promise<string> {
  return sha256Hex([
    request.workspaceId,
    request.operationId,
    change.kind,
    change.path,
    change.expectedRevision ?? 'absent',
    contentHash ?? 'deleted',
  ].join('\0'))
}

async function ensureRevisionRecord(
  kv: KVStore,
  metadata: VaultRevisionMetadata,
  content: string,
): Promise<void> {
  const key = vaultRevisionKey(metadata.workspaceId, metadata.revision, metadata.path)
  const existing = await kv.getWithMetadata(key)
  if (existing.value !== null) return
  await kv.put(key, content, { metadata })
}

interface PreparedChange {
  change: VaultMutationChange
  current: VaultHeadState
  content: string
  contentHash: string | null
  revision: string
  sequence: number
  alreadyApplied: boolean
}

/**
 * Apply a batch of path changes against their expected revisions. Any stale
 * expectation turns the whole batch into a conflict (each blocked change is
 * kept as a conflict revision); otherwise every change commits, a multi-path
 * batch behind an operation record. Replaying an applied operation is a no-op.
 */
export async function applyVaultMutationBatch(
  kv: KVStore,
  request: VaultMutationRequest,
  readHead: VaultHeadReader = (workspaceId, path) => readVaultHeadState(kv, workspaceId, path),
  policy: VaultMutationPolicy = {},
): Promise<VaultMutationResult> {
  if (policy.normalizeWriter) request = { ...request, writer: policy.normalizeWriter(request.writer) }
  if (!request.operationId) throw new Error('Vault mutation operationId is required')
  if (request.changes.length === 0) return { status: 'applied', files: [] }
  validateVaultMutationKeys(request)
  if (new Set(request.changes.map((change) => change.path)).size !== request.changes.length) {
    throw new Error('Vault mutation contains duplicate paths')
  }

  const prepared = await Promise.all(request.changes.map(async (change): Promise<PreparedChange> => {
    if (change.kind === 'put' && typeof change.content !== 'string') {
      throw new Error(`Vault put requires content: ${change.path}`)
    }
    const content = change.kind === 'put' ? change.content as string : ''
    const contentHash = change.kind === 'put' ? await sha256Hex(content) : null
    const current = await readHead(request.workspaceId, change.path)
    const alreadyApplied = current.metadata?.operationId === request.operationId
      && current.deleted === (change.kind === 'delete')
      && current.contentHash === contentHash
    return {
      change,
      current,
      content,
      contentHash,
      revision: alreadyApplied && current.revision
        ? current.revision
        : await revisionIdFor(request, change, contentHash),
      sequence: vaultHeadSequence(current) + (alreadyApplied ? 0 : 1),
      alreadyApplied,
    }
  }))
  validateVaultMutationKeys({
    ...request,
    changes: prepared.map(({ change, revision }) => ({ path: change.path, revision })),
  })

  const conflicting = prepared.filter(({ change, current, alreadyApplied }) => (
    !alreadyApplied && current.revision !== change.expectedRevision
  ))
  if (conflicting.length > 0) {
    const createdAt = new Date().toISOString()
    const blocked = prepared.filter(({ alreadyApplied }) => !alreadyApplied)
    await Promise.all(blocked.map(async ({ change, content, contentHash, revision }) => {
      await ensureRevisionRecord(kv, {
        schema: VAULT_REVISION_SCHEMA,
        workspaceId: request.workspaceId,
        path: change.path,
        revision,
        parentRevision: change.expectedRevision,
        contentHash,
        deleted: change.kind === 'delete',
        operationId: request.operationId,
        createdAt,
        writer: request.writer,
        outcome: 'conflict',
      }, content)
    }))
    return {
      status: 'conflict',
      conflicts: blocked.map(({ change, current, revision }) => ({
        path: change.path,
        expectedRevision: change.expectedRevision,
        currentRevision: current.revision,
        conflictRevision: revision,
      })),
    }
  }

  const updatedAt = new Date().toISOString()
  const isBatch = prepared.length > 1 && prepared.some(({ alreadyApplied }) => !alreadyApplied)
  if (isBatch) {
    const operation: VaultOperationState = { schema: VAULT_OPERATION_SCHEMA, status: 'preparing' }
    await kv.put(vaultOperationKey(request.workspaceId, request.operationId), JSON.stringify(operation))
  }
  for (const item of prepared) {
    const { change, current, content, contentHash, revision, sequence, alreadyApplied } = item
    if (alreadyApplied) continue

    if (current.metadata === null && current.content !== null && current.revision && current.contentHash) {
      const legacyWriter: VaultWriter = { kind: 'system', id: 'legacy-import' }
      await ensureRevisionRecord(kv, {
        schema: VAULT_REVISION_SCHEMA,
        workspaceId: request.workspaceId,
        path: change.path,
        revision: current.revision,
        parentRevision: null,
        contentHash: current.contentHash,
        deleted: false,
        operationId: `legacy:${current.revision}`,
        createdAt: updatedAt,
        writer: policy.normalizeWriter?.(legacyWriter) ?? legacyWriter,
        outcome: 'committed',
      }, current.content)
    }

    const revisionMetadata: VaultRevisionMetadata = {
      schema: VAULT_REVISION_SCHEMA,
      contentBytes: new TextEncoder().encode(content).byteLength,
      workspaceId: request.workspaceId,
      path: change.path,
      revision,
      parentRevision: current.revision,
      contentHash,
      deleted: change.kind === 'delete',
      operationId: request.operationId,
      createdAt: updatedAt,
      writer: request.writer,
      outcome: 'committed',
      batchOperation: isBatch || undefined,
      sequence,
      storeFormat: change.storeFormat,
    }
    await ensureRevisionRecord(kv, revisionMetadata, content)
    // A put over a live entry keeps its creator; one over nothing starts a new entry.
    const live = !current.deleted && current.revision !== null
    const created = change.kind === 'delete' || live
      ? vaultHeadCreation(current.metadata) ?? undefined
      : { by: vaultWriterActor(request.writer), at: updatedAt }
    const headMetadata: VaultHeadMetadata = {
      schema: VAULT_HEAD_SCHEMA,
      revision,
      contentHash,
      deleted: change.kind === 'delete',
      operationId: request.operationId,
      updatedAt,
      writer: request.writer,
      batchOperation: isBatch || undefined,
      sequence,
      created,
      storeFormat: change.storeFormat,
    }
    await kv.put(vaultHeadKey(request.workspaceId, change.path), content, { metadata: headMetadata })
  }

  if (isBatch) {
    const operation: VaultOperationState = { schema: VAULT_OPERATION_SCHEMA, status: 'committed' }
    await kv.put(vaultOperationKey(request.workspaceId, request.operationId), JSON.stringify(operation))
  }

  return {
    status: 'applied',
    files: prepared.map(({ change, current, contentHash, revision, sequence, alreadyApplied }) => ({
      path: change.path,
      revision,
      contentHash,
      deleted: change.kind === 'delete',
      sequence,
      updatedAt: alreadyApplied ? current.metadata?.updatedAt : updatedAt,
    })),
  }
}
