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
import {
  mapWithConcurrency,
  normalizeVaultSandboxBaseline,
  readReadySandboxFilesystemIncarnation,
  vaultBinaryPayload,
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
}

export interface VaultHydrationOptions {
  /** Paths a reconciliation parked as conflicts; hydration leaves both copies alone. */
  conflictPaths?: ReadonlySet<string>
  /** Paths the reconciliation just committed from the box; already current on the box. */
  appliedPaths?: ReadonlySet<string>
  /** May still be in flight (the Vault-loss probe): hydrate awaits it only to compare heads. */
  pathsMissingFromBox?: ReadonlySet<string> | Promise<ReadonlySet<string>>
}

interface TextSnapshot { kind: 'text'; path: string; content: string }
interface BinarySnapshot { kind: 'binary'; path: string; payload: string; onDiskHash: string }
type Snapshot = TextSnapshot | BinarySnapshot

interface PageResult {
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
    // The Vault directory is needed only before the first box write, so its
    // round trip overlaps the baseline read and the head listing.
    const vaultDir = box.fs.mkdir(config.root, { recursive: true })
    vaultDir.catch(() => {})
    let written = 0
    let deleted = 0
    let unchanged = 0
    let processedHeadCount = 0
    for (let pageIndex = 0; pageIndex < VAULT_HYDRATION_MAX_PAGES; pageIndex += 1) {
      const page = await hydratePage(config, box, workspaceId, options, vaultDir)
      written += page.written
      deleted += page.deleted
      unchanged += page.unchanged
      processedHeadCount = page.processedHeadCount
      if (page.complete) {
        return { succeeded: true, value: { written, deleted, unchanged, processedHeads: processedHeadCount } }
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
): Promise<PageResult> {
  const { vault } = config
  if (!box.id) throw new Error(`Cannot hydrate Vault for ${workspaceId}: sandbox id is missing`)
  const incarnation = readReadySandboxFilesystemIncarnation(box)
  if (!incarnation.succeeded) throw incarnation.error

  const normalized = normalizeVaultSandboxBaseline(await vault.readVaultSandboxBaseline(workspaceId, box.id))
  const baselineMatchesIncarnation = normalized.baseline?.schema === VAULT_SANDBOX_BASELINE_SCHEMA
    && normalized.baseline.filesystemIncarnationId === incarnation.value.id
  const previousBaseline = baselineMatchesIncarnation ? normalized.baseline : null
  const legacyBaseline = baselineMatchesIncarnation ? normalized.legacy : false
  const cursor = previousBaseline?.progress?.operation === 'hydrate' ? previousBaseline.progress.cursor : undefined
  const page = await vault.listVaultHeadPage(workspaceId, { cursor, limit: VAULT_HYDRATION_HEAD_PAGE_SIZE })
  const baselineFiles: VaultSandboxBaseline['files'] = { ...(previousBaseline?.files ?? {}) }
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

  // Read and write the changed heads in bounded batches, so a page of large
  // files never sits in memory at once.
  const binaryHashes = new Map<string, string>()
  let written = 0
  const liveHeads = changedHeads.filter((entry) => !entry.deleted)
  for (let next = 0; next < liveHeads.length;) {
    const batch: VaultHeadListEntry[] = []
    const snapshots: Snapshot[] = []
    let batchChars = 0
    while (next < liveHeads.length && batchChars < VAULT_HYDRATION_BATCH_CHARS) {
      const slice = liveHeads.slice(next, next + VAULT_IO_CONCURRENCY)
      next += slice.length
      batch.push(...slice)
      const read = await mapWithConcurrency(slice, VAULT_IO_CONCURRENCY, async (entry) => readSnapshot(config, workspaceId, entry, skippedPaths))
      for (const snapshot of read) {
        if (!snapshot) continue
        snapshots.push(snapshot)
        batchChars += snapshot.kind === 'text' ? snapshot.content.length : snapshot.payload.length
      }
    }
    await writeTextSnapshots(config, box, snapshots.filter((snapshot): snapshot is TextSnapshot => snapshot.kind === 'text'))
    const binaries = snapshots.filter((snapshot): snapshot is BinarySnapshot => snapshot.kind === 'binary')
    await writeBinaries(config, box, workspaceId, binaries)
    for (const binary of binaries) binaryHashes.set(binary.path, binary.onDiskHash)
    written += snapshots.length
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
  for (const path of missingBaselinePaths) delete baselineFiles[path]

  const processedHeadCount = (
    previousBaseline?.progress?.operation === 'hydrate' ? previousBaseline.progress.processedHeadCount : 0
  ) + page.entries.length
  // A current-schema baseline for this incarnation that already records every
  // head exactly as listed stays as it is: rewriting it cost a Durable Object
  // round trip on every turn of a running box (167-332 ms on staging).
  const baselineUnchanged = page.complete && previousBaseline !== null && !legacyBaseline
    && !previousBaseline.progress && sameBaselineFiles(previousBaseline.files, baselineFiles)
  if (!baselineUnchanged) {
    await vault.writeVaultSandboxBaseline({
      schema: VAULT_SANDBOX_BASELINE_SCHEMA,
      workspaceId,
      sandboxId: box.id,
      filesystemIncarnationId: incarnation.value.id,
      files: baselineFiles,
      ...(page.complete || page.cursor === null
        ? {}
        : {
            progress: {
              operation: 'hydrate' as const,
              cursor: page.cursor,
              processedHeadCount,
              unseenBaselinePaths: [...unseenBaselinePaths].sort(),
            },
          }),
      updatedAt: new Date().toISOString(),
    })
  }

  const protectedInPage = page.entries.filter((entry) => conflictPaths.has(entry.path) || appliedPaths.has(entry.path)).length
  return {
    complete: page.complete,
    cursor: page.cursor,
    processedHeadCount,
    written,
    deleted,
    unchanged: Math.max(0, page.entries.length - changedHeads.length - protectedInPage),
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

/** Text files go in JSON requests under the proxy's body cap; one too large for any request goes as bytes. */
async function writeTextSnapshots(config: SandboxVaultSyncConfig, box: VaultHydrationBox, texts: TextSnapshot[]): Promise<void> {
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
      const result = await box.fs.uploadData(path, data)
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
}

async function writeBinaries(
  config: SandboxVaultSyncConfig,
  box: VaultHydrationBox,
  workspaceId: string,
  binaries: BinarySnapshot[],
): Promise<void> {
  await mapWithConcurrency(binaries, BINARY_HYDRATION_CONCURRENCY, async (binary) => {
    try {
      const bytes = base64ToBytes(binary.payload)
      const result = await box.fs.uploadData(boxPath(config, binary.path), bytes)
      const size = (result as { size?: unknown } | undefined)?.size
      if (typeof size === 'number' && size !== bytes.byteLength) {
        throw new Error(`expected ${bytes.byteLength} uploaded bytes, received ${size}`)
      }
    } catch (error) {
      throw new VaultHydrationError(`Failed to upload binary Vault file ${binary.path} for ${workspaceId}`, error)
    }
  })
  if (binaries.length === 0) return

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
