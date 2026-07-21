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
 *  box coming up. */
export interface FileIndexWarmingResponse {
  status: 'warming'
}

export type FileIndexResponse = FileIndexReadyResponse | FileIndexWarmingResponse

/** Short-TTL cache seam so repeat popover opens in the same session don't
 *  re-scan the workspace. Host-provided (e.g. a KV binding); `key` is
 *  whatever `authorize` returns as `cacheKey` — this route treats it opaquely. */
export interface FileIndexCache {
  get(key: string): Promise<FileIndexReadyResponse | null> | FileIndexReadyResponse | null
  put(key: string, value: FileIndexReadyResponse, options?: { ttlSeconds?: number }): Promise<void> | void
}

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

    const scan = await auth.fs.tree(auth.root, { maxDepth })
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
