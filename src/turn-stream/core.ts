/**
 * `/turn-stream` core — the pure, substrate-free half of the shared durable
 * turn replay/broadcast/lock channel (issue #221).
 *
 * Extracted from the reference consumer's hand-rolled Durable Object
 * (gtm-agent `SessionStreamDO` + `session-broadcast.ts`): the per-turn
 * segment store that backs reconnect replay over a live socket, the
 * single-flight chat-turn lock record and its release fences, and the wire
 * contract (channel keys, endpoint paths, request/response bodies) shared by
 * the DO transport shell (`./do`) and the worker-side adapters
 * (`./adapters`). Everything here is plain data + functions — no
 * `cloudflare:workers`, no storage, no sockets — so the semantics are
 * unit-testable in Node and the DO stays a thin shell.
 *
 * ── The two-lane rule (measured, not assumed) ────────────────────────────
 *
 * A 4-arm A/B on production (sandbox.tangle.tools, SDK 0.12.0, one box, one
 * gateway client per arm) established which sandbox lane a browser can see:
 *
 *   | turn driver                          | raw turn events | seen at gateway |
 *   | ------------------------------------ | --------------- | --------------- |
 *   | `box.streamPrompt()` (run/stream)    | 71 / 527 / 408  | 0 / 0 / 0       |
 *   | `box.session(id).sendMessage()`      | 297             | 297             |
 *   | `box.driveTurn()` (Sandbox 0.37+)    | —               | SDK contract    |
 *
 * `POST /agents/run/stream` publishes nothing to the sidecar session event
 * bus, so a `SessionGatewayClient` attached to that session receives zero
 * turn events — three different session-id strategies all got 0, the id was
 * not the variable. `POST /agents/sessions/{id}/messages` publishes to the
 * bus and the gateway delivered every frame, byte-matching the sidecar tail.
 * Sandbox 0.37 admits `driveTurn` through the session message lane, so the
 * gateway can observe it. That is an SDK contract, not a new production count.
 *
 * Consequences for this module, and they cut both ways:
 *
 * 1. INTERACTIVE sandbox turns are driven on the message lane and tailed
 *    by the browser through `box.mintScopedToken({ scope: 'session' })` +
 *    `SessionGatewayClient`. The former per-turn SEGMENT rebroadcast lane
 *    that duplicated this was REMOVED (0.52.0) after every product had
 *    moved off it — do not rebuild it.
 * 2. Detached turns driven through `dispatchPrompt({ detach: true })` or
 *    `streamPrompt` remain on the run/stream lane and keep the durable
 *    turn-event rows (`turn:` channels) when a browser must tail them.
 *    Sandbox 0.37 `driveTurn` is different: it uses the session message
 *    lane and the gateway can observe it by SDK contract.
 * 3. The LOCK and the per-workspace SIGNALS have no gateway equivalent at
 *    all (the gateway is per-session and read-only). They stay canonical.
 *
 * Server-side resume of a run/stream turn is also already solved by the SDK
 * and needs nothing here: `box.streamPrompt('', { executionId, lastEventId })`
 * replays strictly after the cursor without re-dispatching — measured across
 * a SIGKILL mid-run and a fresh process resuming from the cursor alone:
 * 0 lost, 0 duplicated, 0 out-of-order, ids 1..517 contiguous.
 */

import { constantTimeEqual } from '../crypto/web-token'

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

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

/** Request header the adapters attach (and the DO accepts). The WS upgrade
 *  additionally accepts `?token=` because browsers cannot set headers on a
 *  WebSocket handshake. */
export const TURN_STREAM_TOKEN_HEADER = 'x-turn-stream-token'

/** `v1.<exp-ms-36>.<hmac-hex>` — the expiry is inside the signed payload so
 *  it cannot be extended by editing the token. */
export async function mintTurnStreamToken(
  channelName: string,
  secret: string,
  now: () => number = Date.now,
  ttlMs: number = TURN_STREAM_TOKEN_TTL_MS,
): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('turn-stream token secret must be at least 32 characters')
  const expiresAt = now() + ttlMs
  const payload = `v1.${channelName}.${expiresAt.toString(36)}`
  return `${payload}.${await hmacSha256Hex(secret, payload)}`
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
  if (name !== channelName) return false
  if (!/^[0-9a-z]+$/.test(expires36)) return false
  const expiresAt = parseInt(expires36, 36)
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) return false
  const expected = await hmacSha256Hex(secret, `v1.${channelName}.${expires36}`)
  return constantTimeEqual(mac, expected)
}

// ── channel keys ────────────────────────────────────────────────────────────
//
// One DO instance per channel key. Three families:
//   thread     `${workspaceId}:${threadId}` — live turn fanout + segments +
//              the thread-scope lock.
//   workspace  `${workspaceId}`             — sidebar activity + thread.created
//              + the workspace-scope lock.
//   turn       `turn:${turnId}`             — durable turn-event rows + status
//              (the TurnEventStore contract; replay survives DO eviction).
//   scope      `scope:${scopeId}`           — running-turn index for a thread,
//              backing `TurnEventStore.listRunning`.

/** Define the scope level for acquiring a turn lock within thread or workspace contexts */
export type TurnLockScope = 'thread' | 'workspace'

/** Generate a unique string key combining workspace and thread identifiers.
 *
 *  KEPT: thread-scope LOCKS are keyed on it (see {@link turnLockChannelKey}).
 *  Only its second use — addressing a live-viewer socket for interactive
 *  sandbox-turn rebroadcast — is superseded by the session gateway. */
export function threadChannelKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`
}

/** Generate a unique channel key based on the given workspace identifier.
 *
 *  KEPT and canonical: the per-workspace signal channel (`thread.created`,
 *  `thread.activity`) plus workspace-scope locks. The session gateway is
 *  per-SESSION and read-only, so it cannot carry either. */
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

/** Generate a storage channel key string for a given turn identifier.
 *
 *  KEPT and canonical: durable turn-event rows for stream/dispatch detached
 *  runs live on this instance. Those run/stream paths do not reach the
 *  session gateway, so this is how a browser tails one. */
export function turnStorageChannelKey(turnId: string): string {
  return `turn:${turnId}`
}

/** Generate a unique channel key string based on the provided scope identifier.
 *
 *  KEPT and canonical: backs `TurnEventStore.listRunning`, which is how a
 *  reloaded client rediscovers an in-flight DETACHED turn. */
export function scopeIndexChannelKey(scopeId: string): string {
  return `scope:${scopeId}`
}

// ── segment store ───────────────────────────────────────────────────────────
//
// REMOVED (0.52.0): the deprecated interactive-turn rebroadcast buffer
// (`createSegmentStore` / `appendSegmentEvent` / `replayActiveSegment` /
// `MAX_SEGMENT_EVENTS` / `broadcastTurnStreamEvent`). Every product drives
// interactive turns on the sandbox session-message lane, where the SDK's
// own gateway replays losslessly; detached runs keep the durable `turn:`
// rows. Rebuilding per-turn in-DO segments would duplicate the SDK and
// re-open the client-declared-sessionId fanout this removal closed.

/**
 * Remove responding entries (threadId → startedAt) older than `ttlMs`, so a
 * dropped `end` broadcast can't leave a permanently-stuck dot. Mutates
 * `active` and returns the removed thread ids.
 */
/** Recent `thread.created` markers kept for late-connecting sidebars.
 *
 *  KEPT: a workspace-level signal, not a turn rebroadcast. */
export const MAX_RECENT_CREATED = 50

/** A responding marker older than this is treated as stale, so a dropped
 *  `end` broadcast can't leave a permanently-stuck "responding" dot. */
export const ACTIVITY_TTL_MS = 15 * 60 * 1000


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

/** Default lifetime of an unreleased lock. Long enough that a legitimately
 *  slow sandbox turn never loses its guard mid-run; the way OUT of a wedge is
 *  never the TTL but `reconcileStaleTurnLock` (in `/chat-routes`), which
 *  probes the execution's actual state.
 *
 *  Everything from here down is the LOCK, and it is fully KEPT. The sandbox
 *  SDK ships no single-flight primitive — the session gateway is a read-only
 *  fanout — so moving a product to the message lane changes nothing about
 *  who is allowed to start a turn. */
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

/** A cooperative release must present the lock's own identity — both the
 *  execution and the lockId minted at acquire — so a retry of a PREVIOUS turn
 *  can never release the current one. `lockId` is optional only for the DO's
 *  internal terminal-event auto-release, which knows the execution but not
 *  the caller-held lockId. */
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
