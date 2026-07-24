/**
 * Detached (autonomous) turn → live buffer bridge.
 *
 * The interactive lane (`createChatTurnRoutes`) already streams a user-typed
 * turn to the browser while it runs. An AUTONOMOUS turn — a mission step, a
 * queue job, an inbound-email review — runs detached (`dispatchPrompt`/
 * `streamPrompt` server-side so it survives no one watching) and, historically,
 * only persisted its FINAL message. A browser opening the session mid-run saw a
 * dead screen: the live tokens existed server-side but were never written to
 * the turn-event buffer the client re-attach path (`listRunning` + `/replay`)
 * reads.
 *
 * `runDetachedTurn` is that missing bridge, packaged. It taps the same buffer
 * the interactive lane uses (`createBufferedTurnTap`) with the same producer
 * mapping (`createSandboxChatProducer`), so an autonomous run is watchable
 * token-by-token exactly like an interactive one — while staying durable
 * (a durable driver re-invokes it after a crash; a completed turn short-circuits
 * instead of re-streaming). Products supply only the domain seams: the raw
 * sandbox event stream, the turn store, and the ids.
 *
 * This is app-shell mechanism (turn durability + live projection), not engine:
 * it owns no loop logic and imports no SDK — the event source is an injected
 * `AsyncIterable`.
 */

import {
  coalesceDeltas,
  createBufferedTurnTap,
  type TurnEventStore,
} from '../stream/index'
import { createSandboxChatProducer } from './sandbox-producer'
import type { ChatTurnUsage } from './turn-routes'

/** Authoritative final receipt for a turn whose live stream carried no usage
 *  (some harness paths only expose tokens via the completed-turn record, e.g.
 *  `box.findCompletedTurn(turnId)`). */
export interface DetachedTurnFinal {
  text?: string
  usage?: ChatTurnUsage
}

export interface DetachedTurnOptions {
  store: TurnEventStore
  turnId: string
  /** Thread/session id — recorded as the buffer scope so a browser opening the
   *  session mid-run rediscovers this turn via `listRunning(scopeId)` after it
   *  has lost the turnId. */
  scopeId: string
  /** The raw sandbox event stream for this turn (e.g. `streamSandboxPrompt`).
   *  Ownership of the box, prompt, tooling, and attachments stays with the
   *  caller — this only projects the stream. */
  events: AsyncIterable<unknown>
  /** Recorded on the persisted assistant message + usage receipt. */
  model?: string
  /** Per-flush buffer coalescer. Default `coalesceDeltas`. */
  coalesce?: (events: unknown[]) => unknown[]
  /** Authoritative final receipt, consulted twice: (a) as the cached result
   *  when the turn already completed (idempotent re-invoke), and (b) as a
   *  fallback when a clean run's stream carried no usage/text. */
  completedResult?: () => Promise<DetachedTurnFinal | null | undefined>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface DetachedTurnResult {
  /** `completed` — clean drain: persist + bill. `failed` — a terminal error
   *  event or a thrown stream: skip billing, render an error row. */
  state: 'completed' | 'failed'
  text: string
  usage: ChatTurnUsage
  /** Present when `state === 'failed'`. */
  error?: string
  /** True when the turn had already completed and this call returned the cached
   *  result WITHOUT re-streaming (durable-driver retry after a crash). */
  cached: boolean
}

/** Terminal failure event types a producer may forward verbatim. */
const TERMINAL_ERROR_TYPES = new Set(['error', 'session.run.failed'])

function errorMessageOf(ev: unknown): string {
  const rec = ev as { data?: { message?: unknown; reason?: unknown }; message?: unknown } | null
  const raw = rec?.data?.message ?? rec?.data?.reason ?? rec?.message
  return typeof raw === 'string' && raw ? raw : 'run failed'
}

function hasUsage(usage: ChatTurnUsage): boolean {
  return typeof usage.inputTokens === 'number' && usage.inputTokens > 0
}

/**
 * Stream a detached turn into the live turn-event buffer, durably.
 *
 * - Idempotent: an already-`complete` turn returns the cached result without
 *   re-streaming (a second event sequence would collide with the buffered one).
 * - Marks the turn `running` under `scopeId` so a mid-run browser finds it.
 * - Settles `complete`/`error` so the client stops tailing and billing/render
 *   can branch on `state`.
 */
export async function runDetachedTurn(opts: DetachedTurnOptions): Promise<DetachedTurnResult> {
  const { store, turnId, scopeId } = opts

  const prior = await store.getStatus(turnId).catch(() => null)
  if (prior === 'complete') {
    const final = opts.completedResult ? await opts.completedResult().catch(() => null) : null
    return { state: 'completed', text: final?.text ?? '', usage: final?.usage ?? {}, cached: true }
  }

  const tap = createBufferedTurnTap({
    store,
    turnId,
    scopeId,
    coalesce: opts.coalesce ?? coalesceDeltas,
  })
  // Leading turn marker: flips the buffer to `running` (so `listRunning` finds
  // it) and is the browser's `/replay` resume handle.
  await tap.onEvent({ type: 'turn', turnId })

  const producer = createSandboxChatProducer({
    events: opts.events,
    model: opts.model,
    log: opts.log,
  })

  let runError: string | undefined
  try {
    for await (const ev of producer.stream) {
      const type = (ev as { type?: unknown }).type
      if (typeof type === 'string' && TERMINAL_ERROR_TYPES.has(type)) runError = errorMessageOf(ev)
      await tap.onEvent(ev)
    }
    await tap.done(runError ? 'error' : 'complete')
  } catch (err) {
    await tap.done('error').catch(() => {})
    throw err
  }

  const text = producer.finalText?.() ?? ''
  let usage: ChatTurnUsage = producer.usage?.() ?? {}

  if (!runError && !hasUsage(usage)) {
    const final = opts.completedResult ? await opts.completedResult().catch(() => null) : null
    if (final?.usage) usage = { ...usage, ...final.usage }
    if (!text && final?.text) return { state: 'completed', text: final.text, usage, cached: false }
  }

  if (runError) return { state: 'failed', text, usage, error: runError, cached: false }
  return { state: 'completed', text, usage, cached: false }
}
