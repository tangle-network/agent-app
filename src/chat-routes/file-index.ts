/**
 * `createSandboxFileIndexRoute` — server side of `@`-file-mentions
 * (companion to sandbox-ui#184's composer mention primitive). Serves a flat,
 * ignore-filtered listing of the workspace sandbox so `useFileMentions`
 * (`/web-react`) can filter it client-side without a round trip per
 * keystroke.
 *
 * Same seam style as `createUploadRoute`: `authorize({ request })` resolves a
 * structural `{ tree(path, opts) }` handle (the shape of the sandbox SDK's
 * `box.fs.tree`) — no SDK import here. `authorize` also carries the
 * cold-box signal: a sandbox that isn't running yet answers `{ status:
 * 'warming' }` directly, never provisions-and-waits inside this route.
 *
 * A box can also be running with its workspace root not yet materialised, which
 * `authorize` cannot see; the route recognises that one signal off `fs.tree`
 * and answers `warming` too, so every consumer gets the retry-and-wait state
 * instead of a 500. Every other `tree()` failure propagates.
 */

import type { FileMention } from './wire'

/** One entry from a structural `tree()` scan. Mirrors the sandbox SDK's
 *  `FileTreeFile` (`path`, `size`, `mtime`) — `mtime` is unused here so it's
 *  omitted from the structural match. */
export interface SandboxTreeFile {
  path: string
  size: number
}

/** Structural match of the sandbox SDK's `box.fs.tree` result shape
 *  (`FileTreeResult`). `stats.truncated` is the only stat this route reads;
 *  the rest ride through unread on the real SDK type. */
export interface SandboxTreeResult {
  root: string
  files: SandboxTreeFile[]
  stats: { truncated: boolean }
}

/** Structural match of the sandbox SDK's `box.fs` tree surface. */
export interface SandboxFileTreeSource {
  tree(path: string, options?: { maxDepth?: number }): Promise<SandboxTreeResult>
}

/** Describe a ready file index response with workspace-relative entries and truncation status */
export interface FileIndexReadyResponse {
  status: 'ready'
  /** Workspace-relative entries. Same shape as `FileMention` (`./wire`) so a
   *  client can hand a response entry straight to `fileMentionsToParts` /
   *  `buildMentionPromptBlock` without remapping. */
  files: FileMention[]
  /** True when either the underlying scan truncated (SDK-side cap) or this
   *  route's own `maxEntries` cap trimmed the filtered list. The client
   *  should show "showing first N files" rather than imply completeness. */
  truncated: boolean
  generatedAt: string
}

/** Cold-box answer: no provisioning happened, no files were scanned. The
 *  client shows a warming state and retries — this route never blocks on a
 *  box coming up. Two situations produce it: `authorize` reporting a box that
 *  is not running, and a running box whose workspace root does not exist yet
 *  (see `isMissingRootError`). */
export interface FileIndexWarmingResponse {
  status: 'warming'
}

/** Resolve a response indicating the file index is either ready or warming up */
export type FileIndexResponse = FileIndexReadyResponse | FileIndexWarmingResponse

/** Short-TTL cache seam so repeat popover opens in the same session don't
 *  re-scan the workspace. Host-provided (e.g. a KV binding); `key` is
 *  whatever `authorize` returns as `cacheKey` — this route treats it opaquely. */
export interface FileIndexCache {
  get(key: string): Promise<FileIndexReadyResponse | null> | FileIndexReadyResponse | null
  put(key: string, value: FileIndexReadyResponse, options?: { ttlSeconds?: number }): Promise<void> | void
}

/** Define authorization details and parameters for indexing a file workspace with optional caching and ignore rules */
export type FileIndexAuthorization =
  | {
      status: 'ready'
      /** Structural sandbox `fs` handle, usually `ensureWorkspaceSandbox(...)` → `box.fs`. */
      fs: SandboxFileTreeSource
      /** Workspace root to index (e.g. `/home/agent`). */
      root: string
      /** Extra ignore segments for this request, merged with the route's
       *  defaults + `CreateSandboxFileIndexRouteOptions.ignore`. */
      ignore?: string[]
      /** Opaque cache key for the optional cache seam. Omit to skip caching
       *  for this request (e.g. a workspace the host chooses not to cache). */
      cacheKey?: string
    }
  | { status: 'warming' }
  | { status: 'denied'; response: Response }

/** Define options to authorize and configure sandbox file index route behavior */
export interface CreateSandboxFileIndexRouteOptions {
  /** Authenticate the caller, resolve the sandbox `fs` handle, and signal a
   *  cold box — never provisions or waits. */
  authorize(args: { request: Request }): Promise<FileIndexAuthorization>
  /** Extra ignore segments beyond the route's defaults (node_modules, .git,
   *  dotfiles/dot-dirs, common build dirs). Matched as exact path-segment
   *  names, same rule as the defaults. */
  ignore?: string[]
  /** Passed to `fs.tree` as `options.maxDepth`. Default 12. */
  maxDepth?: number
  /** Hard cap on entries returned after filtering. Default 5000. */
  maxEntries?: number
  /** Optional host-provided cache seam. */
  cache?: FileIndexCache
  /** Cache TTL in seconds when `cache` is set. Default 20. */
  cacheTtlSeconds?: number
}

/** Segment names ignored anywhere in a path, beyond the generic dotfile rule
 *  below. Intentionally small and language/framework-agnostic — callers
 *  extend it via `ignore` for anything domain-specific (e.g. a vault's
 *  `uploads` dir). */
const DEFAULT_IGNORE_SEGMENTS = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '__pycache__',
  'venv',
]

/** A path segment starting with `.` (`.git`, `.env`, `.next`, `.cache`, …) is
 *  always ignored — this single rule covers most dot-prefixed VCS/tooling
 *  dirs and dotfiles without enumerating them. */
function isIgnored(relPath: string, ignoreSegments: ReadonlySet<string>): boolean {
  for (const segment of relPath.split('/')) {
    if (!segment) continue
    if (segment.startsWith('.')) return true
    if (ignoreSegments.has(segment)) return true
  }
  return false
}

/** Strips the tree result's echoed `root` prefix so entries are always
 *  workspace-relative, whichever convention the structural `fs.tree` uses
 *  (root-relative already, or root-prefixed). */
function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  if (path === root) return ''
  return path
}

function basename(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

/**
 * A box can answer `running` before it has materialised the workspace root —
 * `authorize` has already committed to `ready` by then, so `fs.tree` is the
 * first thing to notice, and it rejects with the sandbox SDK's
 * `ValidationError` wrapping a box-side `ENOENT … lstat` on the root. That is
 * the SAME "not usable yet" state `authorize` collapses onto `warming` for an
 * absent or stopped box, just discovered one step later, so it gets the same
 * answer instead of escaping as a 500.
 *
 * Matched STRUCTURALLY, not with `instanceof`: importing the SDK's error class
 * would make `@tangle-network/sandbox` a hard dependency of a route factory
 * whose entire `fs` seam is structural (`SandboxFileTreeSource`), and would
 * break any host feeding it a non-SDK handle.
 *
 * Deliberately narrow — the error code, `ENOENT`, the ENOENT message text, AND
 * the failing syscall's own operand all have to line up. A permission error, a
 * timeout, an auth failure, or an ENOENT on some other path inside the tree is
 * a real failure and still surfaces.
 *
 * The operand is matched as the quoted `lstat '<root>'` clause rather than by
 * substring, because the root is a PREFIX of everything under it: a plain
 * `includes(root)` would also swallow an ENOENT on `<root>/gone/x.md`, and on
 * a prefix sibling like `/home/agent-old/...`.
 */
function isMissingRootError(err: unknown, root: string): boolean {
  if (!(err instanceof Error)) return false
  if ((err as { code?: unknown }).code !== 'VALIDATION_ERROR') return false
  return (
    /ENOENT/.test(err.message) &&
    /no such file or directory/.test(err.message) &&
    new RegExp(`\\blstat '${escapeRegExp(root)}'`).test(err.message)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a sandbox file index route with authorization, caching, and configurable depth and entries limits */
export function createSandboxFileIndexRoute(
  options: CreateSandboxFileIndexRouteOptions,
): (request: Request) => Promise<Response> {
  const maxDepth = options.maxDepth ?? 12
  const maxEntries = options.maxEntries ?? 5000
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 20
  const staticIgnore = new Set([...DEFAULT_IGNORE_SEGMENTS, ...(options.ignore ?? [])])

  return async function fileIndex(request: Request): Promise<Response> {
    const auth = await options.authorize({ request })
    if (auth.status === 'denied') return auth.response
    if (auth.status === 'warming') {
      return Response.json({ status: 'warming' } satisfies FileIndexWarmingResponse)
    }

    const cache = options.cache
    if (cache && auth.cacheKey) {
      const cached = await cache.get(auth.cacheKey)
      if (cached) return Response.json(cached)
    }

    const ignoreSegments = auth.ignore?.length
      ? new Set([...staticIgnore, ...auth.ignore])
      : staticIgnore

    let scan: SandboxTreeResult
    try {
      scan = await auth.fs.tree(auth.root, { maxDepth })
    } catch (err) {
      if (!isMissingRootError(err, auth.root)) throw err
      return Response.json({ status: 'warming' } satisfies FileIndexWarmingResponse)
    }
    const filtered = scan.files.filter((f) => !isIgnored(relativeTo(scan.root, f.path), ignoreSegments))
    const truncated = scan.stats.truncated || filtered.length > maxEntries
    const files: FileMention[] = filtered.slice(0, maxEntries).map((f) => {
      const path = relativeTo(scan.root, f.path)
      const entry: FileMention = { path, name: basename(path) }
      if (typeof f.size === 'number') entry.size = f.size
      return entry
    })

    const body: FileIndexReadyResponse = {
      status: 'ready',
      files,
      truncated,
      generatedAt: new Date().toISOString(),
    }

    if (cache && auth.cacheKey) await cache.put(auth.cacheKey, body, { ttlSeconds: cacheTtlSeconds })

    return Response.json(body)
  }
}
