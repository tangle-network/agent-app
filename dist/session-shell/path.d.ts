/**
 * Path normalisation shared by the shell's routing helpers. Segment-aligned
 * comparison is the invariant: `/vault` must never claim `/vault-archive`, so
 * every prefix test here works on whole segments rather than string prefixes.
 */
export declare function stripTrailingSlashes(value: string): string;
/** Bare segment name, so a caller may pass `'/settings'` or `'settings'`. */
export declare function stripSlashes(value: string): string;
/** Path with query + fragment removed and trailing slashes trimmed. A caller
 *  passing a full href instead of a pathname would otherwise match nothing. */
export declare function normalizePath(pathname: string): string;
/** True when `path` is `prefix` or a segment-aligned descendant of it, so
 *  `/vault` never claims `/vault-archive`. */
export declare function isUnderPrefix(path: string, prefix: string): boolean;
/** Non-empty segments of a path or route pattern. Leading/trailing/duplicate
 *  slashes collapse, so `/app//x/` and `app/x` compare equal. */
export declare function toSegments(value: string): string[];
/** Canonical display form: rooted, no trailing slash, no empty segments. */
export declare function toRootedPath(value: string): string;
