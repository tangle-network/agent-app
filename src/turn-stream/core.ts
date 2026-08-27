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
 */

// ── events ──────────────────────────────────────────────────────────────────

/** One event on a turn-stream channel. `seq` is monotonic within a turn
 *  segment and assigned by {@link appendSegmentEvent} on arrival at the DO. */
export interface TurnStreamEvent {
  type: string
  data?: unknown
  timestamp: number
  seq?: number
}

/** Terminal run markers: they close a turn segment and auto-release the
 *  channel's chat-turn lock for the segment's execution. */
export function isTerminalRunEvent(type: string): boolean {
  return type === 'session.run.completed' || type === 'session.run.failed'
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

/** Generate a unique string key combining workspace and thread identifiers */
export function threadChannelKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`
}

/** Generate a unique channel key based on the given workspace identifier */
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

/** Generate a storage channel key string for a given turn identifier */
export function turnStorageChannelKey(turnId: string): string {
  return `turn:${turnId}`
}

/** Generate a unique channel key string based on the provided scope identifier */
export function scopeIndexChannelKey(scopeId: string): string {
  return `scope:${scopeId}`
}

// ── segment store (reconnect replay over a live socket) ─────────────────────

/** Represent a segment of a turn containing events, sequence limit, and terminal status */
export interface TurnSegment {
  events: TurnStreamEvent[]
  maxSeq: number
  terminal: boolean
}

/** Define a store managing segments and tracking the active execution identifier */
export interface SegmentStore {
  segments: Map<string, TurnSegment>
  activeExecutionId: string | null
}

/** Per-turn replay window. Generous enough for normal turns; a turn that
 *  exceeds it loses its earliest deltas from replay (a late resumer
 *  self-heals via the final `result` event + loader revalidation). */
export const MAX_SEGMENT_EVENTS = 2000

/** Recent `thread.created` markers kept for late-connecting sidebars. */
export const MAX_RECENT_CREATED = 50

/** A responding marker older than this is treated as stale, so a dropped
 *  `end` broadcast can't leave a permanently-stuck "responding" dot. */
export const ACTIVITY_TTL_MS = 15 * 60 * 1000

/** Create a SegmentStore with initialized segments and no active execution ID */
export function createSegmentStore(): SegmentStore {
  return { segments: new Map(), activeExecutionId: null }
}

/**
 * Append a per-turn event to its execution's segment, assigning a monotonic
 * `seq`. A `session.run.started` (or the first-seen event for an execution)
 * opens a fresh segment, makes it active, and drops prior turns' buffers so a
 * resumer only ever replays the current turn. A terminal run event marks the
 * segment terminal. Returns the seq-stamped event to broadcast.
 */
export function appendSegmentEvent(
  store: SegmentStore,
  executionId: string,
  incoming: TurnStreamEvent,
  maxEvents = MAX_SEGMENT_EVENTS,
): TurnStreamEvent {
  let segment = store.segments.get(executionId)
  if (incoming.type === 'session.run.started' || !segment) {
    if (!segment) {
      segment = { events: [], maxSeq: 0, terminal: false }
      store.segments.set(executionId, segment)
    }
    store.activeExecutionId = executionId
    for (const id of store.segments.keys()) {
      if (id !== executionId) store.segments.delete(id)
    }
  }
  const seq = ++segment.maxSeq
  const stamped: TurnStreamEvent = { ...incoming, seq }
  segment.events.push(stamped)
  if (segment.events.length > maxEvents) {
    segment.events = segment.events.slice(-maxEvents)
  }
  if (isTerminalRunEvent(incoming.type)) {
    segment.terminal = true
  }
  return stamped
}

/**
 * Events of the active, non-terminal turn with `seq > afterSeq` — what a
 * (re)connecting client replays before going live. A terminal (finished) turn
 * replays nothing: the client falls back to the loader's persisted row.
 */
export function replayActiveSegment(store: SegmentStore, afterSeq: number): TurnStreamEvent[] {
  const segment = store.activeExecutionId ? store.segments.get(store.activeExecutionId) : undefined
  if (!segment || segment.terminal) return []
  return segment.events.filter((event) => (event.seq ?? 0) > afterSeq)
}

/**
 * Remove responding entries (threadId → startedAt) older than `ttlMs`, so a
 * dropped `end` broadcast can't leave a permanently-stuck dot. Mutates
 * `active` and returns the removed thread ids.
 */
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
 *  probes the execution's actual state. */
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
