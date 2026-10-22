import type { KeyCrypto } from '../billing'
import { sha256Hex } from '../crypto/digest'
import type { DelegatedKeyOutcome, DelegatedKeyRequest, PlatformDelegatedKeyClient } from './delegated-keys'

/**
 * Pre-minted turn keys. Creative minted each Router turn's child on the turn's critical path, ~320 ms of a
 * 6,419 ms first-visible p50 (router-spec, 2026-10-22). `createDelegatedTurnKeys` keeps one child per turn with
 * the same cap and expiry, and mints the next turn's child in the background (`waitUntil`) into a D1 slot. The
 * next turn takes it with one `DELETE ... RETURNING`, so a parked key serves exactly one turn and a racing second
 * turn mints inline. A parked key is used only when it was minted for the same request (source key, product,
 * models, budget, resource, payer: the slot's `scope` digest) and has `minRemainingMs` of life; otherwise the turn
 * mints inline exactly as before. A parked child Platform revoked or let expire is refused by the Router (401
 * `invalid_key` with that reason); `delegatedKeyFallbackFetch` then mints inline once and resends. A spent budget
 * never re-mints: the turn keeps one cap. Each slot holds at most one unused key; a displaced key, or one minted
 * but not stored, is revoked, and one whose revoke fails expires on its own. The secret is stored encrypted.
 */

/** Paste into a migration. `expires_at` is epoch ms; `scope` is the digest of the request the key was minted for. */
export const DELEGATED_KEY_PREMINT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS delegated_key_premint (
  slot TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_encrypted TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`

/** The D1 surface the slot store uses. A real `D1Database` satisfies it. */
export interface DelegatedKeyPremintD1Like {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> }
  }
}

/** What a turn's key is minted for. Its digest decides whether a parked key may serve a turn. */
export type DelegatedTurnKeyScope = Omit<DelegatedKeyRequest, 'name' | 'expiresAt' | 'retryUnavailable'>

export interface DelegatedTurnKeyInput {
  /** One parked key per slot, e.g. `<userId>:<workspaceId>:router`. */
  slot: string
  scope: DelegatedTurnKeyScope
  /** Life asked of Platform for each child; `notAfter` caps it. */
  ttlMs: number
  notAfter?: Date
  retryUnavailable?: DelegatedKeyRequest['retryUnavailable']
}

export interface DelegatedTurnKey {
  key: string
  id: string
  /** The id the child was minted for (`turn:<turnId>` at Platform): the turn's own id when minted inline, a
   *  random id when pre-minted. The turn records `id` beside its own id. */
  turnId: string
  expiresAt: Date
  /** Parked before this turn: a revoked or expired refusal of it means mint inline (`delegatedKeyFallbackFetch`). */
  preminted: boolean
}

export type DelegatedTurnKeyEvent =
  | { type: 'claimed' | 'missed' | 'parked' | 'park_kept'; slot: string }
  | { type: 'park_failed'; slot: string; code: string }

export interface DelegatedTurnKeysOptions {
  client: PlatformDelegatedKeyClient
  /** Null turns pre-minting off: every turn mints inline, as before. */
  db: DelegatedKeyPremintD1Like | null
  /** The app's at-rest crypto (`createFieldCrypto` from `./crypto`). */
  crypto: KeyCrypto
  /** Defaults to `delegated_key_premint`. */
  table?: string
  /** A parked key serves a turn only with at least this much life left. Default 10 min, above a turn's budget. */
  minRemainingMs?: number
  onEvent?: (event: DelegatedTurnKeyEvent) => void
  now?: () => number
}

export interface DelegatedTurnKeys {
  /**
   * This turn's key: the slot's parked key, taken exactly once, else a fresh mint named `turn:<turnId>`. Then the
   * next turn's key is minted and parked through `waitUntil` (the Worker's `ctx.waitUntil`), off this turn's path.
   */
  forTurn(input: DelegatedTurnKeyInput & { turnId: string; waitUntil?: (promise: Promise<unknown>) => void }):
    Promise<DelegatedKeyOutcome<DelegatedTurnKey>>
  /** Mint and park a key for the slot's next turn, e.g. when a member session opens. Never throws. */
  park(input: DelegatedTurnKeyInput): Promise<boolean>
  /** Mint inline, as a turn did before pre-minting. */
  mint(input: DelegatedTurnKeyInput & { turnId: string }): Promise<DelegatedKeyOutcome<DelegatedTurnKey>>
}

const PREMINT_TABLE = 'delegated_key_premint'
const PREMINT_MIN_REMAINING_MS = 10 * 60_000
// A parked key is kept rather than replaced while it has this much more life than a claim needs.
const PREMINT_KEEP_SLACK_MS = 5 * 60_000

/** The digest of everything a child is minted for, so a key minted for another request never serves this one. */
async function scopeDigest(scope: DelegatedTurnKeyScope): Promise<string> {
  const budget = scope.budget
  return sha256Hex(JSON.stringify([
    scope.sourceKey, scope.product, scope.resource?.type ?? null, scope.resource?.id ?? null,
    scope.allowedModels ? [...new Set(scope.allowedModels)].sort() : null,
    budget && 'usd' in budget ? budget.usd : null, budget && 'spendThrough' in budget ? true : null, budget?.monthlyUsd ?? null,
    scope.rpmLimit ?? null, scope.expect?.payerId ?? null, scope.expect?.sourceKeyId ?? null, scope.expect?.originAppId ?? null,
  ]))
}

export function createDelegatedTurnKeys(options: DelegatedTurnKeysOptions): DelegatedTurnKeys {
  const table = options.table ?? PREMINT_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid delegated key premint table: ${JSON.stringify(table)}`)
  const now = options.now ?? Date.now
  const minRemainingMs = options.minRemainingMs ?? PREMINT_MIN_REMAINING_MS
  const emit = (event: DelegatedTurnKeyEvent) => { try { options.onEvent?.(event) } catch { /* a log hook never fails a turn */ } }
  const db = options.db

  async function mint(input: DelegatedTurnKeyInput & { turnId: string }, preminted: boolean): Promise<DelegatedKeyOutcome<DelegatedTurnKey>> {
    const expiresAt = new Date(Math.min(now() + input.ttlMs, input.notAfter?.getTime() ?? Infinity))
    const outcome = await options.client.delegate({
      ...input.scope, name: `turn:${input.turnId}`, expiresAt,
      ...(input.retryUnavailable ? { retryUnavailable: input.retryUnavailable } : {}),
    })
    if (!outcome.succeeded) return outcome
    const { key, id } = outcome.value
    return { succeeded: true, value: { key, id, turnId: input.turnId, expiresAt: outcome.value.expiresAt, preminted } }
  }

  // Best effort: a key nobody will use is retired now, or expires on its own.
  async function retire(scope: DelegatedTurnKeyScope, keyId: string): Promise<void> {
    const payerId = scope.expect?.payerId
    await options.client.revoke({ sourceKey: scope.sourceKey, keyId,
      ...(payerId ? { slot: { userId: payerId, ...(scope.expect?.sourceKeyId ? { sourceKeyId: scope.expect.sourceKeyId } : {}) } } : {}),
    }).catch(() => null)
  }

  async function claim(slot: string, scope: DelegatedTurnKeyScope): Promise<DelegatedTurnKey | null> {
    if (!db) return null
    const row = await db.prepare(`DELETE FROM ${table} WHERE slot = ?1 AND scope = ?2 AND expires_at > ?3
RETURNING turn_id, key_id, key_encrypted, expires_at`).bind(slot, await scopeDigest(scope), now() + minRemainingMs)
      .first<{ turn_id: string; key_id: string; key_encrypted: string; expires_at: number }>()
    if (!row) return null
    try {
      const key = await options.crypto.decrypt(row.key_encrypted)
      return { key, id: row.key_id, turnId: row.turn_id, expiresAt: new Date(row.expires_at), preminted: true }
    } catch {
      await retire(scope, row.key_id)
      return null
    }
  }

  async function park(input: DelegatedTurnKeyInput): Promise<boolean> {
    if (!db) return false
    let scope: string
    try {
      scope = await scopeDigest(input.scope)
      const held = await db.prepare(`SELECT scope, expires_at FROM ${table} WHERE slot = ?1`).bind(input.slot)
        .first<{ scope: string; expires_at: number }>()
      if (held?.scope === scope && held.expires_at > now() + minRemainingMs + PREMINT_KEEP_SLACK_MS) {
        emit({ type: 'park_kept', slot: input.slot })
        return true
      }
    } catch {
      emit({ type: 'park_failed', slot: input.slot, code: 'premint_store_failed' })
      return false
    }
    const minted = await mint({ ...input, turnId: crypto.randomUUID() }, true)
    if (!minted.succeeded) {
      emit({ type: 'park_failed', slot: input.slot, code: minted.error.code })
      return false
    }
    try {
      const encrypted = await options.crypto.encrypt(minted.value.key)
      // An unclaimed key this one replaces (another request's, or near expiry) is never handed out again.
      const displaced = await db.prepare(`DELETE FROM ${table} WHERE slot = ?1 RETURNING key_id`).bind(input.slot)
        .first<{ key_id: string }>()
      if (displaced) await retire(input.scope, displaced.key_id)
      const stored = await db.prepare(`INSERT INTO ${table} (slot, scope, turn_id, key_id, key_encrypted, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(slot) DO NOTHING RETURNING slot`)
        .bind(input.slot, scope, minted.value.turnId, minted.value.id, encrypted, minted.value.expiresAt.getTime()).first()
      if (!stored) {
        // A racing park filled the slot first; this key would be a second unused one.
        await retire(input.scope, minted.value.id)
        emit({ type: 'park_kept', slot: input.slot })
        return true
      }
      emit({ type: 'parked', slot: input.slot })
      return true
    } catch {
      // The minted child never reached the slot, so nothing will hand it out: retire it now (best effort).
      await retire(input.scope, minted.value.id)
      emit({ type: 'park_failed', slot: input.slot, code: 'premint_store_failed' })
      return false
    }
  }

  return {
    async forTurn(input) {
      // A slot store that fails (no table, D1 down) is a miss: the turn mints inline as before.
      const claimed = await claim(input.slot, input.scope).catch(() => null)
      if (db) {
        const next = park({ slot: input.slot, scope: input.scope, ttlMs: input.ttlMs,
          ...(input.notAfter ? { notAfter: input.notAfter } : {}) })
        input.waitUntil?.(next)
      }
      emit({ type: claimed ? 'claimed' : 'missed', slot: input.slot })
      return claimed ? { succeeded: true, value: claimed } : mint(input, false)
    },
    park,
    mint: (input) => mint(input, false),
  }
}

/** Router's refusal of a key Platform revoked or let expire: 401 `invalid_key` naming the reason (lib/key-refusal.ts).
 *  Anything else, a bare `invalid_key` (a spent key verifies as invalid without a reason), a 402
 *  `key_budget_exhausted` or a 403, is the turn's answer: a second mint would give the turn a second cap. */
async function revokedOrExpired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  const body = await response.clone().json().catch(() => null) as { error?: { code?: unknown; reason?: unknown } } | null
  return body?.error?.code === 'invalid_key' && (body.error.reason === 'key_revoked' || body.error.reason === 'key_expired')
}

/**
 * A fetch for one turn that sends a pre-minted key and, when the Router refuses it as revoked or expired (Platform
 * retired the parked child), mints inline once and resends that request with the fresh key. Every later request,
 * and every request that was waiting on the same refusal, carries the fresh key; the parked key is not sent again.
 * A stream body is buffered first so the refused request can be resent. Requests whose `init.headers` carry another
 * credential, and keys minted inline, pass through. Make one per turn: the re-mint it shares belongs to that turn.
 */
export function delegatedKeyFallbackFetch(input: {
  key: DelegatedTurnKey
  remint: () => Promise<DelegatedKeyOutcome<DelegatedTurnKey>>
  fetch?: typeof fetch
  onReplaced?: (key: DelegatedTurnKey) => void
}): typeof fetch {
  const base = input.fetch ?? fetch
  if (!input.key.preminted) return base
  const parked = `Bearer ${input.key.key}`
  // This turn's one re-mint, shared by this turn's own requests only (the closure is per turn).
  let replacement: Promise<string | null> | undefined
  const remint = () => replacement ??= input.remint().then((fresh) => {
    if (!fresh.succeeded) return null
    input.onReplaced?.(fresh.value)
    return `Bearer ${fresh.value.key}`
  }, () => null)
  return async (resource, init) => {
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== parked) return base(resource, init)
    const body = init?.body instanceof ReadableStream ? await new Response(init.body).arrayBuffer() : init?.body
    const send = (bearer: string) => {
      headers.set('authorization', bearer)
      return base(resource, { ...init, headers, ...(body !== undefined ? { body } : {}) })
    }
    const fresh = replacement ? await replacement : null
    if (fresh) return send(fresh)
    const response = await send(parked)
    if (!(await revokedOrExpired(response))) return response
    const next = await remint()
    if (!next) return response
    await response.body?.cancel().catch(() => {})
    return send(next)
  }
}
