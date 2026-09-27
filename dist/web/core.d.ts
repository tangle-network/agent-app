/**
 * Web-boundary utilities every agent app's routes hand-roll: JSON body parsing
 * + narrowing, request-context extraction (real client IP behind Cloudflare),
 * a KV-backed sliding-window rate limiter, the free-route budget policy built
 * on it, and security response headers. Pure mechanism — no DB, no domain. The
 * KV is a structural interface so this needs no `@cloudflare/workers-types`
 * dependency.
 */
export * from './rate-limit';
export * from './free-route-limit';
export type JsonObject = Record<string, unknown>;
/** Parse + object-narrow a Request body. `[body, null]` on success, `[null,
 *  errorResponse]` on a non-object body (callers `if (err) return err`). */
export declare function parseJsonObjectBody(request: Request): Promise<[JsonObject, null] | [null, Response]>;
/** Narrow one required string field, 400 if missing/empty. */
export declare function requireString(body: JsonObject, field: string): string | Response;
/** Define the context of a request including IP address, user agent, timestamp, and request ID */
export interface RequestContext {
    ipAddress: string;
    userAgent: string;
    timestamp: string;
    requestId: string;
}
/** Extract request context for audit trails. Uses `CF-Connecting-IP` for the
 *  real client IP behind Cloudflare. */
export declare function extractRequestContext(request: Request): RequestContext;
/** Define options for configuring cookie attributes and behavior */
export interface CookieOptions {
    name: string;
    /** Default '/'. */
    path?: string;
    /** Default true. */
    httpOnly?: boolean;
    /** Adds the `Secure` attribute. Default false. */
    secure?: boolean;
    /** Default 'Lax'. */
    sameSite?: 'Lax' | 'Strict' | 'None';
    maxAgeSeconds?: number;
}
/** Serialize a Set-Cookie header value: `name=encodeURIComponent(value)` plus
 *  attributes in Path / HttpOnly / SameSite / Max-Age / Secure order.
 *  Throws on `SameSite=None` without `secure` — browsers silently drop that
 *  combination, which would otherwise fail invisibly. */
export declare function serializeCookie(value: string, opts: CookieOptions): string;
/** Set-Cookie header value that deletes the cookie (empty value, Max-Age=0). */
export declare function clearCookieHeader(opts: Omit<CookieOptions, 'maxAgeSeconds'>): string;
/** Read + decode one cookie from a Cookie request header; null when absent. */
export declare function readCookieValue(cookieHeader: string | null, name: string): string | null;
/** Define options for configuring security-related HTTP headers including disclaimers and retention labels */
export interface SecurityHeaderOptions {
    /** Product disclaimer (e.g. "AI-powered tool. Not legal advice."). Omitted if absent. */
    disclaimer?: string;
    /** Data-retention label (e.g. "7-years"). Omitted if absent. */
    retention?: string;
    /** Extra headers to set. */
    extra?: Record<string, string>;
}
/** Canonical generic response headers used by {@link addSecurityHeaders}.
 * Exported so static-asset hosts can apply the same policy without copying
 * values that silently drift from Worker/API responses. */
export declare const STANDARD_SECURITY_HEADERS: Readonly<{
    readonly 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload';
    readonly 'X-Content-Type-Options': 'nosniff';
    readonly 'X-Frame-Options': 'SAMEORIGIN';
    readonly 'Referrer-Policy': 'same-origin';
    readonly 'X-XSS-Protection': '1; mode=block';
}>;
/** Set standard security headers on a response (HSTS, nosniff, frame-options,
 *  referrer-policy, XSS) + optional product disclaimer/retention. The security
 *  set is generic; the disclaimer/retention are the product's. */
export declare function addSecurityHeaders(response: Response, opts?: SecurityHeaderOptions): Response;
/**
 * Canonical media-reference boundary shared by every surface that persists a
 * media url (sequences clips, design-canvas image/video src). The ONE rule:
 * remote `http(s)` or a rooted `/api/` path are allowed; everything else is
 * rejected, with a named reason for known-bad local/inline schemes so the
 * thrown message is actionable for an LLM planner. The url is trimmed before
 * the scheme check so leading whitespace cannot smuggle a rejected scheme past
 * a naive `startsWith`.
 *
 * @param what - noun for the error message (e.g. 'media url', 'src').
 */
export declare function assertMediaUrl(url: string, what?: string): void;
export { isWorkspaceFileExportable } from './file-export';
