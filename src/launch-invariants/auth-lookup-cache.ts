/**
 * The last valid result of each auth lookup (API key, key owner, browser
 * session), served only while the store cannot answer.
 *
 * Every lookup reads the store first, so a revoked or expired credential is
 * refused as soon as the store says so, and that answer drops its entry. When
 * the store errors or stalls past the deadline, a valid result verified less
 * than the TTL ago is served instead: on 2026-10-10 an overloaded D1 failed
 * API-key checks and session reads for requests whose credentials were valid
 * moments before (GTM #1488). The TTL counts from the last successful store
 * read and a served entry never renews it, so a credential revoked during an
 * outage lives at most the TTL past its last verification. Entries are per
 * isolate; revoking or rotating a key must also drop its entry here.
 *
 * The cache serves the verified value itself, never a copy: GTM keyed a
 * WeakMap on the verified key object, a copy missed it, and operator requests
 * answered 401 (GTM #1492).
 */

/** Longest a verified result may be served while the store cannot answer. A larger configured TTL is capped here. */
export const AUTH_LOOKUP_TTL_MS = 60_000
/** A store read slower than this is treated as unavailable; a healthy D1 lookup answers in tens of milliseconds. */
export const AUTH_LOOKUP_DEADLINE_MS = 2_500
const MAX_ENTRIES = 2_000

/** The store answered that the credential is not valid; never answered from the cache. */
export class AuthLookupRefused extends Error {}

interface Entry<V> {
  value: V
  until: number
}

export interface AuthLookupOptions<V> {
  /** When the credential itself expires (Unix ms); the entry never outlives it. */
  expiresAt?: (value: V) => number | null | undefined
}

export interface AuthLookupCache<V> {
  /**
   * Read through the store. `read` resolves the valid value or null, or throws
   * {@link AuthLookupRefused} (or a `Response`) when the store refuses; any
   * other failure, or no answer by the deadline, falls back to a fresh entry.
   * `key` must not be the secret: use {@link credentialCacheKey}.
   */
  lookup(key: string, read: () => Promise<V | null>, options?: AuthLookupOptions<V>): Promise<V | null>
  /** Drop every entry whose value matches, as when a key is revoked or rotated. */
  invalidate(matches: (value: V) => boolean): void
  /** Drop one entry by its key. */
  forget(key: string): void
  clear(): void
  /** The keys held, for a check that no secret is stored. */
  keys(): string[]
}

export interface AuthLookupCacheOptions {
  /** Names the lookup in the warning logged when a cached result is served. */
  label: string
  /** Capped at {@link AUTH_LOOKUP_TTL_MS}. */
  ttlMs?: number
  deadlineMs?: number
  now?: () => number
  warn?: (message: string, detail: Record<string, unknown>) => void
}

export function createAuthLookupCache<V>(options: AuthLookupCacheOptions): AuthLookupCache<V> {
  const ttlMs = Math.min(options.ttlMs ?? AUTH_LOOKUP_TTL_MS, AUTH_LOOKUP_TTL_MS)
  const deadlineMs = options.deadlineMs ?? AUTH_LOOKUP_DEADLINE_MS
  const now = options.now ?? (() => Date.now())
  const warn = options.warn ?? ((message, detail) => console.warn(message, detail))
  const entries = new Map<string, Entry<V>>()

  return {
    async lookup(key, read, lookupOptions) {
      let value: V | null
      try {
        value = await withDeadline(read(), deadlineMs)
      } catch (error) {
        if (error instanceof AuthLookupRefused || error instanceof Response) {
          entries.delete(key)
          throw error
        }
        const entry = entries.get(key)
        if (entry && now() < entry.until) {
          warn(`[auth-cache] ${options.label}: served the last valid result while the store was unavailable`, {
            error: error instanceof Error ? error.message : String(error),
            remainingMs: entry.until - now(),
          })
          return entry.value
        }
        entries.delete(key)
        throw error
      }
      if (value === null) {
        entries.delete(key)
        return null
      }
      const expiresAt = lookupOptions?.expiresAt?.(value)
      const until = Math.min(now() + ttlMs, typeof expiresAt === 'number' && expiresAt > 0 ? expiresAt : Number.POSITIVE_INFINITY)
      entries.delete(key)
      entries.set(key, { value, until })
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
      return value
    },
    invalidate(matches) {
      for (const [key, entry] of entries) if (matches(entry.value)) entries.delete(key)
    },
    forget(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    keys() {
      return [...entries.keys()]
    },
  }
}

/** A credential's cache key: its SHA-256 in hex, so the cache never holds the secret. */
export async function credentialCacheKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`auth lookup did not answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
