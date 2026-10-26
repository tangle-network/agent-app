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
  baselineDescribesRoot,
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
} from './sandbox-sync'

const VAULT_IO_CONCURRENCY = 8
const BINARY_HYDRATION_CONCURRENCY = 2
const VAULT_HYDRATION_HEAD_PAGE_SIZE = 100
const VAULT_HYDRATION_MAX_PAGES = 200
/** Vault characters read before they are written to the box, so a page of large files never sits in memory at once. */
const VAULT_HYDRATION_BATCH_CHARS = 2_000_000
/** Vault characters one call copies before it defers the rest to the next call, so a cold box never holds one request past its limits. */
const VAULT_HYDRATION_REQUEST_CHARS = 12_000_000
// The sandbox proxy refuses a request body over 1,048,576 bytes. A text file
// write is JSON, so the budget keeps 16 KiB of headroom for the envelope; a file
// that cannot fit one request alone is uploaded as bytes instead.
const VAULT_TEXT_WRITE_MAX_JSON_BYTES = 1024 * 1024 - 16 * 1024
/** Paths one on-box hash check names. */
const VAULT_ON_BOX_CHECK_PATHS = 200

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
  /** Vault paths this call wrote to the box. */
  writtenPaths: string[]
  /** Files the box refused for size. They stay off the box and out of the baseline; the agent reads them through the Vault API. */
  skipped: VaultBoxSyncSkip[]
  /** Set when the call reached its copy budget: the baseline holds every batch written, and the next call resumes from it. */
  deferred: { pendingPaths: string[]; morePages: boolean } | null
  /** True when the coordinator's record proved the box current and nothing was listed or written. */
  inSync?: boolean
}

export interface VaultHydrationOptions {
  /** Paths a reconciliation parked as conflicts; hydration leaves both copies alone. */
  conflictPaths?: ReadonlySet<string>
  /** Paths the reconciliation just committed from the box; already current on the box. */
  appliedPaths?: ReadonlySet<string>
  /** May still be in flight (the Vault-loss probe): hydrate awaits it only to compare heads. */
  pathsMissingFromBox?: ReadonlySet<string> | Promise<ReadonlySet<string>>
  /** Vault characters this call may copy before deferring the rest (default 12,000,000). */
  maxChars?: number
}

interface TextSnapshot { kind: 'text'; path: string; content: string }
interface BinarySnapshot { kind: 'binary'; path: string; payload: string; onDiskHash: string }
type Snapshot = TextSnapshot | BinarySnapshot

interface PageResult {
  complete: boolean
  cursor: string | null
  processedHeadCount: number
  writtenPaths: string[]
  deleted: number
  unchanged: number
  skipped: VaultBoxSyncSkip[]
  deferred: { pendingPaths: string[]; morePages: boolean } | null
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
    // The record names the directory it hydrated, so a moved Vault directory walks in full.
    const contract = `${config.contract ?? SANDBOX_VAULT_SYNC_CONTRACT}@${config.root}`
    const incarnation = readReadySandboxFilesystemIncarnation(box)
    const identity = box.id && incarnation.succeeded
      ? { sandboxId: box.id, filesystemIncarnationId: incarnation.value.id }
      : null
    const protectedPaths = Boolean(options.conflictPaths?.size || options.appliedPaths?.size)
      || options.pathsMissingFromBox !== undefined
    const view = identity ? await config.vault.readVaultBoxState(workspaceId) : null
    if (identity && !protectedPaths && vaultBoxInSync(view, identity, contract)) {
      return {
        succeeded: true,
        value: {
          written: 0, deleted: 0, unchanged: 0, processedHeads: 0, writtenPaths: [],
          skipped: view?.sync?.skipped ? [...view.sync.skipped] : [], deferred: null, inSync: true,
        },
      }
    }
    // The Vault directory is needed only before the first box write, so its
    // round trip overlaps the baseline read and the head listing.
    const vaultDir = box.fs.mkdir(config.root, { recursive: true })
    vaultDir.catch(() => {})
    const budget = { remainingChars: options.maxChars ?? VAULT_HYDRATION_REQUEST_CHARS }
    const writtenPaths: string[] = []
    const skipped = new Map<string, VaultBoxSyncSkip>()
    let deleted = 0
    let unchanged = 0
    let processedHeadCount = 0
    for (let pageIndex = 0; pageIndex < VAULT_HYDRATION_MAX_PAGES; pageIndex += 1) {
      const page = await hydratePage(config, box, workspaceId, options, vaultDir, budget)
      writtenPaths.push(...page.writtenPaths)
      for (const skip of page.skipped) skipped.set(skip.path, skip)
      deleted += page.deleted
      unchanged += page.unchanged
      processedHeadCount = page.processedHeadCount
      const stats = (): VaultHydrationStats => ({
        written: writtenPaths.length, deleted, unchanged, processedHeads: processedHeadCount,
        writtenPaths, skipped: [...skipped.values()], deferred: page.deferred,
      })
      if (page.deferred) return { succeeded: true, value: stats() }
      if (page.complete) {
        if (identity && view && !view.inFlight && skipped.size <= VAULT_BOX_SYNC_MAX_SKIPS) {
          // Recorded against the count read before the listing: a mutation
          // during this walk moved it, so the record cannot match and the next
          // turn walks again. A failed record only costs that next walk.
          await config.vault.recordVaultBoxSync(workspaceId, {
            ...identity, contract, generation: view.generation, skipped: [...skipped.values()],
          }).catch((error: unknown) => console.warn('[vault] box sync record failed', {
            workspaceId, error: error instanceof Error ? error.message : String(error),
          }))
        }
        return { succeeded: true, value: stats() }
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
  budget: { remainingChars: number },
): Promise<PageResult> {
  const { vault } = config
  if (!box.id) throw new Error(`Cannot hydrate Vault for ${workspaceId}: sandbox id is missing`)
  const incarnation = readReadySandboxFilesystemIncarnation(box)
  if (!incarnation.succeeded) throw incarnation.error

  const normalized = normalizeVaultSandboxBaseline(await vault.readVaultSandboxBaseline(workspaceId, box.id))
  // A baseline describes one box directory; one recorded for another root says nothing about this one.
  const baselineMatchesIncarnation = normalized.baseline?.schema === VAULT_SANDBOX_BASELINE_SCHEMA
    && normalized.baseline.filesystemIncarnationId === incarnation.value.id
    && baselineDescribesRoot(normalized.baseline, config.root, config.legacyRoot)
  const previousBaseline = baselineMatchesIncarnation ? normalized.baseline : null
  const legacyBaseline = baselineMatchesIncarnation ? normalized.legacy : false
  const cursor = previousBaseline?.progress?.operation === 'hydrate' ? previousBaseline.progress.cursor : undefined
  const page = await vault.listVaultHeadPage(workspaceId, { cursor, limit: VAULT_HYDRATION_HEAD_PAGE_SIZE })
  // A v2 baseline cannot prove binary heads hold decoded bytes. Its carried
  // entries lose their revision, so every head this walk has not reached yet
  // stays due for rewrite even after a current baseline is written mid-walk.
  const baselineFiles: VaultSandboxBaseline['files'] = legacyBaseline
    ? Object.fromEntries(Object.entries(previousBaseline?.files ?? {}).map(([path, file]) => [
        path, file.deleted ? file : { ...file, revision: null },
      ]))
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
      appliedPaths.has(entry.path) && previous?.binary
      && previous.revision === entry.revision && previous.contentHash === entry.contentHash && previous.deleted === entry.deleted
    ) {
      baselineFiles[entry.path] = previous
    } else {
      baselineFiles[entry.path] = { revision: entry.revision, contentHash: entry.contentHash, deleted: entry.deleted }
    }
  }
  const commitBaseline = (progress: VaultSandboxBaseline['progress']) => vault.writeVaultSandboxBaseline({
    schema: VAULT_SANDBOX_BASELINE_SCHEMA,
    workspaceId,
    sandboxId: box.id,
    filesystemIncarnationId: incarnation.value.id,
    mirrorRoot: config.root,
    files: baselineFiles,
    ...(progress ? { progress } : {}),
    updatedAt: new Date().toISOString(),
  })

  // Read and write the changed heads in bounded batches, so a page of large
  // files never sits in memory at once.
  const writtenPaths: string[] = []
  const skipped: VaultBoxSyncSkip[] = []
  let alreadyOnBox = 0
  let deferredHeads: VaultHeadListEntry[] = []
  const liveHeads = changedHeads.filter((entry) => !entry.deleted)
  const headsByPath = new Map(liveHeads.map((entry) => [entry.path, entry]))
  for (let next = 0; next < liveHeads.length;) {
    if (budget.remainingChars <= 0) {
      deferredHeads = liveHeads.slice(next)
      break
    }
    const snapshots: Snapshot[] = []
    let batchChars = 0
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
    budget.remainingChars -= batchChars
    // A path with no baseline entry may already hold the head's bytes, as every
    // file of a box restored from a snapshot does, some under an owner the file
    // API refuses to overwrite. Identical files stay in place.
    const unproven = new Map<string, string>()
    for (const snapshot of snapshots) {
      if (baselineFiles[snapshot.path] !== undefined || pathsMissingFromBox.has(snapshot.path)) continue
      unproven.set(snapshot.path, snapshot.kind === 'binary' ? snapshot.onDiskHash : await sha256Hex(encoder.encode(snapshot.content)))
    }
    const onBox = await vaultPathsAlreadyOnBox(config, box, workspaceId, unproven)
    const toWrite = snapshots.filter((snapshot) => !onBox.has(snapshot.path))
    const batchSkipped = [
      ...await writeTextSnapshots(config, box, toWrite.filter((snapshot): snapshot is TextSnapshot => snapshot.kind === 'text')),
      ...await writeBinaries(config, box, workspaceId, toWrite.filter((snapshot): snapshot is BinarySnapshot => snapshot.kind === 'binary')),
    ]
    for (const skip of batchSkipped) {
      console.warn('[vault] file is too large for the box; the agent reads it through the Vault API', { workspaceId, path: skip.path })
      skippedPaths.add(skip.path)
      skipped.push(skip)
    }
    for (const snapshot of snapshots) {
      if (snapshot.kind === 'binary' && !skippedPaths.has(snapshot.path)) binaryHashes.set(snapshot.path, snapshot.onDiskHash)
    }
    for (const snapshot of toWrite) if (!skippedPaths.has(snapshot.path)) writtenPaths.push(snapshot.path)
    alreadyOnBox += onBox.size
    if (next < liveHeads.length) {
      // Record this batch before the next one, so a call that ends early
      // resumes from here rather than from the page start.
      for (const snapshot of snapshots) {
        const entry = headsByPath.get(snapshot.path)
        if (entry && !skippedPaths.has(snapshot.path)) recordEntry(entry)
      }
      await commitBaseline(previousBaseline?.progress)
    }
  }

  const previousProcessedHeadCount = previousBaseline?.progress?.operation === 'hydrate'
    ? previousBaseline.progress.processedHeadCount
    : 0
  const protectedInPage = page.entries.filter((entry) => conflictPaths.has(entry.path) || appliedPaths.has(entry.path)).length
  const unchanged = Math.max(0, page.entries.length - changedHeads.length - protectedInPage) + alreadyOnBox
  if (deferredHeads.length > 0) {
    // The baseline holds every batch written above and keeps the previous
    // resume point, so the next call re-lists this page and copies only what
    // is still missing.
    return {
      complete: false,
      cursor: cursor ?? null,
      processedHeadCount: previousProcessedHeadCount,
      writtenPaths,
      deleted,
      unchanged,
      skipped,
      deferred: { pendingPaths: deferredHeads.map((entry) => entry.path), morePages: !page.complete },
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
    && !previousBaseline.progress && previousBaseline.mirrorRoot === config.root
    && sameBaselineFiles(previousBaseline.files, baselineFiles)
  if (!baselineUnchanged) {
    await commitBaseline(page.complete || page.cursor === null ? undefined : {
      operation: 'hydrate' as const,
      cursor: page.cursor,
      processedHeadCount,
      unseenBaselinePaths: [...unseenBaselinePaths].sort(),
    })
  }

  return {
    complete: page.complete,
    cursor: page.cursor,
    processedHeadCount,
    writtenPaths,
    deleted,
    unchanged,
    skipped,
    deferred: null,
  }
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

/**
 * Text files go in JSON requests under the proxy's body cap; one too large for
 * any request goes as bytes. Returns the files the box refused for size.
 */
async function writeTextSnapshots(config: SandboxVaultSyncConfig, box: VaultHydrationBox, texts: TextSnapshot[]): Promise<VaultBoxSyncSkip[]> {
  const skipped: VaultBoxSyncSkip[] = []
  let request: Array<{ path: string; content: string }> = []
  let requestBytes = 0
  const flush = async () => {
    if (request.length === 0) return
    await box.fs.writeMany(request)
    request = []
    requestBytes = 0
  }
  for (const text of texts) {
    const path = boxPath(config, text.path)
    const bytes = encoder.encode(JSON.stringify({ path, content: text.content })).byteLength
    if (bytes > VAULT_TEXT_WRITE_MAX_JSON_BYTES) {
      const data = encoder.encode(text.content)
      let result: unknown
      try {
        result = await box.fs.uploadData(path, data)
      } catch (error) {
        if (isFileTooLargeError(error)) {
          skipped.push({ path: text.path, reason: 'too_large', detail: error.message })
          continue
        }
        throw new VaultHydrationError(`Failed to upload Vault file ${text.path}`, error)
      }
      const size = (result as { size?: unknown } | undefined)?.size
      if (typeof size === 'number' && size !== data.byteLength) {
        throw new VaultHydrationError(`Failed to upload Vault file ${text.path}`, new Error(`expected ${data.byteLength} uploaded bytes, received ${size}`))
      }
      continue
    }
    if (requestBytes + bytes > VAULT_TEXT_WRITE_MAX_JSON_BYTES) await flush()
    request.push({ path, content: text.content })
    requestBytes += bytes
  }
  await flush()
  return skipped
}

/** Upload binaries, then prove each produced the exact bytes by its on-disk SHA-256. Returns the files the box refused for size. */
async function writeBinaries(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  binaries: BinarySnapshot[],
): Promise<VaultBoxSyncSkip[]> {
  const skipped: VaultBoxSyncSkip[] = []
  await mapWithConcurrency(binaries, BINARY_HYDRATION_CONCURRENCY, async (binary) => {
    try {
      const bytes = base64ToBytes(binary.payload)
      const result = await box.fs.uploadData(boxPath(config, binary.path), bytes)
      const size = (result as { size?: unknown } | undefined)?.size
      if (typeof size === 'number' && size !== bytes.byteLength) {
        throw new Error(`expected ${bytes.byteLength} uploaded bytes, received ${size}`)
      }
    } catch (error) {
      if (isFileTooLargeError(error)) {
        skipped.push({ path: binary.path, reason: 'too_large', detail: error.message })
        return
      }
      throw new VaultHydrationError(`Failed to upload binary Vault file ${binary.path} for ${workspaceId}`, error)
    }
  })
  const skippedPaths = new Set(skipped.map((skip) => skip.path))
  const uploaded = binaries.filter((binary) => !skippedPaths.has(binary.path))
  if (uploaded.length === 0) return skipped

  const verification = await box.exec(`sha256sum -z -- ${uploaded.map((binary) => shellQuote(boxPath(config, binary.path))).join(' ')}`)
  if (verification.exitCode !== 0) {
    throw new VaultHydrationError(
      `Failed to verify hydrated binary Vault files for ${workspaceId}`,
      new Error(verification.stderr || `sha256sum exited ${verification.exitCode}`),
    )
  }
  const observed = parseSha256Records(config, verification.stdout)
  if (observed === null) {
    throw new VaultHydrationError(`Malformed sha256sum record while verifying hydrated binaries for ${workspaceId}`, new Error(verification.stdout.slice(0, 200)))
  }
  for (const binary of uploaded) {
    if (observed.get(binary.path) !== binary.onDiskHash) {
      throw new VaultHydrationError(
        `Hydrated binary Vault file ${binary.path} does not match its expected bytes`,
        new Error(`expected ${binary.onDiskHash}, box reported ${observed.get(binary.path) ?? 'nothing'}`),
      )
    }
  }
  return skipped
}

/**
 * Paths whose bytes on the box already equal the expected SHA-256. Only a
 * regular file reached without a symlink counts. A failed check proves nothing,
 * and every path is then written.
 */
async function vaultPathsAlreadyOnBox(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  expected: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const present = new Set<string>()
  const paths = [...expected.keys()]
  // Bounded groups keep each command far under the sandbox proxy's body cap.
  for (let start = 0; start < paths.length; start += VAULT_ON_BOX_CHECK_PATHS) {
    const command = `for p in ${paths.slice(start, start + VAULT_ON_BOX_CHECK_PATHS).map((path) => shellQuote(boxPath(config, path))).join(' ')}; do `
      + 'r="$(realpath -e -- "$p" 2>/dev/null)" && [ "$r" = "$p" ] && [ -f "$p" ] && sha256sum -z -- "$p"; done 2>/dev/null; exit 0'
    let stdout: string
    try {
      stdout = (await box.exec(command)).stdout
    } catch (error) {
      console.warn('[vault] on-box hash check failed; hydration writes those paths', {
        workspaceId, pathCount: expected.size, error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    for (const [path, hash] of parseSha256Records(config, stdout) ?? []) {
      if (expected.get(path) === hash) present.add(path)
    }
  }
  return present
}

/** `sha256sum -z` records keyed by Vault path, or null when a record is malformed. */
function parseSha256Records(config: SandboxVaultSyncConfig, stdout: string): Map<string, string> | null {
  const observed = new Map<string, string>()
  const rootPrefix = `${config.root}/`
  for (const record of stdout.split('\0').filter(Boolean)) {
    const parsed = /^([a-f0-9]{64}) [ *]([\s\S]+)$/.exec(record)
    if (!parsed) return null
    const observedPath = parsed[2]!
    observed.set(observedPath.startsWith(rootPrefix) ? observedPath.slice(rootPrefix.length) : observedPath, parsed[1]!)
  }
  return observed
}

/** The sandbox refuses a file for size with 413 or a size code; any other failure is real. */
function isFileTooLargeError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const { code, status } = error as Error & { code?: unknown; status?: unknown }
  return code === 'PAYLOAD_TOO_LARGE' || code === 'FILE_TOO_LARGE' || status === 413
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
