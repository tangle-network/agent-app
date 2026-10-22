/**
 * A value computed once and read by every later request of the same key until
 * it expires: this isolate's Map first, then the data center's Workers cache, so
 * a request served by another isolate (or warmed by a workspace prewarm on page
 * open or composer focus) reads the value instead of computing it again.
 *
 * Mechanism only: the product decides what is cached, for how long, and when a
 * refusal must `forget` it. Lifted from Creative (creative-agent#691), which
 * caches its connected-tool catalog and its billing verdicts with it.
 *
 * Keys name a subject (a user), never a credential: a key in a cache URL is
 * stored in the clear.
 */

const MAX_ENTRIES = 500

/** Which layer answered a read: this isolate's memory or the data center's Workers cache. */
export type WarmCacheSource = 'isolate' | 'colo'

export interface WarmCache<T> {
  read(key: string): Promise<{ value: T; source: WarmCacheSource } | null>
  /** Awaited: a prewarm's response ends right after it, which could cancel the write. */
  write(key: string, value: T, ttlMs: number): Promise<void>
  forget(key: string): Promise<void>
  /** Test seam: clears this isolate's layer only. */
  clearIsolate(): void
}

export interface WarmCacheOptions {
  /**
   * `false` keeps only the data center's layer, so `forget` reaches every
   * isolate there: use it for a value a refusal must end everywhere at once.
   * Default `true`.
   */
  isolate?: boolean
  /**
   * The deployment environment, part of every cache key because staging and
   * production share a zone's cache. A function is read on each call, so a
   * module-level cache can follow an environment bound after import.
   * Default `'production'`.
   */
  env?: string | (() => string | undefined)
}

function coloCache(): Cache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default
}

/**
 * `namespace` is the cache URL's host; it names no origin and is never routed.
 * Use one namespace per product and value kind, such as
 * `connected-tools.creative.internal`.
 */
export function createWarmCache<T>(namespace: string, options: WarmCacheOptions = {}): WarmCache<T> {
  const useIsolate = options.isolate ?? true
  const env = options.env
  const entries = new Map<string, { value: T; expiresAt: number }>()
  const coloKey = (key: string) => {
    const scope = (typeof env === 'function' ? env() : env) ?? 'production'
    return new Request(`https://${namespace}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`)
  }

  // Delete-before-set keeps Map order close to recency, so evicting the first
  // entry drops the least recently refreshed one: a soft memory bound.
  const remember = (key: string, value: T, expiresAt: number) => {
    entries.delete(key)
    if (!useIsolate) return
    const now = Date.now()
    for (const [k, entry] of entries) if (entry.expiresAt <= now) entries.delete(k)
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    entries.set(key, { value, expiresAt })
  }

  return {
    async read(key) {
      const local = entries.get(key)
      if (local && local.expiresAt > Date.now()) return { value: local.value, source: 'isolate' }
      const hit = await coloCache()?.match(coloKey(key)).catch(() => undefined)
      if (!hit) return null
      const expiresAt = Number(hit.headers.get('x-expires-at'))
      if (!(expiresAt > Date.now())) return null
      const value: unknown = await hit.json().catch(() => undefined)
      if (typeof value !== 'object' || value === null || !('v' in value)) return null
      const stored = (value as { v: T }).v
      remember(key, stored, expiresAt)
      return { value: stored, source: 'colo' }
    },
    async write(key, value, ttlMs) {
      const expiresAt = Date.now() + ttlMs
      remember(key, value, expiresAt)
      await coloCache()?.put(coloKey(key), new Response(JSON.stringify({ v: value }), { headers: {
        'cache-control': `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}`, 'x-expires-at': String(expiresAt),
      } })).catch(() => {})
    },
    async forget(key) {
      entries.delete(key)
      await coloCache()?.delete(coloKey(key)).catch(() => false)
    },
    clearIsolate() {
      entries.clear()
    },
  }
}
