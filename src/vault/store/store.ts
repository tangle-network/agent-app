/**
 * The Vault file store: reads, writes, listings and revision history over a
 * KV namespace, with every mutation and head read routed through the
 * workspace's coordinator Durable Object when one is bound (see
 * `./coordinator`). Without a coordinator (local runs, evals) mutations are
 * serialized per workspace in-process and reads go straight to KV.
 *
 * A product creates one store with `createVaultStore`, binds its KV and
 * coordinator per request, and supplies its frontmatter codec and the few
 * product rules that surround a write (writer provenance, side records a
 * delete must remove, a local write closure).
 */
import { sha256Hex } from '../../crypto/digest'
import type { KVStore } from '../../store'
import { isWorkspaceFileExportable } from '../../web/file-export'
import {
  parseVaultPathErrorResponse,
  VaultPathError,
  validateVaultFilePath,
  validateWorkspaceId,
  isHiddenVaultFilePath,
  vaultHeadPathPrefix,
  vaultHeadPrefix,
  vaultMetaKey,
  vaultRevisionKey,
  vaultRevisionPrefix,
} from './paths'
import {
  applyVaultMutationBatch,
  parseVaultHeadMetadata,
  readVaultHeadState,
  vaultOperationCommitted,
  VaultReadConvergenceError,
  VAULT_LINEAGE_MAX_REVISIONS,
  VAULT_REVISION_SCHEMA,
  type VaultHeadState,
  type VaultMutationPolicy,
  type VaultMutationRequest,
  type VaultMutationResult,
  type VaultRevisionMetadata,
  type VaultSandboxBaseline,
  type VaultWriter,
} from './revisions'
import { buildTreeFromPaths, type VaultNode } from './tree'
import {
  parseVaultBoxStateView,
  type SandboxBootstrapConfirmation,
  type VaultBoxStateView,
  type VaultBoxSyncRecord,
} from './box-state'

/** The Durable Object namespace surface the store calls; Cloudflare's binding satisfies it. */
export interface VaultCoordinatorNamespace {
  idFromName(name: string): unknown
  get(id: any): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

/** A coordinator's structured error, as its JSON body carries it. */
export interface VaultCoordinatorErrorDetail {
  code?: string
  message?: string
  retryable?: boolean
  workspaceId?: string
  path?: string
  expectedRevision?: string
}

export class VaultFileNotFoundError extends VaultPathError {
  override readonly code = 'vault.file_not_found'

  constructor(filePath: string) {
    super(`File not found: ${filePath}`, filePath)
    this.name = 'VaultFileNotFoundError'
  }
}

export class VaultConflictError extends Error {
  readonly code = 'vault.conflict'
  readonly conflicts: Extract<VaultMutationResult, { status: 'conflict' }>['conflicts']

  constructor(result: Extract<VaultMutationResult, { status: 'conflict' }>) {
    super(`Vault conflict: ${result.conflicts.map((conflict) => conflict.path).join(', ')}`)
    this.name = 'VaultConflictError'
    this.conflicts = result.conflicts
  }
}

/** Frontmatter parse result: a parse failure keeps the raw text and its error. */
export type VaultFrontmatterParse =
  | { succeeded: true; frontmatter: Record<string, unknown>; body: string }
  | { succeeded: false; raw: string; error: { code: string; message: string } }

/** How a product stores frontmatter and body in one Vault file. */
export interface VaultFrontmatterCodec {
  parse(raw: string): VaultFrontmatterParse
  serialize(frontmatter: Record<string, unknown>, body: string): string
}

/** A text file as the store reads or wrote it. */
export interface VaultStoredFile {
  path: string
  content: string
  frontmatter: Record<string, unknown>
  body: string
  parseError?: { code: string; message: string }
  /** The `mime` frontmatter field, when the file records one. */
  mimeType?: string
  revision: string
  contentHash: string
}

export interface VaultMutationOptions {
  expectedRevision?: string | null
  operationId?: string
  writer?: VaultWriter
}

export interface VaultHeadListEntry {
  path: string
  revision: string | null
  contentHash: string | null
  deleted: boolean
}

export interface VaultHeadListPage {
  entries: VaultHeadListEntry[]
  complete: boolean
  cursor: string | null
}

/** Saved versions of one file a history listing returns at most. */
export const VAULT_HISTORY_MAX_REVISIONS = 20

/** Revision ids are hex digests; anything else cannot name a record. */
const VAULT_REVISION_ID = /^[A-Za-z0-9_-]{1,128}$/

const HIDDEN_VAULT_PURGE_MARKER = 'hidden-path-purge-v1'

/** One committed version of a file, as the Vault History lists it. */
export interface VaultFileRevision {
  revision: string
  createdAt: string
  writer: VaultWriter
  /** True for the version the head holds now. */
  current: boolean
}

export interface VaultRevisionsPage {
  revisions: VaultRevisionMetadata[]
  complete: boolean
  /** False when a listed key carried no readable metadata or an uncommitted batch. */
  metadataComplete: boolean
  cursor: string | null
}

export interface VaultStoreConfig {
  /** How a file's frontmatter and body are stored. */
  codec: VaultFrontmatterCodec
  /** Headers for each coordinator request (JSON content type plus any channel auth). */
  coordinatorHeaders?: (workspaceId: string) => Promise<Record<string, string>>
  /** A product error a coordinator response carries, typed; null when it is not one. */
  decodeCoordinatorError?: (detail: VaultCoordinatorErrorDetail, fallback: string) => Error | null
  /** Writer rules every mutation applies; the coordinator must apply the same ones. */
  mutationPolicy?: VaultMutationPolicy
  /** Runs inside the local mutation queue before a write without a coordinator; throw to refuse it. */
  beforeLocalMutation?: (kv: KVStore, request: VaultMutationRequest) => Promise<void>
  /** Runs before a file delete commits, for product records tied to the path. */
  beforeDelete?: (workspaceId: string, filePath: string) => Promise<void>
}

/** The store's head-list query: a page of heads, optionally under a path prefix. */
export interface VaultHeadListOptions {
  cursor?: string
  limit?: number
  prefix?: string
}

function revisionRecordFor(
  metadata: unknown,
  workspaceId: string,
  path: string,
): VaultRevisionMetadata | null {
  const record = metadata as VaultRevisionMetadata | null
  if (!record || record.schema !== VAULT_REVISION_SCHEMA) return null
  if (record.workspaceId !== workspaceId || record.path !== path) return null
  return record
}

/** KV and coordinator binding: where each mutation and head read goes. */
function createVaultRuntime<Namespace extends VaultCoordinatorNamespace>(config: VaultStoreConfig) {
  // `kv` is the portable KV port: Cloudflare's KVNamespace satisfies it, so
  // production passes the binding unchanged and local runs pass an in-memory KV.
  let kv: KVStore | null = null
  let coordinator: Namespace | null = null
  const localMutationQueues = new Map<string, Promise<void>>()

  function setVaultKV(next: KVStore): void { kv = next }
  function setVaultCoordinator(next: Namespace | null): void { coordinator = next }
  function getVaultCoordinator(): Namespace | null { return coordinator }
  function getVaultKV(): KVStore {
    if (!kv) throw new Error('VAULT_KV not initialized. Call setVaultKV() first.')
    return kv
  }

  /** POST `body` to a route of the workspace's Vault coordinator Durable Object. */
  async function postVaultCoordinator(
    namespace: Namespace,
    workspaceId: string,
    route: string,
    body: unknown,
  ): Promise<Response> {
    const headers = config.coordinatorHeaders
      ? await config.coordinatorHeaders(workspaceId)
      : { 'Content-Type': 'application/json' }
    return namespace.get(namespace.idFromName(workspaceId)).fetch(`https://session-stream.internal/vault/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  async function throwVaultCoordinatorError(response: Response, fallback: string): Promise<never> {
    const detail = await response.json().catch(() => null) as { error?: string | VaultCoordinatorErrorDetail } | null
    const pathError = parseVaultPathErrorResponse(detail)
    if (pathError) throw pathError
    if (typeof detail?.error === 'object') {
      const decoded = config.decodeCoordinatorError?.(detail.error, fallback)
      if (decoded) throw decoded
      if (detail.error.code === 'vault.read_not_converged') {
        throw new VaultReadConvergenceError({
          message: detail.error.message,
          workspaceId: detail.error.workspaceId,
          path: detail.error.path,
          expectedRevision: detail.error.expectedRevision,
        })
      }
    }
    const message = typeof detail?.error === 'string' ? detail.error : detail?.error?.message
    throw new Error(`${fallback} (${response.status})${message ? `: ${message}` : ''}`)
  }

  /** Serialize Vault writes (and product steps that must not interleave with them) per workspace when no coordinator is bound. */
  function enqueueLocalVaultMutation<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    const previous = localMutationQueues.get(workspaceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    localMutationQueues.set(workspaceId, next.then(() => undefined, () => undefined))
    return next
  }

  async function commitVaultMutation(request: VaultMutationRequest): Promise<VaultMutationResult> {
    validateWorkspaceId(request.workspaceId)
    for (const change of request.changes) validateVaultFilePath(change.path)
    const namespace = coordinator
    if (!namespace) {
      return enqueueLocalVaultMutation(request.workspaceId, async () => {
        await config.beforeLocalMutation?.(getVaultKV(), request)
        return applyVaultMutationBatch(getVaultKV(), request, undefined, config.mutationPolicy)
      })
    }
    const response = await postVaultCoordinator(namespace, request.workspaceId, 'mutate', request)
    if (response.status !== 200 && response.status !== 409) {
      await throwVaultCoordinatorError(response, 'Vault mutation coordinator failed')
    }
    return response.json() as Promise<VaultMutationResult>
  }

  async function readVaultFileState(workspaceId: string, filePath: string): Promise<VaultHeadState> {
    validateVaultFilePath(filePath)
    validateWorkspaceId(workspaceId)
    const namespace = coordinator
    if (!namespace) return readVaultHeadState(getVaultKV(), workspaceId, filePath)
    const response = await postVaultCoordinator(namespace, workspaceId, 'head/get', { workspaceId, path: filePath })
    if (!response.ok) await throwVaultCoordinatorError(response, 'Vault head read failed')
    const body = await response.json() as { state: VaultHeadState }
    return body.state
  }

  // Baselines without a coordinator live for the isolate, as the local mutation queue does.
  const localSandboxBaselines = new Map<string, VaultSandboxBaseline>()

  /** The Vault files a box last matched, or null when it has never been synced. */
  async function readVaultSandboxBaseline(workspaceId: string, sandboxId: string): Promise<VaultSandboxBaseline | null> {
    validateWorkspaceId(workspaceId)
    if (!sandboxId) throw new Error('Sandbox ID is required for Vault baseline reads')
    const namespace = coordinator
    if (!namespace) return localSandboxBaselines.get(`${workspaceId}:${sandboxId}`) ?? null
    const response = await postVaultCoordinator(namespace, workspaceId, 'baseline/get', { workspaceId, sandboxId })
    if (!response.ok) await throwVaultCoordinatorError(response, 'Vault baseline read failed')
    const body = await response.json() as { baseline: VaultSandboxBaseline | null }
    return body.baseline
  }

  async function writeVaultSandboxBaseline(baseline: VaultSandboxBaseline): Promise<void> {
    validateWorkspaceId(baseline.workspaceId)
    if (!baseline.sandboxId) throw new Error('Sandbox ID is required for Vault baseline writes')
    const namespace = coordinator
    if (!namespace) {
      localSandboxBaselines.set(`${baseline.workspaceId}:${baseline.sandboxId}`, baseline)
      return
    }
    const response = await postVaultCoordinator(namespace, baseline.workspaceId, 'baseline/set', baseline)
    if (!response.ok) await throwVaultCoordinatorError(response, 'Vault baseline write failed')
  }

  /**
   * What the coordinator knows about the workspace box's Vault copy, or null
   * when it cannot say (no coordinator bound, or the read failed): a caller then
   * hydrates in full.
   */
  async function readVaultBoxState(workspaceId: string): Promise<VaultBoxStateView | null> {
    validateWorkspaceId(workspaceId)
    const namespace = coordinator
    if (!namespace) return null
    try {
      const response = await postVaultCoordinator(namespace, workspaceId, 'box-state/get', { workspaceId })
      if (!response.ok) return null
      const body = await response.json() as { state?: unknown }
      return parseVaultBoxStateView(body.state)
    } catch {
      return null
    }
  }

  /** Record that a complete hydration left this box's copy current as of `generation`. */
  async function recordVaultBoxSync(workspaceId: string, record: VaultBoxSyncRecord): Promise<void> {
    validateWorkspaceId(workspaceId)
    const namespace = coordinator
    if (!namespace) return
    const response = await postVaultCoordinator(namespace, workspaceId, 'box-state/sync', record)
    if (!response.ok) await throwVaultCoordinatorError(response, 'Vault box sync record failed')
  }

  /** Forget the box's sync after a reconcile left the box and the Vault apart. */
  async function invalidateVaultBoxSync(workspaceId: string): Promise<void> {
    validateWorkspaceId(workspaceId)
    const namespace = coordinator
    if (!namespace) return
    const response = await postVaultCoordinator(namespace, workspaceId, 'box-state/invalidate', { workspaceId })
    if (!response.ok) await throwVaultCoordinatorError(response, 'Vault box sync invalidation failed')
  }

  /** Record that this box's filesystem holds the product bootstrap `marker` names. */
  async function recordSandboxBootstrap(workspaceId: string, confirmation: SandboxBootstrapConfirmation): Promise<void> {
    validateWorkspaceId(workspaceId)
    const namespace = coordinator
    if (!namespace) return
    const response = await postVaultCoordinator(namespace, workspaceId, 'box-state/bootstrap', confirmation)
    if (!response.ok) await throwVaultCoordinatorError(response, 'Sandbox bootstrap record failed')
  }

  return {
    setVaultKV, getVaultKV, setVaultCoordinator, getVaultCoordinator, postVaultCoordinator,
    throwVaultCoordinatorError, enqueueLocalVaultMutation, commitVaultMutation, readVaultFileState,
    readVaultSandboxBaseline, writeVaultSandboxBaseline,
    readVaultBoxState, recordVaultBoxSync, invalidateVaultBoxSync, recordSandboxBootstrap,
    /** The product's frontmatter codec, for engines that read and write whole Vault documents. */
    codec: config.codec,
  }
}

type VaultRuntime<Namespace extends VaultCoordinatorNamespace> = ReturnType<typeof createVaultRuntime<Namespace>>

/** File reads, writes, deletes and listings over the runtime. */
function createVaultFiles<Namespace extends VaultCoordinatorNamespace>(runtime: VaultRuntime<Namespace>, config: VaultStoreConfig) {
  const { getVaultKV, getVaultCoordinator, postVaultCoordinator, throwVaultCoordinatorError, commitVaultMutation, readVaultFileState } = runtime

  async function expectedRevisionFor(
    workspaceId: string,
    filePath: string,
    options?: VaultMutationOptions,
  ): Promise<string | null> {
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedRevision')) {
      return options.expectedRevision ?? null
    }
    return (await readVaultFileState(workspaceId, filePath)).revision
  }

  async function commitSingleVaultMutation(
    workspaceId: string,
    change: { path: string; kind: 'put' | 'delete'; content?: string },
    options?: VaultMutationOptions,
  ): Promise<Extract<VaultMutationResult, { status: 'applied' }>['files'][number]> {
    const result = await commitVaultMutation({
      workspaceId,
      operationId: options?.operationId ?? crypto.randomUUID(),
      writer: options?.writer ?? { kind: 'system' },
      changes: [{
        ...change,
        expectedRevision: await expectedRevisionFor(workspaceId, change.path, options),
      }],
    })
    if (result.status === 'conflict') throw new VaultConflictError(result)
    const file = result.files[0]
    if (!file) throw new Error(`Vault mutation returned no result for ${change.path}`)
    return file
  }

  function storedFile(filePath: string, content: string, revision: string, contentHash: string): VaultStoredFile {
    const parsed = config.codec.parse(content)
    const mimeType = parsed.succeeded && typeof parsed.frontmatter.mime === 'string' ? parsed.frontmatter.mime : undefined
    return {
      path: filePath,
      content,
      frontmatter: parsed.succeeded ? parsed.frontmatter : {},
      body: parsed.succeeded ? parsed.body : parsed.raw,
      parseError: parsed.succeeded ? undefined : parsed.error,
      mimeType,
      revision,
      contentHash,
    }
  }

  function getVaultRoot(workspaceId: string): string {
    validateWorkspaceId(workspaceId)
    return vaultHeadPrefix(workspaceId).slice(0, -1)
  }

  async function writeVaultFile(
    workspaceId: string,
    filePath: string,
    content: { frontmatter: Record<string, unknown>; body: string },
    options?: VaultMutationOptions,
  ): Promise<VaultStoredFile> {
    validateVaultFilePath(filePath)
    validateWorkspaceId(workspaceId)
    const fileContent = config.codec.serialize(content.frontmatter, content.body)
    const result = await commitSingleVaultMutation(workspaceId, { path: filePath, kind: 'put', content: fileContent }, options)
    if (!result.contentHash) throw new Error(`Vault put returned no content hash for ${filePath}`)
    return {
      path: filePath,
      content: fileContent,
      frontmatter: content.frontmatter,
      body: content.body,
      revision: result.revision,
      contentHash: result.contentHash,
    }
  }

  async function writeVaultRawFile(
    workspaceId: string,
    filePath: string,
    content: string,
    options?: VaultMutationOptions,
  ): Promise<VaultStoredFile> {
    validateVaultFilePath(filePath)
    validateWorkspaceId(workspaceId)
    const result = await commitSingleVaultMutation(workspaceId, { path: filePath, kind: 'put', content }, options)
    if (!result.contentHash) throw new Error(`Vault put returned no content hash for ${filePath}`)
    const { mimeType: _mimeType, ...file } = storedFile(filePath, content, result.revision, result.contentHash)
    return file
  }

  async function readVaultFile(workspaceId: string, filePath: string): Promise<VaultStoredFile> {
    validateVaultFilePath(filePath)
    validateWorkspaceId(workspaceId)
    const state = await readVaultFileState(workspaceId, filePath)
    if (state.deleted || state.content === null || !state.revision || !state.contentHash) {
      throw new VaultFileNotFoundError(filePath)
    }
    return storedFile(filePath, state.content, state.revision, state.contentHash)
  }

  async function deleteVaultFile(workspaceId: string, filePath: string, options?: VaultMutationOptions): Promise<void> {
    validateVaultFilePath(filePath)
    validateWorkspaceId(workspaceId)
    await config.beforeDelete?.(workspaceId, filePath)
    await commitSingleVaultMutation(workspaceId, { path: filePath, kind: 'delete' }, options)
  }

  async function listVaultHeadPage(workspaceId: string, options: VaultHeadListOptions = {}): Promise<VaultHeadListPage> {
    validateWorkspaceId(workspaceId)
    const pathPrefix = options.prefix ?? ''
    const namespace = getVaultCoordinator()
    if (namespace) {
      const response = await postVaultCoordinator(namespace, workspaceId, 'head/list', { workspaceId, ...options })
      if (!response.ok) await throwVaultCoordinatorError(response, 'Vault head listing failed')
      const page = await response.json() as VaultHeadListPage
      // A coordinator from before prefix listing returns every head; filter here too.
      return {
        ...page,
        entries: page.entries.filter((entry) => isWorkspaceFileExportable(entry.path) && entry.path.startsWith(pathPrefix)),
      }
    }
    const prefix = vaultHeadPrefix(workspaceId)
    const list = await getVaultKV().list({
      prefix: vaultHeadPathPrefix(workspaceId, pathPrefix),
      cursor: options.cursor,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
    if (!list.list_complete && !list.cursor) {
      throw new Error(`Vault KV listing did not provide a cursor for ${workspaceId}`)
    }
    const entries = (await Promise.all(list.keys.map(async (key) => {
      const path = key.name.slice(prefix.length)
      if (!isWorkspaceFileExportable(path)) return null
      validateVaultFilePath(path)
      const metadata = parseVaultHeadMetadata((key as { metadata?: unknown }).metadata)
      if (metadata && !metadata.batchOperation) {
        return { path, revision: metadata.revision, contentHash: metadata.contentHash, deleted: metadata.deleted }
      }
      const state = await readVaultHeadState(getVaultKV(), workspaceId, path)
      return { path, revision: state.revision, contentHash: state.contentHash, deleted: state.deleted }
    }))).filter((entry): entry is VaultHeadListEntry => entry !== null)
    return {
      entries,
      complete: list.list_complete,
      cursor: list.list_complete ? null : list.cursor as string,
    }
  }

  /** Every visible Vault file path in the workspace, flat and unordered. */
  async function listVaultFilePaths(workspaceId: string): Promise<string[]> {
    validateWorkspaceId(workspaceId)
    const paths: string[] = []
    let cursor: string | undefined
    do {
      const page = await listVaultHeadPage(workspaceId, { cursor })
      paths.push(...page.entries.filter((entry) => !entry.deleted).map((entry) => entry.path))
      cursor = page.cursor ?? undefined
    } while (cursor)
    return paths
  }

  async function listVaultTree(workspaceId: string): Promise<VaultNode[]> {
    return buildTreeFromPaths(await listVaultFilePaths(workspaceId))
  }

  return {
    getVaultRoot, writeVaultFile, writeVaultRawFile, readVaultFile, deleteVaultFile,
    listVaultHeadPage, listVaultFilePaths, listVaultTree,
  }
}

/** Revision lineage reads and KV maintenance (conflict records, hidden paths). */
function createVaultHistory<Namespace extends VaultCoordinatorNamespace>(runtime: VaultRuntime<Namespace>) {
  const { getVaultKV, readVaultFileState } = runtime

  /**
   * The committed revision of `path`, at `headRevision` or earlier in its
   * lineage, whose content hash is `contentHash`; null when none is found.
   *
   * Revision records are immutable, so the walk follows `parentRevision` links
   * and stops at a record it cannot read rather than guessing past it.
   */
  async function findVaultRevisionWithContent(
    workspaceId: string,
    path: string,
    headRevision: string,
    contentHash: string,
    options: { matchesContent?: (content: string) => Promise<boolean> } = {},
  ): Promise<string | null> {
    validateVaultFilePath(path)
    validateWorkspaceId(workspaceId)
    const store = getVaultKV()
    let revision: string | null = headRevision
    for (let read = 0; revision && read < VAULT_LINEAGE_MAX_REVISIONS; read++) {
      const record = await store.getWithMetadata(vaultRevisionKey(workspaceId, revision, path))
      const metadata = record.metadata as VaultRevisionMetadata | null
      if (!metadata || metadata.schema !== VAULT_REVISION_SCHEMA || metadata.path !== path) return null
      if (metadata.outcome === 'committed' && !metadata.deleted) {
        if (!options.matchesContent && metadata.contentHash === contentHash) return revision
        if (options.matchesContent && typeof record.value === 'string'
          && await sha256Hex(record.value) === metadata.contentHash && await options.matchesContent(record.value)) return revision
      }
      revision = metadata.parentRevision
    }
    return null
  }

  /**
   * The committed versions of `path`, newest first, read by following
   * `parentRevision` links back from the head. Deletions in the lineage are
   * skipped, so a path deleted and written again still lists what it held
   * before. Every committed write keeps its full text in its revision record,
   * so each listed version can be read back with `readVaultFileRevision`.
   */
  async function listVaultFileRevisions(
    workspaceId: string,
    path: string,
    limit = VAULT_HISTORY_MAX_REVISIONS,
  ): Promise<VaultFileRevision[]> {
    validateVaultFilePath(path)
    validateWorkspaceId(workspaceId)
    const head = await readVaultFileState(workspaceId, path)
    if (head.deleted || !head.revision) return []
    const store = getVaultKV()
    const versions: VaultFileRevision[] = []
    let revision: string | null = head.revision
    for (let read = 0; revision && versions.length < limit && read < VAULT_LINEAGE_MAX_REVISIONS; read++) {
      const record = await store.getWithMetadata(vaultRevisionKey(workspaceId, revision, path))
      const metadata = revisionRecordFor(record.metadata, workspaceId, path)
      if (!metadata) {
        // A head written moments ago can be visible before its revision record;
        // it is still the current version, and its lineage appears once KV catches up.
        if (read === 0 && head.metadata) {
          versions.push({ revision, createdAt: head.metadata.updatedAt, writer: head.metadata.writer, current: true })
        }
        break
      }
      if (metadata.outcome === 'committed' && !metadata.deleted) {
        versions.push({ revision, createdAt: metadata.createdAt, writer: metadata.writer, current: read === 0 })
      }
      revision = metadata.parentRevision
    }
    return versions
  }

  /**
   * Bounded metadata-only page over committed writes whose path `includePath`
   * accepts, superseded revisions included. Batch writes count only once their
   * operation committed.
   */
  async function listCommittedVaultRevisionsPage(
    workspaceId: string,
    options: { cursor?: string; limit?: number; includePath: (path: string) => boolean },
  ): Promise<VaultRevisionsPage> {
    validateWorkspaceId(workspaceId)
    const store = getVaultKV()
    const page = await store.list({ prefix: vaultRevisionPrefix(workspaceId), limit: options.limit ?? 1000, cursor: options.cursor })
    if (!page.list_complete && !page.cursor) throw new Error('Vault revision listing did not provide a cursor')
    let metadataComplete = true
    const candidates = page.keys.flatMap((key) => {
      const record = (key as { metadata?: unknown }).metadata as VaultRevisionMetadata | null
      if (!record || record.schema !== VAULT_REVISION_SCHEMA) metadataComplete = false
      return record?.schema === VAULT_REVISION_SCHEMA && record.workspaceId === workspaceId
        && record.outcome === 'committed' && !record.deleted && options.includePath(record.path) ? [record] : []
    })
    const operations = new Map<string, Promise<boolean>>()
    const committed = await Promise.all(candidates.map(async (record) => {
      if (!record.batchOperation) return record
      let operation = operations.get(record.operationId)
      if (!operation) {
        operation = vaultOperationCommitted(store, workspaceId, record.operationId, record.path)
        operations.set(record.operationId, operation)
      }
      if (await operation) return record
      metadataComplete = false
      return null
    }))
    const revisions = committed.filter((record): record is VaultRevisionMetadata => record !== null)
    return { revisions, complete: page.list_complete, metadataComplete, cursor: page.list_complete ? null : page.cursor ?? null }
  }

  /** Exact immutable revision metadata, without loading the artifact body. Missing or partial inventory is not proof. */
  async function readVaultRevisionMetadata(workspaceId: string, path: string, revision: string): Promise<VaultRevisionMetadata | null> {
    validateVaultFilePath(path)
    validateWorkspaceId(workspaceId)
    if (!VAULT_REVISION_ID.test(revision)) return null
    const key = vaultRevisionKey(workspaceId, revision, path)
    const store = getVaultKV()
    const page = await store.list({ prefix: key, limit: 2 })
    const entry = page.keys[0]
    if (!page.list_complete || page.keys.length !== 1 || !entry || entry.name !== key) return null
    const metadata = revisionRecordFor('metadata' in entry ? entry.metadata : undefined, workspaceId, path)
    if (!metadata || metadata.revision !== revision || metadata.outcome !== 'committed' || metadata.deleted
      || !/^[a-f0-9]{64}$/.test(metadata.contentHash ?? '') || !metadata.operationId
      || (metadata.contentBytes !== undefined && (!Number.isSafeInteger(metadata.contentBytes) || metadata.contentBytes < 0))) return null
    if (metadata.batchOperation && !await vaultOperationCommitted(store, workspaceId, metadata.operationId)) return null
    return metadata
  }

  /** The full text `path` held at `revision`, or null when that is not a committed version of it. */
  async function readVaultFileRevision(
    workspaceId: string,
    path: string,
    revision: string,
    options: { maxBytes?: number } = {},
  ): Promise<string | null> {
    validateVaultFilePath(path)
    validateWorkspaceId(workspaceId)
    if (!VAULT_REVISION_ID.test(revision)) return null
    const maxBytes = options.maxBytes
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) return null
    const proof = maxBytes !== undefined ? await readVaultRevisionMetadata(workspaceId, path, revision) : null
    if (maxBytes !== undefined && (!proof || proof.contentBytes === undefined || proof.contentBytes > maxBytes)) return null
    const record = await getVaultKV().getWithMetadata(vaultRevisionKey(workspaceId, revision, path))
    const metadata = revisionRecordFor(record.metadata, workspaceId, path)
    if (!metadata || metadata.outcome !== 'committed' || metadata.deleted || typeof record.value !== 'string') return null
    if (proof && (metadata.revision !== revision || metadata.contentHash !== proof.contentHash || metadata.contentBytes !== proof.contentBytes
      || new TextEncoder().encode(record.value).byteLength !== proof.contentBytes || await sha256Hex(record.value) !== proof.contentHash)) return null
    return record.value
  }

  /**
   * Delete the conflict records a writer received for its own refused changes.
   * The coordinator named each record in its refusal, so the key is known and
   * nothing is read first: a read could miss a record written moments ago.
   */
  async function eraseVaultConflictRecords(
    workspaceId: string,
    conflicts: ReadonlyArray<{ path: string; conflictRevision: string }>,
  ): Promise<void> {
    validateWorkspaceId(workspaceId)
    const store = getVaultKV()
    await Promise.all(conflicts.map(({ path, conflictRevision }) => (
      store.delete(vaultRevisionKey(workspaceId, conflictRevision, path))
    )))
  }

  /** Remove heads under hidden paths once per workspace; returns how many were removed. */
  async function purgeHiddenVaultFiles(workspaceId: string): Promise<number> {
    validateWorkspaceId(workspaceId)
    const store = getVaultKV()
    const markerKey = vaultMetaKey(workspaceId, HIDDEN_VAULT_PURGE_MARKER)
    if (await store.get(markerKey)) return 0

    const prefix = vaultHeadPrefix(workspaceId)
    let deleted = 0
    let cursor: string | undefined
    do {
      const list = await store.list({ prefix, cursor })
      await Promise.all(list.keys.map(async (key) => {
        const path = key.name.slice(prefix.length)
        if (!isHiddenVaultFilePath(path)) return
        await store.delete(key.name)
        deleted += 1
      }))
      if (list.list_complete) {
        cursor = undefined
      } else if (list.cursor) {
        cursor = list.cursor
      } else {
        throw new Error(`Vault KV listing did not provide a cursor for ${workspaceId}`)
      }
    } while (cursor)

    await store.put(markerKey, new Date().toISOString())
    return deleted
  }

  return {
    findVaultRevisionWithContent, listVaultFileRevisions, listCommittedVaultRevisionsPage,
    readVaultRevisionMetadata, readVaultFileRevision, eraseVaultConflictRecords, purgeHiddenVaultFiles,
  }
}

/** Create a Vault store bound per request with `setVaultKV` and `setVaultCoordinator`. */
export function createVaultStore<Namespace extends VaultCoordinatorNamespace = VaultCoordinatorNamespace>(
  config: VaultStoreConfig,
) {
  const runtime = createVaultRuntime<Namespace>(config)
  return { ...runtime, ...createVaultFiles(runtime, config), ...createVaultHistory(runtime) }
}

export type VaultStore<Namespace extends VaultCoordinatorNamespace = VaultCoordinatorNamespace> =
  ReturnType<typeof createVaultStore<Namespace>>
