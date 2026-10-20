import { Sandbox } from '@tangle-network/sandbox/core'
import { type ReuseChecks, type ReuseStateStore, workersReuseStore } from './reuse-state'
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { SandboxClientCredentials } from './credentials'
import type { SandboxRuntimeConfig, EnsureWorkspaceSandboxOptions, SandboxScope } from './configuration'

interface ClientCacheEntry {
  client: Sandbox
  fingerprint: string
}

let _cached: ClientCacheEntry | null = null

/**
 * How long a reuse trusts what it last checked on a running box instead of
 * repeating the round trip: the exec probe, the egress read, the runtime
 * environment push, and the spend gate. Every check belongs to one identity of
 * the box (its start time and filesystem incarnation, whichever the platform
 * reports), a box that is not running when read keeps none, and a failed first
 * call on the box drops them all ({@link dropTrustedBox}).
 */
export const TRUSTED_REUSE_TTL_MS = 10 * 60_000

const REUSE_CHECKS_MAX = 1_000

const reuseChecks = new Map<string, ReuseChecks>()

/** The running box last used under a box name, so a reuse reads it by id instead of listing every running box. A wrong id costs one read: the box read must carry the name. */
export const runningBoxIds = new Map<string, string>()

/** Boxes an ensure handed out without an exec probe, because a recent probe of this start had passed. */
export const trustedBoxes = new WeakSet<SandboxInstance>()

/** The box name each remembered box id serves, to find its shared state. */
const reuseNames = new Map<string, string>()

/** What this isolate last read from or wrote to the shared store, by box name, so an unchanged state is not written again. */
const savedShared = new Map<string, string>()

let defaultReuseStore: ReuseStateStore | null | undefined

/** The store the last ensure used, so a forgotten box is dropped from it too. */
let activeReuseStore: ReuseStateStore | null = null

/**
 * What tells one run of a box from the next. The Sandbox API reports no
 * `startedAt` on 2026-10-20 (neither a list row nor a get carries it), so the
 * filesystem incarnation stands in for a restored or replaced filesystem and the
 * start time joins it whenever the platform reports one. A box that is stopped
 * and resumed passes through a status the reuse reads, and resume, delete and a
 * failed probe forget it.
 */
function boxIdentity(box: SandboxInstance): string {
  const startedAt = box.startedAt instanceof Date ? box.startedAt.getTime() : Number.NaN
  return `${Number.isFinite(startedAt) ? startedAt : ''}|${box.filesystemIncarnationId ?? ''}`
}

/** The checks recorded for this identity of the box. A box with another identity keeps none. */
export function checksFor(box: SandboxInstance): ReuseChecks | undefined {
  const checks = reuseChecks.get(box.id)
  if (!checks) return undefined
  if (checks.identity !== boxIdentity(box)) {
    reuseChecks.delete(box.id)
    return undefined
  }
  return checks
}

export function recordCheck(box: SandboxInstance, patch: Omit<Partial<ReuseChecks>, 'identity'>): void {
  if (!box.id) return
  const current = checksFor(box) ?? { identity: boxIdentity(box) }
  reuseChecks.delete(box.id)
  reuseChecks.set(box.id, { ...current, ...patch })
  while (reuseChecks.size > REUSE_CHECKS_MAX) {
    const oldest = reuseChecks.keys().next().value
    if (oldest === undefined) break
    reuseChecks.delete(oldest)
  }
}

export function forgetBox(boxId: string): void {
  reuseChecks.delete(boxId)
  const name = reuseNames.get(boxId)
  if (name === undefined || !activeReuseStore) return
  savedShared.delete(name)
  // Best effort: a store that cannot drop it costs the other isolates a full check once the entry ages out.
  void Promise.resolve(activeReuseStore.drop(name)).catch(() => undefined)
}

export function isRecent(at: number | undefined, ttlMs: number, now = Date.now()): at is number {
  return at !== undefined && Number.isFinite(ttlMs) && ttlMs > 0 && now - at < ttlMs
}

/**
 * Forget what this isolate trusts about a box after the first real call on it
 * failed. Returns true when the ensure handed the box out without probing it, so
 * the caller may ensure once more and get the full verification; false when the
 * ensure had probed it and the failure is the box's own.
 */
export function dropTrustedBox(box: SandboxInstance): boolean {
  forgetBox(box.id)
  return trustedBoxes.delete(box)
}

export function getClientFromCreds(creds: SandboxClientCredentials): Sandbox {
  const fingerprint = `${creds.apiKey} ${creds.baseUrl}`
  if (_cached && _cached.fingerprint === fingerprint) return _cached.client

  const client = new Sandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl })
  _cached = { client, fingerprint }
  return client
}

// Sync client for non-scoped callers (secretStoreFromClient etc.). Resolves
// credentials with no scope; throws if the seam returns a Promise — scoped
// products must use the async ensureWorkspaceSandbox path.
/** Resolve a synchronous sandbox client from provided runtime configuration credentials */
export function getClient(shell: SandboxRuntimeConfig): Sandbox {
  const creds = shell.credentials()
  if (creds && typeof (creds as Promise<unknown>).then === 'function') {
    throw new Error('getClient: scoped (async) credentials require the async sandbox path')
  }
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')
  return getClientFromCreds(creds as SandboxClientCredentials)
}

/** Reset the process-local sandbox client and liveness-verification caches. */
export function resetClientCache(): void {
  _cached = null
  reuseChecks.clear()
  runningBoxIds.clear()
  reuseNames.clear()
  savedShared.clear()
  defaultReuseStore = undefined
  activeReuseStore = null
}

/** Remember the running box serving a box name, so the next reuse reads it by id. */
export function rememberRunningBox(name: string, box: SandboxInstance): SandboxInstance {
  runningBoxIds.delete(name)
  runningBoxIds.set(name, box.id)
  reuseNames.set(box.id, name)
  while (runningBoxIds.size > REUSE_CHECKS_MAX) {
    const oldest = runningBoxIds.keys().next().value
    if (oldest === undefined) break
    runningBoxIds.delete(oldest)
  }
  while (reuseNames.size > REUSE_CHECKS_MAX) {
    const oldest = reuseNames.keys().next().value
    if (oldest === undefined) break
    reuseNames.delete(oldest)
  }
  return box
}

function boxNameFor(shell: SandboxRuntimeConfig, options: EnsureWorkspaceSandboxOptions): string {
  const scope: SandboxScope = { workspaceId: options.workspaceId, ...(options.userId ? { userId: options.userId } : {}) }
  return shell.boxKey ? shell.boxKey(scope) : shell.name(options.workspaceId)
}

/** Whether this isolate probed the workspace's last-used box recently enough that a reuse would skip the probe. */
export function hasRecentProbe(shell: SandboxRuntimeConfig, options: EnsureWorkspaceSandboxOptions): boolean {
  const probe = shell.livenessProbe
  if (!probe || options.forceNew) return false
  const id = runningBoxIds.get(boxNameFor(shell, options))
  return isRecent(id === undefined ? undefined : reuseChecks.get(id)?.alive, probe.cacheTtlMs ?? TRUSTED_REUSE_TTL_MS)
}

function reuseStoreOf(shell: SandboxRuntimeConfig): ReuseStateStore | null {
  if (shell.reuseState !== undefined) return shell.reuseState
  if (defaultReuseStore === undefined) defaultReuseStore = workersReuseStore()
  return defaultReuseStore
}

/** Load what another isolate recorded about this workspace's box, unless this isolate already knows it. */
export async function hydrateReuseState(shell: SandboxRuntimeConfig, options: EnsureWorkspaceSandboxOptions): Promise<void> {
  if (options.forceNew) return
  const store = reuseStoreOf(shell)
  activeReuseStore = store
  if (!store) return
  const name = boxNameFor(shell, options)
  if (runningBoxIds.has(name)) return
  try {
    const shared = await store.load(name)
    if (!shared) return
    runningBoxIds.set(name, shared.boxId)
    reuseNames.set(shared.boxId, name)
    reuseChecks.set(shared.boxId, shared.checks)
    savedShared.set(name, JSON.stringify(shared))
  } catch {
    // A store that cannot answer is a miss: the reuse verifies in full.
  }
}

/** Share what this ensure learned about the box, unless the store already holds it. */
export async function persistReuseState(shell: SandboxRuntimeConfig, box: SandboxInstance): Promise<void> {
  const store = reuseStoreOf(shell)
  const name = reuseNames.get(box.id)
  const checks = reuseChecks.get(box.id)
  if (!store || name === undefined || !checks) return
  const state = { boxId: box.id, checks }
  const serialized = JSON.stringify(state)
  if (savedShared.get(name) === serialized) return
  try {
    await store.save(name, state)
    savedShared.set(name, serialized)
  } catch {
    // The next ensure in this isolate still trusts what it learned.
  }
}
