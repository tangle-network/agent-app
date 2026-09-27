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
import type { FileMention } from './wire';
/** One entry from a structural `tree()` scan. Mirrors the sandbox SDK's
 *  `FileTreeFile` (`path`, `size`, `mtime`) — `mtime` is unused here so it's
 *  omitted from the structural match. */
export interface SandboxTreeFile {
    path: string;
    size: number;
}
/** Structural match of the sandbox SDK's `box.fs.tree` result shape
 *  (`FileTreeResult`). `stats.truncated` is the only stat this route reads;
 *  the rest ride through unread on the real SDK type. */
export interface SandboxTreeResult {
    root: string;
    files: SandboxTreeFile[];
    stats: {
        truncated: boolean;
    };
}
/** Structural match of the sandbox SDK's `box.fs` tree surface. */
export interface SandboxFileTreeSource {
    tree(path: string, options?: {
        maxDepth?: number;
    }): Promise<SandboxTreeResult>;
}
/** Describe a ready file index response with workspace-relative entries and truncation status */
export interface FileIndexReadyResponse {
    status: 'ready';
    /** Workspace-relative entries. Same shape as `FileMention` (`./wire`) so a
     *  client can hand a response entry straight to `fileMentionsToParts` /
     *  `buildMentionPromptBlock` without remapping. */
    files: FileMention[];
    /** True when either the underlying scan truncated (SDK-side cap) or this
     *  route's own `maxEntries` cap trimmed the filtered list. The client
     *  should show "showing first N files" rather than imply completeness. */
    truncated: boolean;
    generatedAt: string;
}
/** Cold-box answer: no provisioning happened, no files were scanned. The
 *  client shows a warming state and retries — this route never blocks on a
 *  box coming up. Two situations produce it: `authorize` reporting a box that
 *  is not running, and a running box whose workspace root does not exist yet
 *  (see `isMissingRootError`). */
export interface FileIndexWarmingResponse {
    status: 'warming';
}
/** Resolve a response indicating the file index is either ready or warming up */
export type FileIndexResponse = FileIndexReadyResponse | FileIndexWarmingResponse;
/** Short-TTL cache seam so repeat popover opens in the same session don't
 *  re-scan the workspace. Host-provided (e.g. a KV binding); `key` is
 *  whatever `authorize` returns as `cacheKey` — this route treats it opaquely. */
export interface FileIndexCache {
    get(key: string): Promise<FileIndexReadyResponse | null> | FileIndexReadyResponse | null;
    put(key: string, value: FileIndexReadyResponse, options?: {
        ttlSeconds?: number;
    }): Promise<void> | void;
}
/** Define authorization details and parameters for indexing a file workspace with optional caching and ignore rules */
export type FileIndexAuthorization = {
    status: 'ready';
    /** Structural sandbox `fs` handle, usually `ensureWorkspaceSandbox(...)` → `box.fs`. */
    fs: SandboxFileTreeSource;
    /** Workspace root to index (e.g. `/home/agent`). */
    root: string;
    /** Extra ignore segments for this request, merged with the route's
     *  defaults + `CreateSandboxFileIndexRouteOptions.ignore`. */
    ignore?: string[];
    /** Opaque cache key for the optional cache seam. Omit to skip caching
     *  for this request (e.g. a workspace the host chooses not to cache). */
    cacheKey?: string;
} | {
    status: 'warming';
} | {
    status: 'denied';
    response: Response;
};
/** Define options to authorize and configure sandbox file index route behavior */
export interface CreateSandboxFileIndexRouteOptions {
    /** Authenticate the caller, resolve the sandbox `fs` handle, and signal a
     *  cold box — never provisions or waits. */
    authorize(args: {
        request: Request;
    }): Promise<FileIndexAuthorization>;
    /** Extra ignore segments beyond the route's defaults (node_modules, .git,
     *  dotfiles/dot-dirs, common build dirs). Matched as exact path-segment
     *  names, same rule as the defaults. */
    ignore?: string[];
    /** Passed to `fs.tree` as `options.maxDepth`. Default 12. */
    maxDepth?: number;
    /** Hard cap on entries returned after filtering. Default 5000. */
    maxEntries?: number;
    /** Optional host-provided cache seam. */
    cache?: FileIndexCache;
    /** Cache TTL in seconds when `cache` is set. Default 20. */
    cacheTtlSeconds?: number;
}
/** Resolve a sandbox file index route with authorization, caching, and configurable depth and entries limits */
export declare function createSandboxFileIndexRoute(options: CreateSandboxFileIndexRouteOptions): (request: Request) => Promise<Response>;
