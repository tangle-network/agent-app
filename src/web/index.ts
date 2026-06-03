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

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/** KV-backed sliding-window rate limit. Stores recent timestamps per key,
 *  prunes the window, allows until `limit` is hit. */
export async function checkRateLimit(kv: KvLike, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - windowSeconds
  const kvKey = `rl:${key}`
  const raw = await kv.get(kvKey)
  const timestamps: number[] = raw ? JSON.parse(raw) : []
  const valid = timestamps.filter((t) => t > windowStart)
  if (valid.length >= limit) return { allowed: false, remaining: 0, resetAt: (valid[0] ?? now) + windowSeconds }
  valid.push(now)
  await kv.put(kvKey, JSON.stringify(valid), { expirationTtl: windowSeconds * 2 })
  return { allowed: true, remaining: limit - valid.length, resetAt: now + windowSeconds }
}

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
