/**
 * What isolates share about a running box: its id and the checks a reuse may
 * trust (see `ReuseChecks` in `./index`).
 *
 * A Worker request is not promised the isolate that served the last one. Legal's
 * sandbox lane, 8 consecutive turns on 2026-10-20, found no check from the turn
 * before in any of them, so a trust held only in isolate memory never opened. The
 * state is small and best effort, so it rides the Workers Cache API (one read at
 * the start of a reuse, a write only when a check changed); a miss costs the full
 * verification, as before.
 *
 * Nothing secret is stored: ids, times, and digests of the policy and the
 * runtime environment.
 */

export interface ReuseChecks {
  /** What tells one run of the box from the next (see `boxIdentity`). */
  identity: string
  /** When the exec probe last passed. */
  alive?: number
  /** The egress policy (normalized) the box was last read at or migrated to. */
  egress?: { key: string; at: number }
  /** The digest of the runtime environment last delivered to the box. */
  env?: { digest: string; at: number }
  /** The deferred corpus the box was last found to hold, by its hash. */
  corpus?: { hash: string; at: number }
}

export interface SharedReuseState {
  boxId: string
  checks: ReuseChecks
}

/** Where isolates keep {@link SharedReuseState}, by box name. Failures are the caller's to swallow. */
export interface ReuseStateStore {
  load(name: string): Promise<SharedReuseState | null>
  save(name: string, state: SharedReuseState): Promise<void>
  drop(name: string): Promise<void>
}

/** The slice of a Workers `Cache` this store uses. */
export interface ReuseCacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
  delete(request: Request): Promise<boolean>
}

const CACHE_NAME = 'agent-app-sandbox-reuse'
const KEY_ORIGIN = 'https://sandbox-reuse.agent-app.invalid/'
/** Longer than any check's trust, so the entry never outlives what it records by much. */
const ENTRY_MAX_AGE_SECONDS = 15 * 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stamped(value: unknown, field: string): { text: string; at: number } | undefined {
  if (!isRecord(value) || typeof value.at !== 'number' || typeof value[field] !== 'string') return undefined
  return { text: value[field], at: value.at }
}

/** A stored value that is not exactly the shape this module writes is a miss. */
function parseState(value: unknown): SharedReuseState | null {
  if (!isRecord(value) || typeof value.boxId !== 'string' || !isRecord(value.checks)) return null
  const checks = value.checks
  if (typeof checks.identity !== 'string') return null
  const parsed: ReuseChecks = { identity: checks.identity }
  if (typeof checks.alive === 'number') parsed.alive = checks.alive
  const egress = stamped(checks.egress, 'key')
  if (egress) parsed.egress = { key: egress.text, at: egress.at }
  const env = stamped(checks.env, 'digest')
  if (env) parsed.env = { digest: env.text, at: env.at }
  const corpus = stamped(checks.corpus, 'hash')
  if (corpus) parsed.corpus = { hash: corpus.text, at: corpus.at }
  return { boxId: value.boxId, checks: parsed }
}

/** A store over a Workers-style cache. The cache is opened on first use. */
export function createCacheReuseStore(open: () => Promise<ReuseCacheLike>): ReuseStateStore {
  // Only the resolved handle is kept across requests, never a promise still in flight.
  let cache: ReuseCacheLike | undefined
  const handle = async (): Promise<ReuseCacheLike> => (cache ??= await open())
  const request = (name: string) => new Request(`${KEY_ORIGIN}${encodeURIComponent(name)}`)
  return {
    async load(name) {
      const hit = await (await handle()).match(request(name))
      if (!hit) return null
      return parseState(await hit.json())
    },
    async save(name, state) {
      await (await handle()).put(request(name), new Response(JSON.stringify(state), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ENTRY_MAX_AGE_SECONDS}` },
      }))
    },
    async drop(name) {
      await (await handle()).delete(request(name))
    },
  }
}

/** The runtime's own cache when it has one (a Worker does), else null. */
export function workersReuseStore(): ReuseStateStore | null {
  const storage = (globalThis as { caches?: { open?: (name: string) => Promise<ReuseCacheLike> } }).caches
  if (typeof storage?.open !== 'function') return null
  return createCacheReuseStore(() => storage.open!(CACHE_NAME))
}
