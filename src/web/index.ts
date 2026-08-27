/**
 * Web-boundary utilities every agent app's routes hand-roll: JSON body parsing
 * + narrowing, request-context extraction (real client IP behind Cloudflare),
 * a KV-backed sliding-window rate limiter, and security response headers. Pure
 * mechanism — no DB, no domain. The KV is a structural interface so this needs
 * no `@cloudflare/workers-types` dependency.
 */

export type JsonObject = Record<string, unknown>

/** Parse + object-narrow a Request body. `[body, null]` on success, `[null,
 *  errorResponse]` on a non-object body (callers `if (err) return err`). */
export async function parseJsonObjectBody(request: Request): Promise<[JsonObject, null] | [null, Response]> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return [null, Response.json({ error: 'Invalid JSON body' }, { status: 400 })]
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [null, Response.json({ error: 'Body must be a JSON object' }, { status: 400 })]
  }
  return [raw as JsonObject, null]
}

/** Narrow one required string field, 400 if missing/empty. */
export function requireString(body: JsonObject, field: string): string | Response {
  const v = body[field]
  if (typeof v !== 'string' || v.length === 0) {
    return Response.json({ error: `Missing or non-string field: ${field}` }, { status: 400 })
  }
  return v
}

/** Define the context of a request including IP address, user agent, timestamp, and request ID */
export interface RequestContext {
  ipAddress: string
  userAgent: string
  timestamp: string
  requestId: string
}

/** Extract request context for audit trails. Uses `CF-Connecting-IP` for the
 *  real client IP behind Cloudflare. */
export function extractRequestContext(request: Request): RequestContext {
  const ipAddress =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  return {
    ipAddress,
    userAgent: request.headers.get('User-Agent') ?? '',
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID(),
  }
}

/** Minimal KV contract (Cloudflare `KVNamespace` satisfies it structurally). */
export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** Describe the outcome of a rate limit check including allowance, remaining count, and reset time */
export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/** KV-backed sliding-window rate limit. Stores recent timestamps per key,
 *  prunes the window, allows until `limit` is hit.
 *
 *  Read-modify-write is best-effort, NOT atomic: KV has no compare-and-swap, so
 *  two requests racing on the same key can each read the same pre-state and both
 *  write — a concurrent burst can momentarily admit up to one extra request per
 *  racing writer. This is acceptable for coarse abuse limiting; it is NOT a hard
 *  quota gate.
 *
 *  Fail-CLOSED on unreadable state: corrupt/non-array KV (a poisoned or
 *  truncated value) is treated as a full window, so a tampered key cannot reset
 *  the count and bypass the limiter. A bare `JSON.parse` here would throw and
 *  abort the request handler, silently disabling the limit (fail-open). */
export async function checkRateLimit(kv: KvLike, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - windowSeconds
  const kvKey = `rl:${key}`
  const raw = await kv.get(kvKey)
  const parsed = parseRateLimitState(raw)
  if (parsed === POISONED_STATE) {
    // Unreadable state (parse threw or value is not a JSON array): deny rather
    // than reset the window to empty. A poisoned key must not become a bypass.
    return { allowed: false, remaining: 0, resetAt: now + windowSeconds }
  }
  const valid = parsed.filter((t) => t > windowStart)
  if (valid.length >= limit) return { allowed: false, remaining: 0, resetAt: (valid[0] ?? now) + windowSeconds }
  valid.push(now)
  await kv.put(kvKey, JSON.stringify(valid), { expirationTtl: windowSeconds * 2 })
  return { allowed: true, remaining: limit - valid.length, resetAt: now + windowSeconds }
}

/** Sentinel returned by `parseRateLimitState` when the stored value cannot be
 *  read as a timestamp array — distinct from an empty window so the limiter can
 *  fail closed instead of treating corruption as a fresh window. */
const POISONED_STATE = Symbol('rate-limit-poisoned-state')

/** Parse stored rate-limit state into a timestamp array. Absent state is a
 *  fresh (empty) window. A value that fails to parse, or parses to a non-array,
 *  returns `POISONED_STATE`; numeric junk inside a valid array is dropped. */
function parseRateLimitState(raw: string | null): number[] | typeof POISONED_STATE {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return POISONED_STATE
  }
  if (!Array.isArray(parsed)) return POISONED_STATE
  return parsed.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
}

/** Define options for configuring cookie attributes and behavior */
export interface CookieOptions {
  name: string
  /** Default '/'. */
  path?: string
  /** Default true. */
  httpOnly?: boolean
  /** Adds the `Secure` attribute. Default false. */
  secure?: boolean
  /** Default 'Lax'. */
  sameSite?: 'Lax' | 'Strict' | 'None'
  maxAgeSeconds?: number
}

/** Serialize a Set-Cookie header value: `name=encodeURIComponent(value)` plus
 *  attributes in Path / HttpOnly / SameSite / Max-Age / Secure order.
 *  Throws on `SameSite=None` without `secure` — browsers silently drop that
 *  combination, which would otherwise fail invisibly. */
export function serializeCookie(value: string, opts: CookieOptions): string {
  if (opts.sameSite === 'None' && !opts.secure) {
    throw new Error('SameSite=None cookies require secure: true (browsers reject them otherwise)')
  }
  const parts = [`${opts.name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]
  if (opts.httpOnly !== false) parts.push('HttpOnly')
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`)
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`)
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/** Set-Cookie header value that deletes the cookie (empty value, Max-Age=0). */
export function clearCookieHeader(opts: Omit<CookieOptions, 'maxAgeSeconds'>): string {
  return serializeCookie('', { ...opts, maxAgeSeconds: 0 })
}

/** Read + decode one cookie from a Cookie request header; null when absent. */
export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(/;\s*/)) {
    const [cookieName, ...rest] = part.split('=')
    if (cookieName === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return null
      }
    }
  }
  return null
}

/** Define options for configuring security-related HTTP headers including disclaimers and retention labels */
export interface SecurityHeaderOptions {
  /** Product disclaimer (e.g. "AI-powered tool. Not legal advice."). Omitted if absent. */
  disclaimer?: string
  /** Data-retention label (e.g. "7-years"). Omitted if absent. */
  retention?: string
  /** Extra headers to set. */
  extra?: Record<string, string>
}

/** Set standard security headers on a response (HSTS, nosniff, frame-options,
 *  referrer-policy, XSS) + optional product disclaimer/retention. The security
 *  set is generic; the disclaimer/retention are the product's. */
export function addSecurityHeaders(response: Response, opts: SecurityHeaderOptions = {}): Response {
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  response.headers.set('Referrer-Policy', 'same-origin')
  response.headers.set('X-XSS-Protection', '1; mode=block')
  if (opts.disclaimer) response.headers.set('X-AI-Disclaimer', opts.disclaimer)
  if (opts.retention) response.headers.set('X-Data-Retention', opts.retention)
  for (const [k, v] of Object.entries(opts.extra ?? {})) response.headers.set(k, v)
  return response
}

/** Local-sandbox / inline schemes a stored media reference must never use.
 *  Reachable from neither a browser nor the product worker, and a `file:`/`data:`
 *  url is the tell of an agent substituting local ffmpeg output for a real
 *  provider artifact. `blob:` and `javascript:` are inert/active client schemes
 *  with no server reachability. */
const REJECTED_MEDIA_SCHEMES = ['file:', 'data:', 'blob:', 'javascript:', 'vbscript:'] as const

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
export function assertMediaUrl(url: string, what = 'media url'): void {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return
  if (trimmed.startsWith('/api/')) return
  const shown = trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed
  const lower = trimmed.toLowerCase()
  if (
    REJECTED_MEDIA_SCHEMES.some((scheme) => lower.startsWith(scheme)) ||
    lower.startsWith('/tmp/') ||
    lower.startsWith('/home/')
  ) {
    throw new Error(`${what} must reference a provider http(s) URL or a rooted /api/ path, not a local sandbox file (${shown})`)
  }
  throw new Error(`${what} must be http(s) or a rooted /api/ path (${shown})`)
}
