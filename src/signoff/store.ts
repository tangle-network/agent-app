import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The pristine package store, cached on the lockfile so speed is not paid for
 * with a stale module graph.
 *
 * The whole mechanical difference between "green locally" and "red in CI" is
 * that CI installs `--frozen-lockfile` into an isolated store with no
 * `node_modules` and no framework cache, and a local run reuses both. Only one
 * of those two is safe to keep:
 *
 * - `node_modules` and any build/framework cache are **never** reused. They are
 *   what masked the failure this gate exists to catch, and they are recreated
 *   for every run inside a fresh `git worktree`.
 * - The **store** is reused, keyed on the bytes that decide what gets installed.
 *   A pnpm store is content-addressed: every entry is named by the hash of what
 *   is in it, so a reused entry cannot be a different version of a package than
 *   the lockfile asked for. Reusing it skips downloads, not resolution.
 *
 * The key covers every manifest in the tree — lockfile, workspace file, every
 * `package.json`, `.npmrc`. Change any of them and the key changes, so the next
 * run installs into an empty store and pays the honest cold cost. Generations
 * are kept (default 4) rather than one, so moving between a branch and `main`
 * finds both warm instead of thrashing.
 */

/** Basenames whose bytes decide what an install resolves to. */
const MANIFEST_FILES: readonly string[] = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  '.npmrc',
  '.nvmrc',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
]

/** Never descended into when hunting manifests. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.wrangler', '.react-router'])

export interface StoreResolution {
  readonly storeDir: string
  readonly cacheKey: string
  /** True when a store for this key already had content. */
  readonly hit: boolean
  /** Repo-relative manifest paths, sorted — the inputs to `cacheKey`. */
  readonly keyedOn: readonly string[]
  /** Store directories removed by the generation cap. */
  readonly pruned: readonly string[]
}

export interface ResolveStoreOptions {
  /** The clean tree whose manifests are hashed. */
  readonly treePath: string
  readonly cacheDir: string
  /** Generations to keep. Default 4. */
  readonly generations?: number
}

function collectManifests(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectManifests(join(dir, entry.name), root, out)
    } else if (MANIFEST_FILES.includes(entry.name)) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
    }
  }
}

/** Every manifest in the tree, repo-relative and sorted. */
export function manifestFiles(treePath: string): string[] {
  const found: string[] = []
  collectManifests(treePath, treePath, found)
  return found.sort()
}

/** sha256 over each manifest's path and content — order-independent by sorting. */
export function manifestCacheKey(treePath: string, files: readonly string[]): string {
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(createHash('sha256').update(readFileSync(join(treePath, rel))).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Prune all but the `keep` most recently used store generations.
 *
 * Recency is the directory's mtime, stamped on every use, so the store a run
 * just used is never the one evicted.
 */
function pruneStores(storesRoot: string, keep: number): string[] {
  if (!existsSync(storesRoot)) return []
  const entries = readdirSync(storesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = join(storesRoot, entry.name)
      return { full, mtimeMs: statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const pruned: string[] = []
  for (const stale of entries.slice(keep)) {
    rmSync(stale.full, { recursive: true, force: true })
    pruned.push(stale.full)
  }
  return pruned
}

export function resolveStore(options: ResolveStoreOptions): StoreResolution {
  const { treePath, cacheDir, generations = 4 } = options
  const files = manifestFiles(treePath)
  if (files.length === 0) {
    throw new Error(
      `signoff: no package manifest under ${treePath}. A sign-off run installs from a lockfile; ` +
        'there is nothing here to install.',
    )
  }

  const cacheKey = manifestCacheKey(treePath, files)
  const storesRoot = join(cacheDir, 'stores')
  const storeDir = join(storesRoot, cacheKey)
  // A store directory that exists but holds only the marker is a previous run
  // that died before installing; treat it as a miss so the report does not
  // claim a warm store it does not have.
  const marker = join(storeDir, '.signoff-store.json')
  const hit = existsSync(storeDir) && readdirSync(storeDir).some((entry) => entry !== '.signoff-store.json')

  mkdirSync(storeDir, { recursive: true })
  writeFileSync(marker, `${JSON.stringify({ cacheKey, keyedOn: files, usedAt: new Date().toISOString() }, null, 2)}\n`)
  const now = new Date()
  utimesSync(storeDir, now, now)

  return { storeDir, cacheKey, hit, keyedOn: files, pruned: pruneStores(storesRoot, generations) }
}
