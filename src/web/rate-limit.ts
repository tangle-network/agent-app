/**
 * The KV-backed sliding-window rate limiter. Lives in its own leaf so policy
 * layers (`./free-route-limit`) can build on it without importing the web
 * barrel and creating an import cycle. Re-exported from `./index`, which is the
 * published surface.
 */

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

/** Request-lifetime persistence for a coarse limiter. Callers must retain the
 * promise until it settles and observe write failures; hard quotas must await. */
export interface RateLimitOptions {
  waitUntil?: (persist: Promise<void>) => void
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
export async function checkRateLimit(kv: KvLike, key: string, limit: number, windowSeconds: number, options: RateLimitOptions = {}): Promise<RateLimitResult> {
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
  const persist = kv.put(kvKey, JSON.stringify(valid), { expirationTtl: windowSeconds * 2 })
  if (options.waitUntil) options.waitUntil(persist)
  else await persist
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

/** Timing of one limiter decision, for a product that logs it. */
export interface RateLimitTiming {
  readMs: number
  /** Present once the counter write settled. */
  writeMs?: number
  /** Present on the decision event. */
  decisionMs?: number
  allowed?: boolean
  deferred: boolean
}

export interface RateLimiterBindingOptions {
  /** Called when the counter write settles and when the decision is made. */
  onTiming?: (event: 'counter' | 'decision', timing: RateLimitTiming) => void
  /** Called when a deferred counter write fails; the decision already stood. */
  onPersistError?: (error: unknown) => void
}

/**
 * A product's limiter bound once to its KV namespace at worker start:
 * `setKV(env.RATE_LIMIT_KV)`, then `check(key, limit, windowSeconds)` anywhere.
 * Pass `waitUntil` to defer the counter write past the response.
 */
export function createRateLimiterBinding(options: RateLimiterBindingOptions = {}) {
  let bound: KvLike | null = null

  function setKV(kv: KvLike): void { bound = kv }

  async function check(
    key: string,
    limit: number,
    windowSeconds: number,
    waitUntil?: (persist: Promise<void>) => void,
  ): Promise<RateLimitResult> {
    if (!bound) throw new Error('RATE_LIMIT_KV not initialized')
    const { onTiming, onPersistError } = options
    const kv = bound
    const deferred = Boolean(waitUntil)
    const startedAt = Date.now()
    let readMs = 0
    const measured: KvLike = onTiming
      ? {
          async get(counterKey) {
            const began = Date.now()
            try { return await kv.get(counterKey) } finally { readMs = Date.now() - began }
          },
          async put(counterKey, value, putOptions) {
            const began = Date.now()
            try { await kv.put(counterKey, value, putOptions) } finally {
              onTiming('counter', { readMs, writeMs: Date.now() - began, deferred })
            }
          },
        }
      : kv
    const result = await checkRateLimit(measured, key, limit, windowSeconds, waitUntil
      ? { waitUntil: (persist) => waitUntil(persist.catch((error: unknown) => onPersistError?.(error))) }
      : {})
    onTiming?.('decision', { readMs, decisionMs: Date.now() - startedAt, allowed: result.allowed, deferred })
    return result
  }

  return { setKV, check }
}
