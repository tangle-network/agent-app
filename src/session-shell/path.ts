/**
 * Path normalisation shared by the shell's routing helpers. Segment-aligned
 * comparison is the invariant: `/vault` must never claim `/vault-archive`, so
 * every prefix test here works on whole segments rather than string prefixes.
 */

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Bare segment name, so a caller may pass `'/settings'` or `'settings'`. */
export function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/** Path with query + fragment removed and trailing slashes trimmed. A caller
 *  passing a full href instead of a pathname would otherwise match nothing. */
export function normalizePath(pathname: string): string {
  const withoutHash = pathname.split('#')[0] ?? ''
  const withoutQuery = withoutHash.split('?')[0] ?? ''
  return stripTrailingSlashes(withoutQuery)
}

/** True when `path` is `prefix` or a segment-aligned descendant of it, so
 *  `/vault` never claims `/vault-archive`. */
export function isUnderPrefix(path: string, prefix: string): boolean {
  const p = stripTrailingSlashes(prefix)
  if (p === '') return true
  return path === p || path.startsWith(`${p}/`)
}

/** Non-empty segments of a path or route pattern. Leading/trailing/duplicate
 *  slashes collapse, so `/app//x/` and `app/x` compare equal. */
export function toSegments(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0)
}

/** Canonical display form: rooted, no trailing slash, no empty segments. */
export function toRootedPath(value: string): string {
  return `/${toSegments(value).join('/')}`
}
