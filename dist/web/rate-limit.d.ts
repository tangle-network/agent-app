/**
 * The KV-backed sliding-window rate limiter. Lives in its own leaf so policy
 * layers (`./free-route-limit`) can build on it without importing the web
 * barrel and creating an import cycle. Re-exported from `./index`, which is the
 * published surface.
 */
/** Minimal KV contract (Cloudflare `KVNamespace` satisfies it structurally). */
export interface KvLike {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: {
        expirationTtl?: number;
    }): Promise<void>;
}
/** Describe the outcome of a rate limit check including allowance, remaining count, and reset time */
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
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
export declare function checkRateLimit(kv: KvLike, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
