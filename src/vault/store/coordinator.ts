/**
 * The Vault's single writer, hosted in a workspace's Durable Object. It
 * serializes mutations, answers head reads and listings after every queued
 * mutation, and fences each committed revision until KV shows it.
 *
 * KV point reads and listings lag their own writes independently, so a
 * revision this coordinator just committed can be missing from either. A
 * visibility fence records the committed truth for that window: head reads
 * wait for the fenced revision, and listings report it in place of what KV
 * lists. A fence retires once both surfaces have shown it.
 *
 * The product's Durable Object routes `/vault/mutate`, `/vault/head/get` and
 * `/vault/head/list` to the handlers here and owns every other route.
 */
import type { KVStore } from '../../store'
import { isWorkspaceFileExportable } from '../../web/file-export'
import {
  VaultPathError,
  validateVaultFilePath,
  validateWorkspaceId,
  vaultHeadPathPrefix,
  vaultHeadPrefix,
  vaultPathErrorResponseBody,
} from './paths'
import {
  applyVaultMutationBatch,
  parseVaultHeadMetadata,
  readVaultHeadState,
  readVaultHeadStateConverged,
  vaultHeadMatchesFence,
  VaultReadConvergenceError,
  type VaultHeadState,
  type VaultMutationPolicy,
  type VaultMutationRequest,
  type VaultMutationResult,
  type VaultSandboxBaseline,
  type VaultVisibilityFence,
} from './revisions'
import type { VaultHeadListEntry } from './store'

const VAULT_FENCE_STORAGE_PREFIX = 'vaultFence:'

/**
 * Durable Object storage refuses a value over 128 KiB, and a baseline names
 * every Vault file, so a large Vault's baseline is stored as a head plus string
 * chunks. A chunk of 32,000 UTF-16 code units serializes to at most 64 KB even
 * when every character takes two bytes. The keys are the ones GTM and Creative
 * stored before this owner existed, so their baselines read unchanged.
 */
const VAULT_BASELINE_CHUNK_CHARS = 32_000
const VAULT_BASELINE_CHUNKED_SCHEMA = 'vault-sandbox-baseline-chunked-v1'

interface ChunkedVaultBaselineHead {
  schema: typeof VAULT_BASELINE_CHUNKED_SCHEMA
  chunks: number
  updatedAt: string
}

function isChunkedVaultBaselineHead(value: unknown): value is ChunkedVaultBaselineHead {
  return Boolean(value) && typeof value === 'object'
    && (value as { schema?: unknown }).schema === VAULT_BASELINE_CHUNKED_SCHEMA
    && Number.isInteger((value as { chunks?: unknown }).chunks)
}

function vaultBaselineKey(sandboxId: string): string {
  return `vaultBaseline:${sandboxId}`
}

function vaultBaselineChunkKey(sandboxId: string, index: number): string {
  return `vaultBaselineChunk:${sandboxId}:${index}`
}

/** The Durable Object storage calls the coordinator makes; Cloudflare's storage satisfies it. */
export interface VaultCoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void | boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

/** Sizes of one head listing, for products that watch Durable Object memory. */
export interface VaultHeadListStats {
  workspaceId: string
  fences: number
  headKeys: number
  entries: number
  paged: boolean
}

export interface VaultCoordinatorOptions {
  storage: VaultCoordinatorStorage
  kv: KVStore
  /** Writer rules every mutation applies; the store's local path must apply the same ones. */
  mutationPolicy?: VaultMutationPolicy
  /**
   * Runs each queued mutation. `apply` commits the batch and fences what it
   * applied; throw before calling it to refuse the mutation, or do product work
   * around it. Defaults to calling `apply`.
   */
  aroundMutation?: (request: VaultMutationRequest, apply: () => Promise<VaultMutationResult>) => Promise<VaultMutationResult>
  onHeadList?: (stats: VaultHeadListStats) => void
}

export function vaultCoordinatorJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The 503 body a client turns back into `VaultReadConvergenceError`. */
export function vaultConvergenceResponse(error: VaultReadConvergenceError): Response {
  return vaultCoordinatorJson({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      workspaceId: error.workspaceId,
      path: error.path,
      expectedRevision: error.expectedRevision,
    },
  }, 503)
}

/** The 400 body a client turns back into the typed `VaultPathError`. */
export function vaultPathErrorResponse(error: VaultPathError): Response {
  return vaultCoordinatorJson(vaultPathErrorResponseBody(error), 400)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Create the coordinator for one workspace Durable Object. */
export function createVaultCoordinator(options: VaultCoordinatorOptions) {
  const { storage, kv } = options
  let mutationQueue: Promise<void> = Promise.resolve()

  /** Run `work` after every queued mutation and before any later one. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = mutationQueue.catch(() => undefined).then(work)
    mutationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Resolve once every mutation queued so far has settled. */
  async function settled(): Promise<void> {
    await mutationQueue.catch(() => undefined)
  }

  function fenceKey(path: string): string {
    return `${VAULT_FENCE_STORAGE_PREFIX}${encodeURIComponent(path)}`
  }

  async function readVaultFence(path: string): Promise<VaultVisibilityFence | null> {
    const fence = await storage.get<VaultVisibilityFence>(fenceKey(path))
    if (!fence) return null
    if (fence.schema !== 'vault-visibility-fence-v1' || fence.path !== path) {
      throw new Error(`Invalid Vault visibility fence for ${path}`)
    }
    return fence
  }

  async function writeVaultFence(fence: VaultVisibilityFence): Promise<void> {
    await storage.put(fenceKey(fence.path), fence)
  }

  async function observeVaultFence(fence: VaultVisibilityFence, surface: 'head' | 'list'): Promise<void> {
    const current = await readVaultFence(fence.path)
    if (!current || current.revision !== fence.revision || current.operationId !== fence.operationId) return
    const observed: VaultVisibilityFence = {
      ...current,
      headVisible: current.headVisible || surface === 'head',
      listVisible: current.listVisible || surface === 'list',
    }
    if (observed.headVisible && observed.listVisible) {
      await storage.delete(fenceKey(fence.path))
    } else {
      await writeVaultFence(observed)
    }
  }

  async function listVaultFences(): Promise<VaultVisibilityFence[]> {
    const stored = await storage.list<VaultVisibilityFence>({ prefix: VAULT_FENCE_STORAGE_PREFIX })
    const fences: VaultVisibilityFence[] = []
    for (const value of stored.values()) {
      if (value.schema !== 'vault-visibility-fence-v1' || !value.path || !value.revision) {
        throw new Error('Invalid persisted Vault visibility fence')
      }
      fences.push(value)
    }
    return fences
  }

  async function readVaultHeadFenced(workspaceId: string, path: string): Promise<VaultHeadState> {
    const fence = await readVaultFence(path)
    if (!fence) return readVaultHeadState(kv, workspaceId, path)
    const state = await readVaultHeadStateConverged(kv, workspaceId, path, fence)
    await observeVaultFence(fence, 'head')
    return state
  }

  async function handleVaultHeadGet(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { workspaceId?: unknown; path?: unknown } | null
    const workspaceId = nonEmptyString(body?.workspaceId)
    const path = nonEmptyString(body?.path)
    if (!workspaceId || !path) return vaultCoordinatorJson({ error: 'Missing workspaceId or path' }, 400)
    try {
      validateWorkspaceId(workspaceId)
      validateVaultFilePath(path)
      await settled()
      return vaultCoordinatorJson({ state: await readVaultHeadFenced(workspaceId, path) })
    } catch (error) {
      if (error instanceof VaultReadConvergenceError) return vaultConvergenceResponse(error)
      if (error instanceof VaultPathError) return vaultPathErrorResponse(error)
      throw error
    }
  }

  /**
   * One page of heads with fences layered over it. A fenced path present in
   * the page is reported at its fenced revision, never dropped: hydration
   * reads a page as the authoritative set for its key range and treats a
   * baseline path it never saw as deleted. Fenced paths the listing has not
   * surfaced at all are added on the first page only, where the whole key
   * range is still ahead.
   */
  async function handleVaultHeadList(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as {
      workspaceId?: unknown
      cursor?: unknown
      limit?: unknown
      prefix?: unknown
    } | null
    const workspaceId = nonEmptyString(body?.workspaceId)
    const cursor = body?.cursor === undefined || body.cursor === null ? undefined : nonEmptyString(body.cursor)
    const limit = body?.limit === undefined ? undefined : Number(body.limit)
    const pathPrefix = body?.prefix === undefined ? '' : body.prefix
    if (!workspaceId || (body?.cursor !== undefined && body.cursor !== null && !cursor)
      || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1_000))
      || typeof pathPrefix !== 'string') {
      return vaultCoordinatorJson({ error: 'Invalid Vault head list request' }, 400)
    }

    try {
      validateWorkspaceId(workspaceId)
      await settled()
      const prefix = vaultHeadPrefix(workspaceId)
      const listPrefix = vaultHeadPathPrefix(workspaceId, pathPrefix)
      const [listed, allFences] = await Promise.all([
        kv.list({ prefix: listPrefix, cursor: cursor ?? undefined, ...(limit === undefined ? {} : { limit }) }),
        listVaultFences(),
      ])
      if (!listed.list_complete && !listed.cursor) {
        throw new Error(`Vault KV listing did not provide a cursor for ${workspaceId}`)
      }
      const fences = allFences.filter((fence) => fence.path.startsWith(pathPrefix) && isWorkspaceFileExportable(fence.path))
      const fencesByPath = new Map(fences.map((fence) => [fence.path, fence]))
      const entries = new Map<string, VaultHeadListEntry>()
      const listVisible: VaultVisibilityFence[] = []
      for (const key of listed.keys) {
        const path = key.name.slice(prefix.length)
        if (!isWorkspaceFileExportable(path)) continue
        validateVaultFilePath(path)
        const fence = fencesByPath.get(path)
        const metadata = parseVaultHeadMetadata((key as { metadata?: unknown }).metadata)
        if (fence) {
          entries.set(path, { path, revision: fence.revision, contentHash: fence.contentHash, deleted: fence.deleted })
          if (metadata && vaultHeadMatchesFence({
            revision: metadata.revision,
            contentHash: metadata.contentHash,
            deleted: metadata.deleted,
            metadata,
          }, fence)) listVisible.push(fence)
          continue
        }
        if (metadata && !metadata.batchOperation) {
          entries.set(path, { path, revision: metadata.revision, contentHash: metadata.contentHash, deleted: metadata.deleted })
          continue
        }
        // Absent or mid-batch metadata cannot be read off the listing.
        const state = await readVaultHeadState(kv, workspaceId, path)
        entries.set(path, { path, revision: state.revision, contentHash: state.contentHash, deleted: state.deleted })
      }
      if (!cursor) {
        for (const fence of fences) {
          if (fence.deleted || entries.has(fence.path)) continue
          entries.set(fence.path, { path: fence.path, revision: fence.revision, contentHash: fence.contentHash, deleted: false })
        }
      }
      for (const fence of listVisible) await observeVaultFence(fence, 'list')

      options.onHeadList?.({
        workspaceId,
        fences: fences.length,
        headKeys: listed.keys.length,
        entries: entries.size,
        paged: Boolean(cursor),
      })
      return vaultCoordinatorJson({
        entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
        complete: listed.list_complete,
        cursor: listed.list_complete ? null : listed.cursor,
      })
    } catch (error) {
      if (error instanceof VaultReadConvergenceError) return vaultConvergenceResponse(error)
      if (error instanceof VaultPathError) return vaultPathErrorResponse(error)
      throw error
    }
  }

  async function handleVaultMutation(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as VaultMutationRequest | null
    if (!body || typeof body.workspaceId !== 'string' || typeof body.operationId !== 'string'
      || !body.writer || !Array.isArray(body.changes)) {
      return vaultCoordinatorJson({ error: 'Invalid Vault mutation request' }, 400)
    }

    const apply = async (): Promise<VaultMutationResult> => {
      const outcome = await applyVaultMutationBatch(
        kv,
        body,
        (workspaceId, path) => readVaultHeadFenced(workspaceId, path),
        options.mutationPolicy,
      )
      if (outcome.status === 'applied') {
        const committedAt = new Date().toISOString()
        await Promise.all(outcome.files.map((file) => writeVaultFence({
          schema: 'vault-visibility-fence-v1',
          path: file.path,
          revision: file.revision,
          contentHash: file.contentHash,
          deleted: file.deleted,
          operationId: body.operationId,
          headVisible: false,
          listVisible: false,
          committedAt,
        })))
      }
      return outcome
    }

    try {
      const outcome = await exclusive(() => options.aroundMutation ? options.aroundMutation(body, apply) : apply())
      return vaultCoordinatorJson(outcome, outcome.status === 'conflict' ? 409 : 200)
    } catch (error) {
      if (error instanceof VaultReadConvergenceError) return vaultConvergenceResponse(error)
      if (error instanceof VaultPathError) return vaultPathErrorResponse(error)
      return vaultCoordinatorJson({ error: error instanceof Error ? error.message : 'Vault mutation failed' }, 500)
    }
  }

  /** A missing chunk fails the read: a partial baseline would misreport which files changed. */
  async function readVaultSandboxBaseline(sandboxId: string): Promise<VaultSandboxBaseline | null> {
    const stored = await storage.get<VaultSandboxBaseline | ChunkedVaultBaselineHead>(vaultBaselineKey(sandboxId))
    if (!stored) return null
    if (!isChunkedVaultBaselineHead(stored)) return stored
    const chunks: string[] = []
    for (let index = 0; index < stored.chunks; index++) {
      const chunk = await storage.get<string>(vaultBaselineChunkKey(sandboxId, index))
      if (typeof chunk !== 'string') throw new Error(`Vault baseline for sandbox ${sandboxId} is missing chunk ${index} of ${stored.chunks}`)
      chunks.push(chunk)
    }
    return JSON.parse(chunks.join('')) as VaultSandboxBaseline
  }

  /**
   * Writes the baseline whole when it fits one value, else as chunks under a
   * head, then deletes the previous write's surplus chunks. The writes run in
   * one request with no other I/O between them, so the object commits them
   * together.
   */
  async function writeVaultSandboxBaseline(baseline: VaultSandboxBaseline): Promise<void> {
    const key = vaultBaselineKey(baseline.sandboxId)
    const previous = await storage.get<unknown>(key)
    const previousChunks = isChunkedVaultBaselineHead(previous) ? previous.chunks : 0
    const serialized = JSON.stringify(baseline)
    let chunks = 0
    if (serialized.length <= VAULT_BASELINE_CHUNK_CHARS) {
      await storage.put(key, baseline)
    } else {
      chunks = Math.ceil(serialized.length / VAULT_BASELINE_CHUNK_CHARS)
      for (let index = 0; index < chunks; index++) {
        const start = index * VAULT_BASELINE_CHUNK_CHARS
        await storage.put(vaultBaselineChunkKey(baseline.sandboxId, index), serialized.slice(start, start + VAULT_BASELINE_CHUNK_CHARS))
      }
      const head: ChunkedVaultBaselineHead = { schema: VAULT_BASELINE_CHUNKED_SCHEMA, chunks, updatedAt: baseline.updatedAt }
      await storage.put(key, head)
    }
    for (let index = chunks; index < previousChunks; index++) {
      await storage.delete(vaultBaselineChunkKey(baseline.sandboxId, index))
    }
  }

  async function handleVaultBaselineGet(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { workspaceId?: unknown; sandboxId?: unknown } | null
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : ''
    const sandboxId = typeof body?.sandboxId === 'string' ? body.sandboxId : ''
    if (!workspaceId || !sandboxId) return vaultCoordinatorJson({ error: 'Missing workspaceId or sandboxId' }, 400)
    try {
      validateWorkspaceId(workspaceId)
      return vaultCoordinatorJson({ baseline: await readVaultSandboxBaseline(sandboxId) })
    } catch (error) {
      if (error instanceof VaultPathError) return vaultPathErrorResponse(error)
      throw error
    }
  }

  async function handleVaultBaselineSet(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as VaultSandboxBaseline | null
    const validSchema = body?.schema === 'vault-sandbox-baseline-v2'
      || (body?.schema === 'vault-sandbox-baseline-v3' && Boolean(body.filesystemIncarnationId))
    if (!body || !validSchema || !body.sandboxId || !body.workspaceId) {
      return vaultCoordinatorJson({ error: 'Invalid Vault sandbox baseline' }, 400)
    }
    try {
      validateWorkspaceId(body.workspaceId)
      await writeVaultSandboxBaseline(body)
      return vaultCoordinatorJson({ saved: true })
    } catch (error) {
      if (error instanceof VaultPathError) return vaultPathErrorResponse(error)
      throw error
    }
  }

  /** The coordinator's `/vault/*` routes, for a Durable Object's fetch; null for any other request. */
  async function handle(request: Request): Promise<Response | null> {
    if (request.method !== 'POST') return null
    switch (new URL(request.url).pathname) {
      case '/vault/mutate': return handleVaultMutation(request)
      case '/vault/head/get': return handleVaultHeadGet(request)
      case '/vault/head/list': return handleVaultHeadList(request)
      case '/vault/baseline/get': return handleVaultBaselineGet(request)
      case '/vault/baseline/set': return handleVaultBaselineSet(request)
      default: return null
    }
  }

  return {
    exclusive,
    settled,
    readVaultFence,
    observeVaultFence,
    readVaultHeadFenced,
    handleVaultHeadGet,
    handleVaultHeadList,
    handleVaultMutation,
    readVaultSandboxBaseline,
    writeVaultSandboxBaseline,
    handleVaultBaselineGet,
    handleVaultBaselineSet,
    handle,
  }
}

export type VaultCoordinator = ReturnType<typeof createVaultCoordinator>
