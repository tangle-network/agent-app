/**
 * Channel tokens, lock records, workspace signals, and durable event keys.
 * Interactive turn replay belongs to the sandbox session gateway.
 * An optional turn-event backend stores durable rows and a running-turn index.
 * This core uses WebCrypto and plain data without a Cloudflare runtime import.
 */

import { base64UrlEncodeText, constantTimeEqual, hmacSha256Base64Url } from '../crypto/web-token'

// ── events ──────────────────────────────────────────────────────────────────

/** One event on a turn-stream channel. Workspace-signal events
 *  (`thread.created`, `thread.activity`, product events) carry no `seq` —
 *  ordering is delivery order on the DO's single-threaded event loop. */
export interface TurnStreamEvent {
  type: string
  data?: unknown
  timestamp: number
  seq?: never
}

// ── channel-bound capability tokens (issue #746) ─────────────────────────────
//
// The DO's endpoints are not publicly routed, but "safe because nothing
// forwards to it" is convention, not enforcement: one accidental
// `stub.fetch(publicRequest)` and every channel's lock, turn events, and
// signals are cross-tenant writable. Every request the DO serves must now
// carry a short-lived HMAC capability token minted for THIS DO's channel
// name — a valid token for one channel is refused by every other, and a
// token without the secret cannot exist. Worker code mints with the same
// secret via the adapters (`authSecret`) and the WS upgrade forwarder;
// nothing else needs to know the format.

/** Default capability lifetime. Tokens are minted per worker request and
 *  verified immediately; a WS token gates only the upgrade handshake — an
 *  accepted socket lives until it closes. */
export const TURN_STREAM_TOKEN_TTL_MS = 60_000

/** Request header the adapters attach (and the DO accepts). The worker also
 *  attaches it when forwarding an authorized browser WebSocket handshake. */
export const TURN_STREAM_TOKEN_HEADER = 'x-turn-stream-token'

/** `v1.<base64url-channel>.<exp-ms-36>.<base64url-mac>` — the expiry is inside the signed payload so
 *  it cannot be extended by editing the token. */
export async function mintTurnStreamToken(
  channelName: string,
  secret: string,
  now: () => number = Date.now,
  ttlMs: number = TURN_STREAM_TOKEN_TTL_MS,
): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('turn-stream token secret must be at least 32 characters')
  const expiresAt = now() + ttlMs
  const payload = `v1.${base64UrlEncodeText(channelName)}.${expiresAt.toString(36)}`
  return `${payload}.${await hmacSha256Base64Url(payload, secret)}`
}

/** Verify a token for `channelName`: constant-time MAC compare with the
 *  exact channel name embedded in the signed payload, plus freshness. A
 *  token minted for any other channel — or a tampered expiry — is false. */
export async function verifyTurnStreamToken(
  channelName: string,
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!secret || secret.length < 32) return false
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return false
  const [, name, expires36, mac] = parts as [string, string, string, string]
  if (name !== base64UrlEncodeText(channelName)) return false
  if (!/^[0-9a-z]+$/.test(expires36)) return false
  const expiresAt = parseInt(expires36, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false
  const expected = await hmacSha256Base64Url(`v1.${name}.${expires36}`, secret)
  return constantTimeEqual(mac, expected)
}

// ── channel keys ────────────────────────────────────────────────────────────
//
// One DO instance per channel key. Four families:
//   thread     `${workspaceId}:${threadId}` — thread-scope lock.
//   workspace  `${workspaceId}`             — sidebar activity + thread.created
//              + the workspace-scope lock.
//   turn       `turn:${turnId}`             — durable turn-event rows + status
//              (the TurnEventStore contract; replay survives DO eviction).
//   scope      `scope:${scopeId}`           — running-turn index for a thread,
//              backing `TurnEventStore.listRunning`.

/** Define the scope level for acquiring a turn lock within thread or workspace contexts */
export type TurnLockScope = 'thread' | 'workspace'

/** Channel for a thread-scoped lock. */
export function threadChannelKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`
}

/** Channel for workspace signals and the workspace-scoped lock. */
export function workspaceChannelKey(workspaceId: string): string {
  return workspaceId
}

/** The channel a lock lives on: workspace-scope locks serialize every thread
 *  in the workspace (one shared sandbox), thread-scope locks serialize one
 *  thread (router lane). Same keying as the reference consumer, so a product
 *  swapping its fork for this package contends on identical instances. */
export function turnLockChannelKey(workspaceId: string, threadId: string, scope: TurnLockScope): string {
  return scope === 'workspace' ? workspaceChannelKey(workspaceId) : threadChannelKey(workspaceId, threadId)
}

/** Channel for the optional Durable Object turn-event backend. */
export function turnStorageChannelKey(turnId: string): string {
  return `turn:${turnId}`
}

/** Running-turn index for the optional Durable Object turn-event backend. */
export function scopeIndexChannelKey(scopeId: string): string {
  return `scope:${scopeId}`
}

/** Recent thread-created markers kept for late-connecting sidebars. */
export const MAX_RECENT_CREATED = 50

/** A responding marker older than this is treated as stale, so a dropped
 *  `end` broadcast can't leave a permanently-stuck "responding" dot. */
export const ACTIVITY_TTL_MS = 15 * 60 * 1000

/** Remove responding markers older than ttlMs; return their thread IDs. */
export function pruneStaleThreads(active: Map<string, number>, now: number, ttlMs: number): string[] {
  const removed: string[] = []
  for (const [threadId, startedAt] of active) {
    if (now - startedAt > ttlMs) {
      active.delete(threadId)
      removed.push(threadId)
    }
  }
  return removed
}

// ── chat-turn lock record + fences ──────────────────────────────────────────

/** Fallback lifetime for an unreleased lock. Use stale-lock reconciliation to
 *  recover earlier when execution state proves that its holder stopped. */
export const TURN_LOCK_TTL_MS = 30 * 60 * 1000

/** The stored single-flight lock. Field-compatible with the reference
 *  consumer's `ChatTurnLock` so adoption is a swap, not a migration. */
export interface DurableTurnLock {
  workspaceId: string
  threadId: string
  scope: TurnLockScope
  executionId: string
  lockId: string
  startedAt: number
  expiresAt: number
  turnId?: string
  /** The turn released this lock, but a product-owned post-turn task (e.g.
   *  file persistence reading the box) is still running, so the release is
   *  parked on the lock until the task settles. Written only through the DO's
   *  defer seam — the base package never sets it on its own. */
  releasePending?: boolean
}

/** Define input parameters required to acquire a turn-based lock in a workspace thread */
export interface TurnLockAcquireInput {
  workspaceId: string
  threadId: string
  scope: TurnLockScope
  executionId: string
  lockId: string
  turnId?: string
}

/** Resolve the result of attempting to acquire a turn lock indicating success or active lock status */
export type TurnLockAcquireResult =
  | { acquired: true; lock: DurableTurnLock }
  | { acquired: false; active: DurableTurnLock }

/** Define input parameters required to release a turn lock in a specific workspace thread */
export interface TurnLockReleaseInput {
  workspaceId: string
  threadId: string
  scope: TurnLockScope
  executionId: string
  lockId: string
}

/** Fenced out-of-band release (stop button, stale-lock reconciliation). The
 *  fences make it refuse a SUCCESSOR lock: `interruptedAt` must not precede
 *  the lock's own start, and when either side names a turn, both must name
 *  the same one. */
export interface TurnLockInterruptedReleaseInput {
  workspaceId: string
  threadId: string
  /** Try only this scope; omit to try workspace then thread. */
  scope?: TurnLockScope
  interruptedAt: number
  turnId?: string
}

/** `stored` is what the DO read from storage; expired locks are dead. */
export function activeTurnLock(stored: DurableTurnLock | undefined, now: number): DurableTurnLock | null {
  if (!stored) return null
  // Locks written before the scope field existed default to thread scope.
  const lock = stored.scope ? stored : { ...stored, scope: 'thread' as const }
  return lock.expiresAt > now ? lock : null
}

/** Create a durable turn lock object with timing and scope based on input parameters */
export function createTurnLock(input: TurnLockAcquireInput, now: number, ttlMs = TURN_LOCK_TTL_MS): DurableTurnLock {
  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    scope: input.scope,
    executionId: input.executionId,
    lockId: input.lockId,
    startedAt: now,
    expiresAt: now + ttlMs,
    ...(input.turnId ? { turnId: input.turnId } : {}),
  }
}

/** A cooperative release matches the execution and, when supplied, lock ID. */
export function turnLockMatchesRelease(
  active: DurableTurnLock,
  input: { executionId: string; lockId?: string },
): boolean {
  if (active.executionId !== input.executionId) return false
  if (input.lockId && active.lockId !== input.lockId) return false
  return true
}

/**
 * The interrupted/stale release fence. `interruptedAt` is the instant the
 * releasing evidence was observed (the stop click, the stale-lock probe) —
 * a lock STARTED after that instant is a successor the evidence says nothing
 * about, so it survives. When the lock recorded a client turnId, the release
 * must name the same turn; a lock without one refuses a turn-specific
 * release (it cannot prove it is that turn).
 */
export function interruptedReleaseApplies(
  active: DurableTurnLock,
  input: { threadId: string; interruptedAt: number; turnId?: string },
): boolean {
  if (active.threadId !== input.threadId) return false
  if (active.startedAt > input.interruptedAt) return false
  if (active.turnId) {
    if (active.turnId !== input.turnId) return false
  } else if (input.turnId) {
    return false
  }
  return true
}

// ── wire contract (adapter ↔ DO endpoint paths) ─────────────────────────────
//
// Kept byte-identical to the reference consumer's DO where an endpoint
// existed there, so a product deletes its fork by re-pointing a binding, not
// by re-speaking a protocol.

/** Provide constant paths for managing chat turn streams and locks */
export const TURN_STREAM_PATHS = {
  broadcast: '/broadcast',
  lockAcquire: '/chat-turn-lock/acquire',
  /** Read the active lock without changing it; also brings the object up before a turn needs it. */
  lockPeek: '/chat-turn-lock/peek',
  lockRelease: '/chat-turn-lock/release',
  lockReleaseInterrupted: '/chat-turn-lock/release-interrupted',
  turnEventsAppend: '/turn-events/append',
  turnEventsRead: '/turn-events/read',
  turnStatusSet: '/turn-status/set',
  turnStatusGet: '/turn-status/get',
  scopeStatusSet: '/turn-scope/set',
  scopeRunningList: '/turn-scope/running',
} as const

/** Storage keys inside a DO instance. Exported for subclass coexistence —
 *  a product extending the DO must not collide with these. */
export const TURN_STREAM_STORAGE_KEYS = {
  lock: 'chatTurnLock',
  activeThreads: 'activeThreads',
  turnStatus: 'turnStatus',
  turnScope: 'turnScopeIndex',
  turnEventPrefix: 'turnEvent:',
} as const

/** Zero-padded seq so DO storage `list({ prefix })` returns rows in replay
 *  order without a sort. 10 digits holds any realistic turn. */
export function turnEventStorageKey(seq: number): string {
  return `${TURN_STREAM_STORAGE_KEYS.turnEventPrefix}${String(seq).padStart(10, '0')}`
}
