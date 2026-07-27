/**
 * Dual-lane turn recovery — the reconnect STRATEGY that sits above
 * `./chat-stream`'s parse primitives.
 *
 * A browser watching a turn can lose the transport at any moment (tab sleep,
 * wifi blip, the server's follow window closing while the turn is still
 * running). Two lanes can deliver that turn, and they are not interchangeable:
 *
 *   live    — the sandbox platform's session gateway (WebSocket, browser-direct).
 *             Lowest latency, but it only carries turns driven on the session
 *             MESSAGE lane. A `streamPrompt`/`dispatchPrompt({detach:true})`/
 *             `driveTurn` turn publishes NOTHING to it (measured 0 events), so
 *             an autonomous or detached run is invisible there.
 *   durable — the product's own replay endpoint over a `TurnEventStore`
 *             (`GET …/replay/:turnId?fromSeq=N`). Always works, slightly behind.
 *
 * This module owns the RECOVERY only. It deliberately does NOT interpret the
 * event vocabulary: the live lane carries raw sandbox frames while the durable
 * lane carries producer-flattened wire events, and translating between them
 * client-side would re-implement `createSandboxChatProducer` in the browser.
 * Consumers get `RecoveredTurnEvent` and own their reducer; a durable-only
 * consumer can route straight back into `ChatStreamCallbacks` via
 * `chatStreamLaneListener`.
 *
 * The live lane is OPTIONAL. Omit `attachLive` and this is a pure durable
 * reconnect loop with cursor continuation — which is the load-bearing
 * configuration today, and the one a product with no sandbox session wants.
 */

import { dispatchChatStreamLine, type ChatStreamCallbacks } from './chat-stream'

/** Which lane delivered an event. */
export type TurnLane = 'live' | 'durable'

/**
 * A normalized transport event. `type`/`data` are passed through VERBATIM —
 * the vocabulary differs per lane and is the product's to interpret.
 */
export interface RecoveredTurnEvent {
  lane: TurnLane
  type: string
  data?: Record<string, unknown>
  /** Durable-lane buffer sequence. Absent on the live lane (a different,
   *  incompatible sequence space — see `followTurn`). */
  seq?: number
  /** The raw NDJSON line, durable lane only. Feed to `dispatchChatStreamLine`. */
  line?: string
}

/** A live-lane connection the follower can tear down. */
export interface LiveLaneAttachment {
  close(): void
}

/** Callbacks a `LiveLaneConnector` drives while it is attached. */
export interface LiveLaneHandlers {
  turnId: string
  signal: AbortSignal
  /** A real turn event (transport notices must already be filtered out). */
  onEvent(event: { type: string; data?: Record<string, unknown> }): void
  /** The lane proved it is delivering. MUST fire only after the transport-notice
   *  filter, or a heartbeat counts as liveness and the silence guard never trips. */
  onFirstTurnEvent(): void
  /** A terminal event for this turn arrived. */
  onTerminal(): void
  /** The lane cannot serve this turn (auth, socket error, expired token). */
  onUnusable(reason: string): void
}

/**
 * Structural port for a live lane. Resolving `null` is a SOFT MISS — no lane is
 * attachable (no sandbox, no session, unreachable gateway) and the follower
 * falls straight through to the durable lane. Never throw for that case.
 */
export type LiveLaneConnector = (
  handlers: LiveLaneHandlers,
) => Promise<LiveLaneAttachment | null>

/** Why accumulated turn state must be discarded before more events arrive. */
export type TurnResetReason =
  /** The live lane rendered something, then died; the durable lane is about to
   *  replay the same turn from zero. Rebuild or the two lanes double-render. */
  | 'lane-switch'
  /** The durable lane is replaying from zero after a drop it could not resume. */
  | 'resume'

/** Configure the dual-lane follow for one turn. */
export interface FollowTurnOptions {
  turnId: string
  signal?: AbortSignal
  /** GET the durable replay NDJSON. `fromSeq` is exclusive — the server replays
   *  events STRICTLY AFTER it, and 0 means from the beginning. */
  openReplay(turnId: string, fromSeq: number, signal: AbortSignal): Promise<Response>
  /** `GET …/running` → the turn ids still running. This is the turn-BOUNDARY
   *  authority for both lanes: neither lane can prove a turn already ended. */
  listRunning(signal: AbortSignal): Promise<string[]>
  /** Omit for durable-only recovery. */
  attachLive?: LiveLaneConnector
  onEvent(event: RecoveredTurnEvent): void
  onResetTurn?(reason: TurnResetReason): void
  onLaneChange?(lane: TurnLane): void
  /** How long a live lane may stay silent before it is written off. */
  liveSilenceTimeoutMs?: number
  /** Tick period of the settle poll while the live lane is attached. */
  settlePollIntervalMs?: number
  /** Ticks between `listRunning` calls before a terminal event is seen. */
  livenessPollTicks?: number
  /** Pause before reconnecting the durable lane after a closed follow window. */
  reconnectDelayMs?: number
}

/** How a followed turn ended. */
export interface FollowTurnResult {
  turnId: string
  /** The lane that delivered the final events. */
  lane: TurnLane
  status: 'complete' | 'error' | 'unknown' | 'timeout' | 'aborted'
  /** True when the live lane was tried and handed over to the durable lane. */
  fellBack: boolean
}

/** A live lane whose silence is measured; 30s matches the proven default. */
export const DEFAULT_LIVE_SILENCE_TIMEOUT_MS = 30_000
export const DEFAULT_SETTLE_POLL_INTERVAL_MS = 250
export const DEFAULT_LIVENESS_POLL_TICKS = 20
export const DEFAULT_RECONNECT_DELAY_MS = 250

/** Abort-aware sleep — resolves early on abort so teardown is instant. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Drain an NDJSON body line by line, carrying the trailing partial across
 * chunks and flushing it at EOF. Throws on transport failure — the caller
 * decides whether to resume.
 */
export async function drainNdjsonLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) onLine(buffer)
      return
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
}

/** `{running: string[]}` — the one discovery contract every app already shares. */
export function parseRunningTurnResponse(body: unknown): string[] {
  const running = (body as { running?: unknown } | null | undefined)?.running
  if (!Array.isArray(running)) return []
  return running.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** The outcome of a page-load running-turn probe. */
export type RunningTurnDiscovery =
  | { succeeded: true; turnId: string | null }
  | { succeeded: false; error: string }

/**
 * Probe for a turn already running on this thread. Never throws: a probe
 * failure must not be indistinguishable from "no turn is running", because
 * products gate their composer on the difference.
 */
export async function discoverRunningTurn(
  listRunning: (signal: AbortSignal) => Promise<string[]>,
  signal: AbortSignal,
): Promise<RunningTurnDiscovery> {
  try {
    const running = await listRunning(signal)
    return { succeeded: true, turnId: running[0] ?? null }
  } catch (err) {
    return { succeeded: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Terminal statuses the durable lane's sentinel line can carry. */
type TurnStatusValue = FollowTurnResult['status']

/** Read the `{type:'turn_status', status}` sentinel `replayTurnEvents` ends with. */
function statusFromSentinel(evt: Record<string, unknown> | undefined): TurnStatusValue {
  const status = evt?.status
  if (status === 'complete' || status === 'error' || status === 'timeout') return status
  return 'unknown'
}

/**
 * Follow one turn to completion across both lanes, recovering from transport
 * drops on the way.
 *
 * Live lane first when `attachLive` is supplied; on any soft miss the durable
 * lane takes over with cursor continuation. The two lanes' sequence spaces are
 * INCOMPATIBLE (the gateway's `seq` is a channel frame ordinal, the durable
 * lane's is a buffer ordinal), so there is no shared dedup key. The proven
 * cross-lane mechanism is state teardown: if the live lane rendered anything
 * before dying, `onResetTurn('lane-switch')` fires and the durable lane replays
 * from zero, so the consumer rebuilds rather than double-renders.
 */
export async function followTurn(opts: FollowTurnOptions): Promise<FollowTurnResult> {
  const {
    turnId,
    openReplay,
    listRunning,
    attachLive,
    onEvent,
    onResetTurn,
    onLaneChange,
    liveSilenceTimeoutMs = DEFAULT_LIVE_SILENCE_TIMEOUT_MS,
    settlePollIntervalMs = DEFAULT_SETTLE_POLL_INTERVAL_MS,
    livenessPollTicks = DEFAULT_LIVENESS_POLL_TICKS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  } = opts

  const controller = new AbortController()
  const signal = controller.signal
  const abortOuter = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', abortOuter, { once: true })
  }

  const done = (result: Omit<FollowTurnResult, 'turnId'>): FollowTurnResult => {
    opts.signal?.removeEventListener('abort', abortOuter)
    return { turnId, ...result }
  }

  let fellBack = false

  if (attachLive) {
    onLaneChange?.('live')
    const live = await followLiveLane({
      turnId,
      signal,
      attachLive,
      listRunning,
      onEvent,
      liveSilenceTimeoutMs,
      settlePollIntervalMs,
      livenessPollTicks,
    })
    if (signal.aborted) return done({ lane: 'live', status: 'aborted', fellBack: false })
    if (live.outcome === 'settled') {
      return done({ lane: 'live', status: live.status, fellBack: false })
    }
    fellBack = true
    // Only a lane that actually RENDERED forces a rebuild. A lane that never
    // delivered a byte leaves nothing to double-render, so the consumer keeps
    // whatever the POST already put on screen.
    if (live.emitted) onResetTurn?.('lane-switch')
  }

  onLaneChange?.('durable')
  const status = await followDurableLane({
    turnId,
    signal,
    openReplay,
    listRunning,
    onEvent,
    onResetTurn,
    reconnectDelayMs,
  })
  return done({ lane: 'durable', status, fellBack })
}

/**
 * Durable-lane recovery on its own — the whole helper for a product with no
 * live lane (no sandbox session to attach to, or a detached run the session
 * gateway provably never sees).
 *
 * Identical to `followTurn` with `attachLive` omitted; exported separately so
 * that configuration is a named entry point rather than an absent field.
 */
export async function followDurableTurn(
  opts: Omit<FollowTurnOptions, 'attachLive'>,
): Promise<FollowTurnResult> {
  return followTurn(opts)
}

interface LiveLaneRun {
  outcome: 'settled' | 'unavailable'
  status: TurnStatusValue
  emitted: boolean
}

/**
 * Run the live lane until it settles the turn or proves itself unusable.
 *
 * Two racing guards, both mandatory:
 *  - the SILENCE guard catches a turn whose driver publishes nothing to the
 *    session bus (a detached run, an autonomous step) — the socket is healthy,
 *    it just carries no turn events, so only a timeout can detect it;
 *  - the SETTLE poll catches the finish-before-attach race, where the turn
 *    ended between discovery and the socket opening and no terminal event will
 *    ever arrive. It therefore runs unconditionally from the start; seeing a
 *    terminal event only TIGHTENS its cadence.
 */
async function followLiveLane(args: {
  turnId: string
  signal: AbortSignal
  attachLive: LiveLaneConnector
  listRunning(signal: AbortSignal): Promise<string[]>
  onEvent(event: RecoveredTurnEvent): void
  liveSilenceTimeoutMs: number
  settlePollIntervalMs: number
  livenessPollTicks: number
}): Promise<LiveLaneRun> {
  const { turnId, signal, attachLive, listRunning, onEvent } = args

  let resolved = false
  let emitted = false
  let turnEventSeen = false
  let terminalSeen = false
  let status: TurnStatusValue = 'unknown'
  let settle: (run: LiveLaneRun) => void = () => {}

  const finished = new Promise<LiveLaneRun>((resolve) => {
    settle = resolve
  })
  const finish = (outcome: 'settled' | 'unavailable') => {
    if (resolved) return
    resolved = true
    settle({ outcome, status, emitted })
  }

  const onAbort = () => finish('settled')
  if (signal.aborted) {
    status = 'aborted'
    finish('settled')
    return finished
  }
  signal.addEventListener('abort', onAbort, { once: true })

  // The attachment may resolve AFTER the lane already settled — hold it so the
  // late socket is closed rather than leaked.
  const attachment: { current: LiveLaneAttachment | null } = { current: null }

  try {
    void attachLive({
      turnId,
      signal,
      onEvent: (event) => {
        if (resolved) return
        emitted = true
        onEvent({ lane: 'live', type: event.type, ...(event.data ? { data: event.data } : {}) })
      },
      onFirstTurnEvent: () => {
        turnEventSeen = true
      },
      onTerminal: () => {
        terminalSeen = true
      },
      onUnusable: () => finish('unavailable'),
    })
      .then((opened) => {
        if (!opened) return finish('unavailable')
        attachment.current = opened
        if (resolved) opened.close()
      })
      .catch(() => finish('unavailable'))

    // Silence guard.
    void (async () => {
      await sleep(args.liveSilenceTimeoutMs, signal)
      if (resolved || signal.aborted) return
      if (!turnEventSeen) finish('unavailable')
    })()

    // Settle poll — the server owns the turn boundary, so ask it. Slow while the
    // run is live, fast once the lane has reported the run terminal.
    void (async () => {
      let tick = 0
      while (!resolved && !signal.aborted) {
        await sleep(args.settlePollIntervalMs, signal)
        if (resolved || signal.aborted) return
        tick += 1
        if (!terminalSeen && tick % args.livenessPollTicks !== 0) continue
        const running = await listRunning(signal).catch(() => null)
        if (resolved || signal.aborted) return
        if (running && !running.includes(turnId)) {
          status = terminalSeen ? 'complete' : 'unknown'
          return finish('settled')
        }
      }
    })()

    return await finished
  } finally {
    signal.removeEventListener('abort', onAbort)
    attachment.current?.close()
  }
}

/**
 * Drive the durable replay lane to completion, reconnecting from the last
 * delivered sequence whenever the follow window closes on a still-running turn.
 *
 * This continuation loop is the half a single-shot `fromSeq=0` reattach lacks:
 * the replay route ends its window after a bounded poll, and without the loop
 * the client simply stops mid-turn.
 */
async function followDurableLane(args: {
  turnId: string
  signal: AbortSignal
  openReplay(turnId: string, fromSeq: number, signal: AbortSignal): Promise<Response>
  listRunning(signal: AbortSignal): Promise<string[]>
  onEvent(event: RecoveredTurnEvent): void
  onResetTurn?(reason: TurnResetReason): void
  reconnectDelayMs: number
}): Promise<TurnStatusValue> {
  const { turnId, signal, openReplay, listRunning, onEvent, onResetTurn } = args

  let maxSeq = 0
  /** Set only by a genuinely settled turn — NOT by a `timeout` sentinel, which
   *  means "this follow window ended, the turn is still going". */
  let terminal: TurnStatusValue | null = null
  /** The last sentinel this window ended with, whatever it said. */
  let sentinel: TurnStatusValue | null = null
  /** Events forwarded since the cursor last advanced — see the reset below. */
  let emitted = 0

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // tolerate a torn line, same as the parse primitives
    }
    // `stampReplaySeq` (/stream) puts the buffer ordinal on the line; the
    // terminal sentinel is deliberately left unstamped, so it never moves the
    // cursor.
    const seq = typeof parsed.seq === 'number' && parsed.seq > 0 ? parsed.seq : undefined
    if (seq !== undefined && seq > maxSeq) maxSeq = seq

    const evt = (parsed.kind === 'event' ? parsed.event : parsed) as
      | Record<string, unknown>
      | undefined
    const type = typeof evt?.type === 'string' ? evt.type : ''

    if (type === 'turn_status') {
      // Loop control, not a transcript event. The status comes back on
      // `FollowTurnResult`; forwarding it would make every consumer filter it.
      // Only 'complete'/'error' settle the turn — 'timeout' is the route's
      // bounded follow window expiring on a turn that is STILL RUNNING, which
      // is precisely the case the reconnect loop below exists to handle.
      sentinel = statusFromSentinel(evt)
      if (sentinel === 'complete' || sentinel === 'error') terminal = sentinel
      return
    }
    if (type === 'session.run.completed') terminal = 'complete'
    else if (type === 'session.run.failed') terminal = 'error'

    emitted += 1
    onEvent({
      lane: 'durable',
      type,
      line,
      ...(seq !== undefined ? { seq } : {}),
      ...(evt?.data && typeof evt.data === 'object'
        ? { data: evt.data as Record<string, unknown> }
        : {}),
    })
  }

  while (!signal.aborted) {
    let opened: Response
    try {
      opened = await openReplay(turnId, maxSeq, signal)
    } catch {
      if (signal.aborted) break
      await sleep(args.reconnectDelayMs, signal)
      continue
    }
    if (signal.aborted) break
    if (!opened.ok || !opened.body) {
      // A replay that cannot be opened at all is not recoverable by retrying
      // the same cursor forever — report it and let the product surface it.
      return 'error'
    }

    try {
      await drainNdjsonLines(opened.body, handleLine)
    } catch {
      // Mid-drain transport failure: resume from the cursor rather than
      // restarting the turn. Everything already delivered stays on screen.
      if (signal.aborted) break
    }

    if (terminal) return terminal
    if (signal.aborted) break

    const running = await listRunning(signal).catch(() => null)
    if (signal.aborted) break
    // The server is the turn-boundary authority. Gone from `running` means the
    // turn ended; an 'unknown' sentinel means the store had no status row at
    // all, which is not the same thing as a clean completion.
    if (running && !running.includes(turnId)) return sentinel === 'unknown' ? 'unknown' : 'complete'

    // Still running: the route's bounded follow window ended. Reconnect from the
    // cursor. A cursor still at 0 after events were delivered means the server
    // is not stamping `seq` (a deployment predating `stampReplaySeq`), so the
    // next pass necessarily replays from the beginning — tell the consumer to
    // rebuild rather than let it double-render.
    if (maxSeq === 0 && emitted > 0) {
      onResetTurn?.('resume')
      emitted = 0
    }
    await sleep(args.reconnectDelayMs, signal)
  }

  return signal.aborted ? 'aborted' : (terminal ?? 'unknown')
}

/**
 * Route recovered events back into the existing `ChatStreamCallbacks`.
 *
 * Durable-lane events carry their raw NDJSON line, so they replay through
 * `dispatchChatStreamLine` unchanged — a product with no live lane adopts
 * `followTurn` without touching its reducer. Live-lane events carry raw sandbox
 * frames in a different vocabulary and are NOT dispatched here; a product that
 * wires a live lane owns that half.
 */
export function chatStreamLaneListener(
  cb: ChatStreamCallbacks,
): (event: RecoveredTurnEvent) => void {
  return (event) => {
    if (event.lane !== 'durable' || !event.line) return
    const result = dispatchChatStreamLine(event.line, cb)
    if (result.turnId) cb.onTurnId?.(result.turnId)
  }
}
