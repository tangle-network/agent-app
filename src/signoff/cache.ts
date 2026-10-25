import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import lockfile from 'proper-lockfile'

/** Defaults owned by signoff; callers can override only when explicitly testing. */
export const SIGNOFF_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1_000
export const SIGNOFF_CACHE_MAX_BYTES = 4 * 1024 ** 3

interface ActiveRun {
  readonly pid: number
  readonly host: string
  readonly processStart: string | null
  readonly tree: string
  readonly storeKey: string | null
}

export interface CachePruneResult {
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly removed: readonly string[]
  /** Linked trees whose Git metadata disappeared. Content is retained for its owner. */
  readonly orphaned: readonly string[]
  /** Allocated bytes in those trees, counting shared inodes once. Included in afterBytes. */
  readonly orphanedBytes: number
  /** Active or explicitly kept entries can temporarily hold the cache above its idle cap. */
  readonly overBudgetBytes: number
}

export interface CachePruneOptions {
  readonly nowMs?: number
  readonly maxAgeMs?: number
  readonly maxBytes?: number
  readonly keepPaths?: readonly string[]
}

interface CacheEntry {
  readonly path: string
  readonly kind: 'tree' | 'store'
  readonly mtimeMs: number
  readonly protected: boolean
  orphaned: boolean
  readonly inodes: Set<string>
}

function processStart(pid: number): string | null {
  try {
    // Linux field 22 is starttime; unlike a PID, it cannot be recycled while
    // this boot is running. Other hosts still use the conservative PID check.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch { return null }
}

/** Detached install/check processes can outlive the signoff coordinator. */
function hasRunProcesses(run: ActiveRun): boolean {
  if (process.platform !== 'linux') return true // cannot prove the run has stopped
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const proc = join('/proc', entry)
      try {
        // A pre-existing service cannot be a detached child of this run. Its
        // protected /proc files must not keep every crashed lease forever.
        const start = processStart(Number(entry))
        if (run.processStart && start && BigInt(start) < BigInt(run.processStart)) continue
        const cwd = readlinkSync(join(proc, 'cwd'))
        if (cwd === run.tree || cwd.startsWith(run.tree + sep)) return true
        const env = readFileSync(join(proc, 'environ'), 'utf8').split('\0')
        if (env.includes(`SIGNOFF_TREE=${run.tree}`)) return true
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
        return true // unreadable process state is not evidence that it stopped
      }
    }
    return false
  } catch { return true }
}

function alive(run: ActiveRun): boolean {
  if (run.host !== hostname()) return true // a configured shared cache may have another host's run
  try { process.kill(run.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return hasRunProcesses(run)
    return true // EPERM is not proof of a dead process
  }
  const currentStart = processStart(run.pid)
  return !run.processStart || !currentStart || currentStart === run.processStart || hasRunProcesses(run)
}

function cacheRoot(cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true })
  return realpathSync(cacheDir)
}

/** One short cross-process lock protects lease transitions and deletion decisions. */
export async function withCacheLock<T>(cacheDir: string, action: () => T | Promise<T>): Promise<T> {
  const release = await lockfile.lock(cacheRoot(cacheDir), {
    realpath: false,
    stale: 300_000,
    update: 30_000,
    retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
  })
  try { return await action() } finally { await release() }
}

function markerDir(cacheDir: string): string { return join(cacheDir, 'active') }

function writeMarker(path: string, run: ActiveRun): void {
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(run)}\n`, { flag: 'wx' })
  renameSync(temp, path)
}

/** Called only while holding the cache lock. Invalid markers fail closed. */
function protectedPaths(cacheDir: string): { paths: Set<string>; unknown: boolean } {
  const paths = new Set<string>()
  const root = markerDir(cacheDir)
  if (!existsSync(root)) return { paths, unknown: false }
  let unknown = false
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json')) continue
    const file = join(root, entry)
    let run: ActiveRun
    try {
      run = JSON.parse(readFileSync(file, 'utf8')) as ActiveRun
      if (!Number.isSafeInteger(run.pid) || run.pid <= 0 || typeof run.host !== 'string' ||
        typeof run.tree !== 'string' || !run.tree.startsWith(resolve(cacheDir) + sep) ||
        (run.processStart !== null && (typeof run.processStart !== 'string' || !/^\d+$/.test(run.processStart))) ||
        (run.storeKey !== null && (typeof run.storeKey !== 'string' || !/^[a-f0-9]{64}$/.test(run.storeKey)))) {
        unknown = true
        continue
      }
    } catch { unknown = true; continue }
    if (!alive(run)) { unlinkSync(file); continue }
    const tree = resolve(run.tree)
    if (tree.startsWith(resolve(cacheDir) + sep)) paths.add(tree)
    if (run.storeKey && /^[a-f0-9]{64}$/.test(run.storeKey)) {
      paths.add(join(cacheDir, 'stores', run.storeKey))
    }
  }
  return { paths, unknown }
}

/** Old signoff processes have no lease marker. Their PID-named trees still
 * protect both themselves and stores until those processes exit. */
function protectLegacyRuns(cacheDir: string, active: { paths: Set<string>; unknown: boolean }): void {
  const trees = join(cacheDir, 'trees')
  if (!existsSync(trees)) return
  for (const entry of readdirSync(trees, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const tree = join(trees, entry.name)
    if (active.paths.has(tree) || !existsSync(join(tree, '.git'))) continue
    const match = /-(\d+)$/.exec(entry.name)
    if (!match) continue
    const pid = Number(match[1])
    if (alive({ pid, host: hostname(), processStart: null, tree, storeKey: null })) {
      active.paths.add(tree)
      active.unknown = true // a pre-lease run did not record which store it uses
    }
  }
}

export interface SignoffCacheSession {
  readonly cacheDir: string
  protectStore(cacheKey: string): Promise<void>
  close(): Promise<void>
}

/** Register before creating the tree, so a concurrent prune cannot select it. */
export async function openSignoffCacheSession(cacheDir: string, tree: string): Promise<SignoffCacheSession> {
  const root = cacheRoot(cacheDir)
  const treePath = resolve(root, relative(resolve(cacheDir), resolve(tree)))
  const file = join(markerDir(root), `${process.pid}-${randomUUID()}.json`)
  let run: ActiveRun = { pid: process.pid, host: hostname(), processStart: processStart(process.pid),
    tree: treePath, storeKey: null }
  await withCacheLock(root, () => {
    mkdirSync(markerDir(root), { recursive: true })
    writeMarker(file, run)
  })
  return {
    cacheDir: root,
    protectStore: async (cacheKey) => {
      if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new Error('signoff: invalid store cache key')
      await withCacheLock(root, () => {
        run = { ...run, storeKey: cacheKey }
        writeMarker(file, run)
      })
    },
    close: async () => {
      await withCacheLock(root, () => { if (existsSync(file)) unlinkSync(file) })
    },
  }
}

/** Active store keys for resolveStore's existing generation cap. Hold the lock. */
export function activeStoreKeys(cacheDir: string): Set<string> {
  cacheDir = cacheRoot(cacheDir)
  const active = protectedPaths(cacheDir)
  protectLegacyRuns(cacheDir, active)
  const { paths, unknown } = active
  if (unknown && existsSync(join(cacheDir, 'stores'))) return new Set(readdirSync(join(cacheDir, 'stores'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  return new Set([...paths].filter((path) => path.startsWith(join(cacheDir, 'stores') + sep)).map((path) => basename(path)))
}

function allocatedBytes(stat: Stats): number {
  return process.platform === 'win32' ? stat.size : stat.blocks * 512
}

function collectInodes(path: string, keys: Set<string>, sizes: Map<string, number>): void {
  let stat: Stats
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const key = `${stat.dev}:${stat.ino}`
  keys.add(key)
  sizes.set(key, allocatedBytes(stat))
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  let children: string[]
  try { children = readdirSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const child of children) collectInodes(join(path, child), keys, sizes)
}

/** Only ENOENT proves vanished metadata; permission and I/O failures still refuse pruning. */
function missingGitMetadata(tree: string): boolean {
  try {
    const marker = join(tree, '.git')
    if (!lstatSync(marker).isFile()) return false
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(marker, 'utf8'))
    if (!pointer) return false
    const gitDir = resolve(tree, pointer[1]!)
    statSync(gitDir)
    // A linked tree names its common repository relative to its private Git directory.
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (!common) return false
    statSync(resolve(gitDir, common))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function entries(cacheDir: string, protectedSet: Set<string>, unknown: boolean): CacheEntry[] {
  const found: CacheEntry[] = []
  for (const [kind, child] of [['tree', 'trees'], ['store', 'stores']] as const) {
    const root = join(cacheDir, child)
    if (!existsSync(root) || !lstatSync(root).isDirectory()) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue // never follow a symlink out of this cache
      const path = join(root, entry.name)
      const recognized = kind === 'store' ? /^[a-f0-9]{64}$/.test(entry.name)
        : existsSync(join(path, '.git'))
      const orphaned = kind === 'tree' && recognized && missingGitMetadata(path)
      let mtimeMs: number
      try { mtimeMs = statSync(path).mtimeMs } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      found.push({ path, kind, mtimeMs, orphaned,
        protected: unknown || protectedSet.has(path) || !recognized || orphaned, inodes: new Set() })
    }
  }
  return found
}

function removeEntry(entry: CacheEntry): boolean {
  if (entry.kind === 'store') { rmSync(entry.path, { recursive: true, force: true }); return true }
  try {
    const current = lstatSync(entry.path)
    if (!current.isDirectory() || !entry.inodes.has(`${current.dev}:${current.ino}`)) {
      throw new Error(`signoff: cached worktree changed before retirement: ${entry.path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  if (missingGitMetadata(entry.path)) { entry.orphaned = true; return false }
  // Trees are registered Git worktrees, not ordinary scratch directories.
  const git = spawnSync('git', ['-C', entry.path, 'worktree', 'remove', '--force', entry.path], { encoding: 'utf8' })
  if (git.error) throw new Error(`signoff: cannot start Git to retire cached worktree ${entry.path}`, { cause: git.error })
  if (git.status === 0) return true
  // Another owner may retire the source checkout between selection and Git's removal.
  // Preserve any remaining content, but never turn an unrelated Git failure into success.
  try { lstatSync(entry.path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  if (missingGitMetadata(entry.path)) { entry.orphaned = true; return false }
  throw new Error(`signoff: cannot retire cached worktree ${entry.path}: ${git.stderr.trim()}`)
}

/** Bound idle trees and stores by age first, then allocated physical bytes. */
export async function pruneSignoffCache(cacheDir: string, options: CachePruneOptions = {}): Promise<CachePruneResult> {
  const root = cacheRoot(cacheDir)
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? SIGNOFF_CACHE_MAX_AGE_MS
  const maxBytes = options.maxBytes ?? SIGNOFF_CACHE_MAX_BYTES
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('signoff: cache limits must be non-negative finite numbers')
  }
  return withCacheLock(root, () => {
    const active = protectedPaths(root)
    protectLegacyRuns(root, active)
    for (const path of options.keepPaths ?? []) active.paths.add(resolve(path))
    const candidates = entries(root, active.paths, active.unknown)
    const sizes = new Map<string, number>()
    const references = new Map<string, number>()
    for (const entry of candidates) {
      collectInodes(entry.path, entry.inodes, sizes)
      for (const key of entry.inodes) references.set(key, (references.get(key) ?? 0) + 1)
    }
    let bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0)
    const beforeBytes = bytes
    const selected: CacheEntry[] = []
    const select = (entry: CacheEntry): void => {
      selected.push(entry)
      for (const key of entry.inodes) {
        const remaining = (references.get(key) ?? 1) - 1
        references.set(key, remaining)
        if (remaining === 0) bytes -= sizes.get(key) ?? 0
      }
    }
    const eligible = candidates.filter((entry) => !entry.protected).sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of eligible) {
      if (nowMs - entry.mtimeMs >= maxAgeMs) select(entry)
    }
    for (const entry of eligible) {
      if (bytes <= maxBytes) break
      if (!selected.includes(entry)) select(entry)
    }
    const removed = selected.filter(removeEntry).map((entry) => entry.path)
    // A metadata-loss race invalidates the predicted reclamation. Recount it;
    // ordinary pruning keeps its single inode scan, including protected trees.
    let retained = sizes
    if (removed.length !== selected.length) {
      retained = new Map()
      for (const entry of candidates) {
        entry.inodes.clear()
        collectInodes(entry.path, entry.inodes, retained)
      }
      bytes = [...retained.values()].reduce((sum, size) => sum + size, 0)
    }
    const orphanedInodes = new Set<string>()
    for (const entry of candidates) if (entry.orphaned) {
      for (const key of entry.inodes) orphanedInodes.add(key)
    }
    return { beforeBytes, afterBytes: bytes, removed,
      orphaned: candidates.filter((entry) => entry.orphaned && entry.inodes.size).map((entry) => entry.path),
      orphanedBytes: [...orphanedInodes].reduce((sum, key) => sum + (retained.get(key) ?? 0), 0),
      overBudgetBytes: Math.max(0, bytes - maxBytes) }
  })
}
