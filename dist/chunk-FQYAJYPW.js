import {
  isWorkspaceFileExportable
} from "./chunk-TXD5HXLE.js";

// src/chat-routes/file-index.ts
var DEFAULT_IGNORE_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "__pycache__",
  "venv"
];
function isIgnored(relPath, ignoreSegments) {
  if (!isWorkspaceFileExportable(relPath)) return true;
  for (const segment of relPath.split("/")) {
    if (!segment) continue;
    if (segment.startsWith(".")) return true;
    if (ignoreSegments.has(segment)) return true;
  }
  return false;
}
function relativeTo(root, path) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  if (path === root) return "";
  return path;
}
function basename(path) {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
function isMissingRootError(err, root) {
  if (!(err instanceof Error)) return false;
  if (err.code !== "VALIDATION_ERROR") return false;
  return /ENOENT/.test(err.message) && /no such file or directory/.test(err.message) && new RegExp(`\\blstat '${escapeRegExp(root)}'`).test(err.message);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function createSandboxFileIndexRoute(options) {
  const maxDepth = options.maxDepth ?? 12;
  const maxEntries = options.maxEntries ?? 5e3;
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 20;
  const staticIgnore = /* @__PURE__ */ new Set([...DEFAULT_IGNORE_SEGMENTS, ...options.ignore ?? []]);
  return async function fileIndex(request) {
    const auth = await options.authorize({ request });
    if (auth.status === "denied") return auth.response;
    if (auth.status === "warming") {
      return Response.json({ status: "warming" });
    }
    const ignoreSegments = auth.ignore?.length ? /* @__PURE__ */ new Set([...staticIgnore, ...auth.ignore]) : staticIgnore;
    const cache = options.cache;
    if (cache && auth.cacheKey) {
      const cached = await cache.get(auth.cacheKey);
      if (cached) return Response.json({
        ...cached,
        files: cached.files.filter((file) => !isIgnored(file.path, ignoreSegments))
      });
    }
    let scan;
    try {
      scan = await auth.fs.tree(auth.root, { maxDepth });
    } catch (err) {
      if (!isMissingRootError(err, auth.root)) throw err;
      return Response.json({ status: "warming" });
    }
    const filtered = scan.files.filter((f) => !isIgnored(relativeTo(auth.root, f.path), ignoreSegments));
    const truncated = scan.stats.truncated || filtered.length > maxEntries;
    const files = filtered.slice(0, maxEntries).map((f) => {
      const path = relativeTo(auth.root, f.path);
      const entry = { path, name: basename(path) };
      if (typeof f.size === "number") entry.size = f.size;
      return entry;
    });
    const body = {
      status: "ready",
      files,
      truncated,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (cache && auth.cacheKey) await cache.put(auth.cacheKey, body, { ttlSeconds: cacheTtlSeconds });
    return Response.json(body);
  };
}

export {
  createSandboxFileIndexRoute
};
//# sourceMappingURL=chunk-FQYAJYPW.js.map