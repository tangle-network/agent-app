/**
 * Hydration: copy the workspace Vault into the box's Vault directory and record
 * what the box now holds as a baseline bound to the box's filesystem
 * incarnation. The head listing is paged; every page commits its baseline, so
 * an interrupted pass leaves durable progress and the next call resumes from
 * the recorded cursor.
 */
import type { Outcome } from '../../sandbox/outcome'
import { shellQuote } from '../../sandbox/binary-read'
import { sha256Hex } from '../../crypto/digest'
import type { VaultSandboxBaseline } from './revisions'
import type { VaultHeadListEntry } from './store'
import { vaultBoxInSync, VAULT_BOX_SYNC_MAX_SKIPS, type VaultBoxSyncSkip } from './box-state'
import {
  mapWithConcurrency,
  normalizeVaultSandboxBaseline,
  readReadySandboxFilesystemIncarnation,
  vaultBinaryPayload,
  SANDBOX_VAULT_SYNC_CONTRACT,
  VAULT_SANDBOX_BASELINE_SCHEMA,
  VaultFilesystemIncarnationError,
  VaultHydrationError,
  VaultHydrationIncompleteError,
  type SandboxVaultSyncConfig,
  type SandboxVaultSyncStageObserver,
} from './sandbox-sync'

const VAULT_IO_CONCURRENCY = 8
const BINARY_HYDRATION_CONCURRENCY = 2
const VAULT_HYDRATION_HEAD_PAGE_SIZE = 100
const VAULT_HYDRATION_MAX_PAGES = 200
/** Vault characters read before they are written to the box, so a page of large files never sits in memory at once. */
const VAULT_HYDRATION_BATCH_CHARS = 2_000_000
// The sandbox proxy refuses a request body over 1,048,576 bytes. A text file
// write is JSON, so the budget keeps 16 KiB of headroom for the envelope; a file
// that cannot fit one request alone is uploaded as bytes instead.
const VAULT_TEXT_WRITE_MAX_JSON_BYTES = 1024 * 1024 - 16 * 1024

export interface VaultHydrationFileSystem {
  exists(path: string): Promise<boolean>
  writeMany(files: Array<{ path: string; content: string }>): Promise<void>
  delete(path: string, options?: { recursive?: boolean }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  uploadData(path: string, data: Uint8Array): Promise<{ size?: number; sha256?: string } | unknown>
}

/** The box calls hydration makes; a `@tangle-network/sandbox` instance satisfies it. */
export interface VaultHydrationBox {
  id: string
  filesystemIncarnationId?: unknown
  filesystemIncarnationProvenance?: unknown
  filesystemIncarnationReadiness?: unknown
  fs: VaultHydrationFileSystem
  exec(command: string, options?: { sessionId?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface VaultHydrationStats {
  written: number
  deleted: number
  unchanged: number
  processedHeads: number
  /** True when the coordinator's record proved the box current and nothing was listed or written. */
  inSync?: boolean
  /** Files the box refused for their size (`skipOversizeFiles`): absent from the box and its baseline. */
  skipped: VaultBoxSyncSkip[]
  /** Set when the copy budget ran out: heads not on the box yet, and whether later pages were not examined. */
  deferred: { pendingPaths: string[]; morePages: boolean } | null
}

export interface VaultHydrationOptions {
  /** Paths a reconciliation parked as conflicts; hydration leaves both copies alone. */
  conflictPaths?: ReadonlySet<string>
  /** Paths the reconciliation just committed from the box; already current on the box. */
  appliedPaths?: ReadonlySet<string>
  /** May still be in flight (the Vault-loss probe): hydrate awaits it only to compare heads. */
  pathsMissingFromBox?: ReadonlySet<string> | Promise<ReadonlySet<string>>
  /** False when the caller makes the warm-path decision and records the sync itself: hydration then neither skips nor records. */
  recordSync?: boolean
  /**
   * A copy that may span calls. Hydration spends `remainingChars` (Vault
   * characters read; past it, it records what it wrote and returns `deferred`)
   * and appends every Vault path it writes, so a caller that retries on a new
   * box keeps one budget and can finish what the first attempt wrote.
   */
  progress?: { remainingChars: number; writtenPaths: string[] }
  onStage?: SandboxVaultSyncStageObserver
}

interface TextSnapshot { kind: 'text'; path: string; content: string }
interface BinarySnapshot { kind: 'binary'; path: string; payload: string; onDiskHash: string }
type Snapshot = TextSnapshot | BinarySnapshot

/** What one `hydrate` call carries across its pages. */
interface HydrationRun {
  progress: NonNullable<VaultHydrationOptions['progress']>
  skipped: VaultBoxSyncSkip[]
}

interface PageResult {
  deferred: VaultHydrationStats['deferred']
  complete: boolean
  cursor: string | null
  processedHeadCount: number
  written: number
  deleted: number
  unchanged: number
}

const encoder = new TextEncoder()

/** Hydrate every live Vault head into the box, page by page, until the listing ends. */
export async function hydrateSandboxVault(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  options: VaultHydrationOptions = {},
): Promise<Outcome<VaultHydrationStats>> {
  try {
    // The coordinator counts every Vault mutation. A complete hydration of this
    // exact box under this contract at the current count proves the box holds
    // the Vault, so a warm turn skips the listing, the diff and the baseline
    // write. Protected paths (a reconcile's conflicts or commits, a loss probe)
    // always take the full walk.
    const contract = config.contract ?? SANDBOX_VAULT_SYNC_CONTRACT
    const incarnation = readReadySandboxFilesystemIncarnation(box)
    const identity = box.id && incarnation.succeeded
      ? { sandboxId: box.id, filesystemIncarnationId: incarnation.value.id }
      : null
    const protectedPaths = Boolean(options.conflictPaths?.size || options.appliedPaths?.size)
      || options.pathsMissingFromBox !== undefined
    const ownsSync = options.recordSync !== false
    const view = identity && ownsSync ? await config.vault.readVaultBoxState(workspaceId) : null
    if (identity && !protectedPaths && vaultBoxInSync(view, identity, contract)) {
      return { succeeded: true, value: { written: 0, deleted: 0, unchanged: 0, processedHeads: 0, inSync: true, skipped: [], deferred: null } }
    }
    // The Vault directory is needed only before the first box write, so its
    // round trip overlaps the baseline read and the head listing.
    const vaultDir = box.fs.mkdir(config.root, { recursive: true })
    vaultDir.catch(() => {})
    let written = 0
    let deleted = 0
    let unchanged = 0
    let processedHeadCount = 0
    const run: HydrationRun = { progress: options.progress ?? { remainingChars: Infinity, writtenPaths: [] }, skipped: [] }
    for (let pageIndex = 0; pageIndex < VAULT_HYDRATION_MAX_PAGES; pageIndex += 1) {
      const page = await hydratePage(config, box, workspaceId, options, vaultDir, run)
      written += page.written
      deleted += page.deleted
      unchanged += page.unchanged
      processedHeadCount = page.processedHeadCount
      if (page.complete || page.deferred) {
        const stats = { written, deleted, unchanged, processedHeads: processedHeadCount, skipped: run.skipped, deferred: page.deferred }
        if (page.deferred) return { succeeded: true, value: stats }
        if (identity && view && !view.inFlight && run.skipped.length <= VAULT_BOX_SYNC_MAX_SKIPS) {
          // Recorded against the count read before the listing: a mutation
          // during this walk moved it, so the record cannot match and the next
          // turn walks again. A failed record only costs that next walk.
          await config.vault.recordVaultBoxSync(workspaceId, { ...identity, contract, generation: view.generation, skipped: run.skipped })
            .catch((error: unknown) => console.warn('[vault] box sync record failed', {
              workspaceId, error: error instanceof Error ? error.message : String(error),
            }))
        }
        return { succeeded: true, value: stats }
      }
      if (page.cursor === null) {
        throw new VaultHydrationIncompleteError({
          phase: 'hydrate', processedPaths: processedHeadCount, totalPaths: null, remainingPaths: null, committedGroups: 0,
        }, 'the Vault head listing reported more pages but returned no resume cursor')
      }
    }
    throw new VaultHydrationIncompleteError({
      phase: 'hydrate', processedPaths: processedHeadCount, totalPaths: null, remainingPaths: null, committedGroups: 0,
    }, `the Vault head listing did not finish within ${VAULT_HYDRATION_MAX_PAGES} pages`)
  } catch (error) {
    const typed = error instanceof VaultHydrationError
      || error instanceof VaultHydrationIncompleteError
      || error instanceof VaultFilesystemIncarnationError
      ? error
      : new VaultHydrationError(`Failed to hydrate workspace Vault for ${workspaceId}`, error)
    return { succeeded: false, error: typed }
  }
}

async function hydratePage(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  options: VaultHydrationOptions,
  vaultDir: Promise<void>,
  run: HydrationRun,
): Promise<PageResult> {
  const { vault } = config
  const stage = options.onStage ?? (() => {})
  if (!box.id) throw new Error(`Cannot hydrate Vault for ${workspaceId}: sandbox id is missing`)
  const sandboxId = box.id
  const incarnation = readReadySandboxFilesystemIncarnation(box)
  if (!incarnation.succeeded) throw incarnation.error

  let startedAt = Date.now()
  const normalized = normalizeVaultSandboxBaseline(await vault.readVaultSandboxBaseline(workspaceId, sandboxId))
  stage('baseline_read', startedAt)
  const baselineMatchesIncarnation = normalized.baseline?.schema === VAULT_SANDBOX_BASELINE_SCHEMA
    && normalized.baseline.filesystemIncarnationId === incarnation.value.id
  const previousBaseline = baselineMatchesIncarnation ? normalized.baseline : null
  const legacyBaseline = baselineMatchesIncarnation ? normalized.legacy : false
  const cursor = previousBaseline?.progress?.operation === 'hydrate' ? previousBaseline.progress.cursor : undefined
  startedAt = Date.now()
  const page = await vault.listVaultHeadPage(workspaceId, { cursor, limit: VAULT_HYDRATION_HEAD_PAGE_SIZE })
  stage('head_list', startedAt, { entries: page.entries.length })
  // A legacy baseline cannot prove a binary head holds decoded bytes, and this
  // pass may commit a current-schema baseline before it reaches every head, so
  // carried entries lose their revision and stay due for rewrite.
  const baselineFiles: VaultSandboxBaseline['files'] = legacyBaseline
    ? Object.fromEntries(Object.entries(previousBaseline?.files ?? {}).map(([path, file]) => [path, file.deleted ? file : { ...file, revision: null }]))
    : { ...(previousBaseline?.files ?? {}) }
  const conflictPaths = options.conflictPaths ?? new Set<string>()
  const appliedPaths = options.appliedPaths ?? new Set<string>()
  const pathsMissingFromBox = await options.pathsMissingFromBox ?? new Set<string>()
  const skippedPaths = new Set<string>()

  const changedHeads = page.entries.filter((entry) => {
    if (conflictPaths.has(entry.path) || appliedPaths.has(entry.path)) return false
    if (legacyBaseline) return true
    const previous = pathsMissingFromBox.has(entry.path) ? undefined : baselineFiles[entry.path]
    return !previous
      || previous.revision !== entry.revision
      || previous.contentHash !== entry.contentHash
      || previous.deleted !== entry.deleted
  })

  const unseenBaselinePaths = new Set(
    previousBaseline?.progress?.operation === 'hydrate'
      ? previousBaseline.progress.unseenBaselinePaths
      : Object.keys(previousBaseline?.files ?? {}),
  )
  for (const entry of page.entries) unseenBaselinePaths.delete(entry.path)
  const missingBaselinePaths = page.complete
    ? [...unseenBaselinePaths].filter((path) => (
        !conflictPaths.has(path) && !appliedPaths.has(path) && baselineFiles[path] !== undefined && !baselineFiles[path]?.deleted
      ))
    : []
  const pathsToDelete = [
    ...changedHeads
      .filter((entry) => entry.deleted && baselineFiles[entry.path] !== undefined && !baselineFiles[entry.path]?.deleted)
      .map((entry) => entry.path),
    ...missingBaselinePaths,
  ]
  await vaultDir
  let deleted = 0
  for (const path of pathsToDelete) {
    const target = boxPath(config, path)
    if (!(await box.fs.exists(target))) continue
    await box.fs.delete(target)
    deleted += 1
  }

  const binaryHashes = new Map<string, string>()
  const recordEntry = (entry: VaultHeadListEntry) => {
    const previous = baselineFiles[entry.path]
    const onDiskHash = binaryHashes.get(entry.path)
    if (onDiskHash !== undefined) {
      baselineFiles[entry.path] = { revision: entry.revision, contentHash: entry.contentHash, deleted: entry.deleted, binary: true, onDiskHash }
    } else if (
      previous?.binary
      && previous.revision === entry.revision && previous.contentHash === entry.contentHash && previous.deleted === entry.deleted
    ) {
      baselineFiles[entry.path] = previous
    } else {
      baselineFiles[entry.path] = { revision: entry.revision, contentHash: entry.contentHash, deleted: entry.deleted }
    }
  }
  const writeBaseline = async (progress: VaultSandboxBaseline['progress']) => {
    const writeStartedAt = Date.now()
    await vault.writeVaultSandboxBaseline({
      schema: VAULT_SANDBOX_BASELINE_SCHEMA,
      workspaceId,
      sandboxId,
      filesystemIncarnationId: incarnation.value.id,
      files: baselineFiles,
      ...(progress ? { progress } : {}),
      updatedAt: new Date().toISOString(),
    })
    stage('baseline_write', writeStartedAt)
  }

  // Read and write the changed heads in bounded batches, so a page of large
  // files never sits in memory at once.
  let written = 0
  let readMs = 0
  let writeMs = 0
  let deferredHeads: VaultHeadListEntry[] = []
  const liveHeads = changedHeads.filter((entry) => !entry.deleted)
  const headsByPath = new Map(liveHeads.map((entry) => [entry.path, entry]))
  for (let next = 0; next < liveHeads.length;) {
    if (run.progress.remainingChars <= 0) {
      deferredHeads = liveHeads.slice(next)
      break
    }
    const snapshots: Snapshot[] = []
    let batchChars = 0
    const readStartedAt = Date.now()
    while (next < liveHeads.length && batchChars < VAULT_HYDRATION_BATCH_CHARS) {
      const slice = liveHeads.slice(next, next + VAULT_IO_CONCURRENCY)
      next += slice.length
      const read = await mapWithConcurrency(slice, VAULT_IO_CONCURRENCY, async (entry) => readSnapshot(config, workspaceId, entry, skippedPaths))
      for (const snapshot of read) {
        if (!snapshot) continue
        snapshots.push(snapshot)
        batchChars += snapshot.kind === 'text' ? snapshot.content.length : snapshot.payload.length
      }
    }
    run.progress.remainingChars -= batchChars
    readMs += Date.now() - readStartedAt
    const writeStartedAt = Date.now()
    const present = config.skipFilesAlreadyOnBox
      ? await pathsAlreadyOnBox(config, box, snapshots.filter((snapshot) => !baselineFiles[snapshot.path] && !pathsMissingFromBox.has(snapshot.path)))
      : new Set<string>()
    const toWrite = snapshots.filter((snapshot) => !present.has(snapshot.path))
    const refused = [
      ...await writeTextSnapshots(config, box, toWrite.filter((snapshot): snapshot is TextSnapshot => snapshot.kind === 'text')),
      ...await writeBinaries(config, box, workspaceId, toWrite.filter((snapshot): snapshot is BinarySnapshot => snapshot.kind === 'binary')),
    ]
    writeMs += Date.now() - writeStartedAt
    for (const skip of refused) skippedPaths.add(skip.path)
    run.skipped.push(...refused)
    for (const snapshot of snapshots) {
      if (snapshot.kind === 'binary' && !skippedPaths.has(snapshot.path)) binaryHashes.set(snapshot.path, snapshot.onDiskHash)
    }
    for (const snapshot of toWrite) if (!skippedPaths.has(snapshot.path)) run.progress.writtenPaths.push(snapshot.path)
    written += toWrite.length - refused.length
    if (next < liveHeads.length) {
      // Record this batch before the next, so a request that ends early
      // resumes from here rather than from the start of the page.
      for (const snapshot of snapshots) {
        const entry = headsByPath.get(snapshot.path)
        if (entry && !skippedPaths.has(snapshot.path)) recordEntry(entry)
      }
      await writeBaseline(previousBaseline?.progress)
    }
  }
  stage('kv_read', Date.now() - readMs, { heads: liveHeads.length - deferredHeads.length, deferred: deferredHeads.length })
  stage('sandbox_write', Date.now() - writeMs, { files: written })

  const previousProcessedHeadCount = previousBaseline?.progress?.operation === 'hydrate' ? previousBaseline.progress.processedHeadCount : 0
  const protectedInPage = page.entries.filter((entry) => conflictPaths.has(entry.path) || appliedPaths.has(entry.path)).length
  const unchanged = Math.max(0, page.entries.length - changedHeads.length - protectedInPage)
  if (deferredHeads.length > 0) {
    // The baseline holds every batch written above and keeps the previous
    // resume point, so the next call re-lists this page and copies the rest.
    return {
      deferred: { pendingPaths: deferredHeads.map((entry) => entry.path), morePages: !page.complete },
      complete: false,
      cursor: cursor ?? null,
      processedHeadCount: previousProcessedHeadCount,
      written,
      deleted,
      unchanged,
    }
  }

  const appliedBinaryHashes = await mapWithConcurrency(
    page.entries.filter((entry) => appliedPaths.has(entry.path) && !entry.deleted),
    VAULT_IO_CONCURRENCY,
    async (entry): Promise<readonly [string, string] | null> => {
      const state = await vault.readVaultFileState(workspaceId, entry.path)
      if (state.deleted || state.content === null) return null
      const payload = vaultBinaryPayload(vault.codec, state.content)
      return payload === null ? null : [entry.path, await sha256Hex(base64ToBytes(payload))] as const
    },
  )
  for (const entry of appliedBinaryHashes) if (entry) binaryHashes.set(entry[0], entry[1])
  for (const entry of page.entries) {
    if (conflictPaths.has(entry.path) || skippedPaths.has(entry.path)) continue
    recordEntry(entry)
  }
  for (const path of missingBaselinePaths) delete baselineFiles[path]

  const processedHeadCount = previousProcessedHeadCount + page.entries.length
  // A current-schema baseline for this incarnation that already records every
  // head exactly as listed stays as it is: rewriting it cost a Durable Object
  // round trip on every turn of a running box (167-332 ms on staging).
  const baselineUnchanged = page.complete && previousBaseline !== null && !legacyBaseline
    && !previousBaseline.progress && sameBaselineFiles(previousBaseline.files, baselineFiles)
  if (!baselineUnchanged) {
    await writeBaseline(page.complete || page.cursor === null
      ? undefined
      : { operation: 'hydrate' as const, cursor: page.cursor, processedHeadCount, unseenBaselinePaths: [...unseenBaselinePaths].sort() })
  }
  return { deferred: null, complete: page.complete, cursor: page.cursor, processedHeadCount, written, deleted, unchanged }
}

/** Snapshots whose exact bytes the box already holds as a regular file reached without a symlink. A failed check proves nothing. */
async function pathsAlreadyOnBox(config: SandboxVaultSyncConfig, box: VaultHydrationBox, snapshots: Snapshot[]): Promise<Set<string>> {
  const present = new Set<string>()
  if (snapshots.length === 0) return present
  const expected = new Map<string, string>()
  for (const snapshot of snapshots) {
    expected.set(snapshot.path, snapshot.kind === 'binary' ? snapshot.onDiskHash : await sha256Hex(snapshot.content))
  }
  const rootPrefix = `${config.root}/`
  const command = `for p in ${[...expected.keys()].map((path) => shellQuote(rootPrefix + path)).join(' ')}; do `
    + 'r="$(realpath -e -- "$p" 2>/dev/null)" && [ "$r" = "$p" ] && [ -f "$p" ] && sha256sum -z -- "$p"; done 2>/dev/null; exit 0'
  let stdout: string
  try {
    stdout = (await box.exec(command)).stdout
  } catch {
    return present
  }
  for (const record of stdout.split('\0').filter(Boolean)) {
    const parsed = /^([a-f0-9]{64}) [ *]([\s\S]+)$/.exec(record)
    if (!parsed) continue
    const path = parsed[2]!.startsWith(rootPrefix) ? parsed[2]!.slice(rootPrefix.length) : parsed[2]!
    if (expected.get(path) === parsed[1]) present.add(path)
  }
  return present
}

async function readSnapshot(
  config: SandboxVaultSyncConfig,
  workspaceId: string,
  entry: VaultHeadListEntry,
  skippedPaths: Set<string>,
): Promise<Snapshot | null> {
  try {
    const state = await config.vault.readVaultFileState(workspaceId, entry.path)
    if (state.deleted || state.content === null || !state.revision || !state.contentHash) {
      throw new Error(`Vault head is incomplete for ${entry.path}`)
    }
    const payload = vaultBinaryPayload(config.vault.codec, state.content)
    if (payload !== null) {
      return { kind: 'binary', path: entry.path, payload, onDiskHash: await sha256Hex(base64ToBytes(payload)) }
    }
    return { kind: 'text', path: entry.path, content: state.content }
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: unknown }).code === 'vault.file_not_found') {
      skippedPaths.add(entry.path)
      return null
    }
    throw new VaultHydrationError(`Failed to read Vault file during sandbox hydration: ${entry.path}`, error)
  }
}

/** Text files go in JSON requests under the proxy's body cap; one too large for any request goes as bytes. */
async function writeTextSnapshots(config: SandboxVaultSyncConfig, box: VaultHydrationBox, texts: TextSnapshot[]): Promise<VaultBoxSyncSkip[]> {
  const skipped: VaultBoxSyncSkip[] = []
  let request: Array<{ path: string; content: string }> = []
  let requestBytes = 0
  const flush = async () => {
    if (request.length === 0) return
    await (config.writeText ? config.writeText(box, request) : box.fs.writeMany(request))
    request = []
    requestBytes = 0
  }
  for (const text of texts) {
    const path = boxPath(config, text.path)
    const bytes = encoder.encode(JSON.stringify({ path, content: text.content })).byteLength
    if (bytes > VAULT_TEXT_WRITE_MAX_JSON_BYTES) {
      const skip = await uploadFile(config, box, text.path, encoder.encode(text.content))
      if (skip) skipped.push(skip)
      continue
    }
    if (requestBytes + bytes > VAULT_TEXT_WRITE_MAX_JSON_BYTES) await flush()
    request.push({ path, content: text.content })
    requestBytes += bytes
  }
  await flush()
  return skipped
}

/** Upload bytes to the box, or the skip when the box refuses them for their size and the product leaves such files off. */
async function uploadFile(config: SandboxVaultSyncConfig, box: VaultHydrationBox, vaultPath: string, data: Uint8Array): Promise<VaultBoxSyncSkip | null> {
  let result: unknown
  try {
    result = await box.fs.uploadData(boxPath(config, vaultPath), data)
  } catch (error) {
    const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
    if (config.skipOversizeFiles && error instanceof Error && (code === 'PAYLOAD_TOO_LARGE' || code === 'FILE_TOO_LARGE' || status === 413)) {
      console.warn('[vault] file is too large to hydrate; the agent reads it through the Vault API', { path: vaultPath, detail: error.message })
      return { path: vaultPath, reason: 'too_large', detail: error.message }
    }
    throw new VaultHydrationError(`Failed to upload Vault file ${vaultPath}`, error)
  }
  const size = (result as { size?: unknown } | undefined)?.size
  if (typeof size === 'number' && size !== data.byteLength) {
    throw new VaultHydrationError(`Failed to upload Vault file ${vaultPath}`, new Error(`expected ${data.byteLength} uploaded bytes, received ${size}`))
  }
  return null
}

async function writeBinaries(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  snapshots: BinarySnapshot[],
): Promise<VaultBoxSyncSkip[]> {
  const skips = await mapWithConcurrency(snapshots, BINARY_HYDRATION_CONCURRENCY, (binary) => uploadFile(config, box, binary.path, base64ToBytes(binary.payload)))
  const skipped = skips.filter((skip): skip is VaultBoxSyncSkip => skip !== null)
  const binaries = snapshots.filter((binary) => !skipped.some((skip) => skip.path === binary.path))
  if (binaries.length === 0) return skipped

  const verification = await box.exec(`sha256sum -z -- ${binaries.map((binary) => shellQuote(boxPath(config, binary.path))).join(' ')}`)
  if (verification.exitCode !== 0) {
    throw new VaultHydrationError(
      `Failed to verify hydrated binary Vault files for ${workspaceId}`,
      new Error(verification.stderr || `sha256sum exited ${verification.exitCode}`),
    )
  }
  const observed = new Map<string, string>()
  const rootPrefix = `${config.root}/`
  for (const record of verification.stdout.split('\0').filter(Boolean)) {
    const parsed = /^([a-f0-9]{64}) [ *]([\s\S]+)$/.exec(record)
    if (!parsed) {
      throw new VaultHydrationError(`Malformed sha256sum record while verifying hydrated binaries for ${workspaceId}`, new Error(record))
    }
    const observedPath = parsed[2]!
    observed.set(observedPath.startsWith(rootPrefix) ? observedPath.slice(rootPrefix.length) : observedPath, parsed[1]!)
  }
  for (const binary of binaries) {
    if (observed.get(binary.path) !== binary.onDiskHash) {
      throw new VaultHydrationError(
        `Hydrated binary Vault file ${binary.path} does not match its expected bytes`,
        new Error(`expected ${binary.onDiskHash}, box reported ${observed.get(binary.path) ?? 'nothing'}`),
      )
    }
  }
  return skipped
}

function sameBaselineFiles(previous: VaultSandboxBaseline['files'], next: VaultSandboxBaseline['files']): boolean {
  const paths = Object.keys(next)
  if (paths.length !== Object.keys(previous).length) return false
  return paths.every((path) => {
    const a = previous[path]
    const b = next[path]!
    return a !== undefined
      && a.revision === b.revision
      && a.contentHash === b.contentHash
      && a.deleted === b.deleted
      && Boolean(a.binary) === Boolean(b.binary)
      && (a.onDiskHash ?? null) === (b.onDiskHash ?? null)
  })
}

function boxPath(config: SandboxVaultSyncConfig, vaultPath: string): string {
  return `${config.root}/${vaultPath}`
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
