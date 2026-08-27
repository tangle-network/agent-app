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
 * (a durable driver re-invokes it after a crash; a turn that finished
 * server-side short-circuits instead of re-streaming). Products supply only the
 * domain seams: the raw sandbox event stream, the turn store, and the ids.
 *
 * This is app-shell mechanism (turn durability + live projection), not engine:
 * it owns no loop logic and imports no SDK — the event source is an injected
 * `AsyncIterable`.
 */

import { toChatMessageParts } from '../chat-store/parts'
import {
  coalesceDeltas,
  createBufferedTurnTap,
  type TurnEventStore,
} from '../stream/index'
import {
  assistantRowIdForTurn,
  createAssistantDraftWriter,
  storeSupportsDraftPersistence,
  type AssistantDraftStore,
  type AssistantDraftWriter,
  type AssistantRowValues,
  type DraftPersistenceTuning,
} from './draft-persistence'
import {
  createSandboxChatProducer,
  type SandboxChatProducerOptions,
} from './sandbox-producer'
import type { ChatTurnUsage } from './turn-routes'

/** The normalized structured message body (tool-call / file / plan / interaction
 *  parts) that `/chat-store` persists as the durable assistant row — the same
 *  shape `createSandboxChatProducer().assistantParts()` returns. */
export type DetachedTurnParts = Array<Record<string, unknown>>

/** Authoritative final receipt for a turn that finished server-side, or whose
 *  live stream carried no usage (some harness paths only expose tokens via the
 *  completed-turn record, e.g. `box.findCompletedTurn(turnId)`). */
export interface DetachedTurnFinal {
  text?: string
  usage?: ChatTurnUsage
  /** The structured parts to persist when this receipt IS the result (the
   *  cached / finished-server-side path). Omitted when the record only carries
   *  a usage receipt. */
  parts?: DetachedTurnParts
}

/** Define options for managing and projecting a detached turn event stream in a session */
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
  /** Which ask kinds the product renders a card for; anything else is
   *  auto-declined via {@link declineInteraction}. Forwarded to the producer. */
  isRenderableInteraction?: SandboxChatProducerOptions['isRenderableInteraction']
  /** Resolve a non-renderable ask so the run never hangs in the broker. An
   *  autonomous turn has NO human watching to answer an ask, so a caller that
   *  omits this risks the run blocking until the broker times out — wire it for
   *  any unattended run. Forwarded to the producer. */
  declineInteraction?: SandboxChatProducerOptions['declineInteraction']
  /** Opt-in eager promotion of harness-emitted `file` parts. Forwarded to the
   *  producer (see its docs). */
  promoteFilePart?: SandboxChatProducerOptions['promoteFilePart']
  /** Authoritative final receipt, consulted whenever a re-invoke finds a prior
   *  buffer: (a) an already-`complete` turn returns it as the cached result,
   *  (b) a `running` turn (crash mid-run) uses it to detect a run that finished
   *  server-side, and (c) a clean run whose stream carried no usage/text falls
   *  back to it. Typically `() => box.findCompletedTurn(turnId)`. */
  completedResult?: () => Promise<DetachedTurnFinal | null | undefined>
  /** Clear the prior partial buffer for `turnId` before a genuine re-stream.
   *  A crash mid-run leaves buffered rows at seqs 1..N with status `running`;
   *  re-streaming restarts the tap's seq at 0 and would duplicate/interleave
   *  rows. Wire this (delete `turnId`'s buffered events) so a retry is clean.
   *  Unset, a re-stream over a `running` buffer is still attempted but logged
   *  as a possible-duplication hazard. */
  resetBuffer?: (turnId: string) => Promise<void>
  /** Own the durable assistant row for this turn instead of returning the body
   *  for the caller to insert — and keep it in step with the stream.
   *
   *  An autonomous run is exactly the case a late viewer hits: nobody is
   *  watching when it starts, so by the time a browser opens the session the
   *  streaming gateway's hot event buffer may already have expired it. Keeping
   *  that buffer short is what makes it affordable at scale (its Redis
   *  footprint is linear in `ttl x concurrent sessions`), so the durable row —
   *  written incrementally here — is what serves the late viewer.
   *
   *  WIRING THIS TRANSFERS ROW OWNERSHIP: the returned {@link
   *  DetachedTurnResult.messageId} names the row this call wrote (draft rows
   *  during the stream, authoritative values at the end, retraction when the
   *  turn produced nothing). The caller must NOT insert its own assistant row
   *  for the turn. Omit the seam and nothing changes — the result is returned
   *  and the caller persists it exactly as today.
   *
   *  Idempotency reuses the turn's own identity: the row id defaults to
   *  `assistant:<turnId>`, so a durable driver re-invoking after a crash
   *  patches the same row instead of duplicating parts. */
  persist?: DraftPersistenceTuning & {
    store: AssistantDraftStore
    threadId: string
    /** Deterministic row id. Default `assistant:<turnId>`. */
    messageId?: string
    /** Pre-persist text transform (`/redact`), applied to drafts AND the final
     *  write — parity with the interactive lane's `transformFinalText`. */
    transformText?: (text: string) => string | Promise<string>
  }
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** Describe the result of a detached turn including state, text, parts, usage, and optional error or cache flag */
export interface DetachedTurnResult {
  /** `completed` — clean drain: persist + bill. `failed` — a terminal error
   *  event, including the producer's structured `sandbox.stream_failed` event
   *  when the raw sandbox stream throws: skip billing, render an error row. */
  state: 'completed' | 'failed'
  text: string
  /** The structured assistant body to persist (tool calls, file/plan/interaction
   *  parts). Empty array when the run produced none. */
  parts: DetachedTurnParts
  usage: ChatTurnUsage
  /** Present when `state === 'failed'`. */
  error?: string
  /** True when a prior buffer meant this call returned a cached/finished result
   *  WITHOUT re-streaming (durable-driver retry after a crash). */
  cached: boolean
  /** The durable assistant row this call wrote, when `persist` was wired.
   *  `null` when the turn produced nothing and the row was retracted. Absent
   *  when the caller owns persistence (today's behavior). */
  messageId?: string | null
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

function cachedResultFrom(final: DetachedTurnFinal | null): DetachedTurnResult {
  return {
    state: 'completed',
    text: final?.text ?? '',
    parts: final?.parts ?? [],
    usage: final?.usage ?? {},
    cached: true,
  }
}

/**
 * Stream a detached turn into the live turn-event buffer, durably.
 *
 * - Idempotent: an already-`complete` turn returns the cached result without
 *   re-streaming (a second event sequence would collide with the buffered one).
 * - Crash-safe: a `running` turn (a prior attempt crashed mid-tap) consults
 *   `completedResult` to detect a run that finished server-side; only a run that
 *   genuinely did not complete is re-streamed, and then over a `resetBuffer`-
 *   cleared buffer so seqs don't corrupt.
 * - Marks the turn `running` under `scopeId` so a mid-run browser finds it.
 * - Settles `complete`/`error` so the client stops tailing and billing/render
 *   can branch on `state`.
 */
export async function runDetachedTurn(opts: DetachedTurnOptions): Promise<DetachedTurnResult> {
  const { store, turnId, scopeId } = opts

  // Hoisted so the draft writer's snapshot can read the producer's live
  // accumulators; assigned once the idempotency branches decide to re-stream.
  let producer: ReturnType<typeof createSandboxChatProducer> | undefined

  // Durable row ownership (opt-in). Built before the idempotency branches so a
  // cached/finished-server-side re-invoke still converges the row instead of
  // leaving whatever partial state a crashed attempt wrote.
  let draft: AssistantDraftWriter | undefined
  if (opts.persist) {
    const { store: persistStore, threadId, messageId, transformText, ...tuning } = opts.persist
    if (!storeSupportsDraftPersistence(persistStore)) {
      throw new Error(
        'runDetachedTurn persist requires a store with updateMessage() — `/chat-store`\'s createChatStore has it',
      )
    }
    draft = createAssistantDraftWriter({
      ...tuning,
      store: persistStore,
      threadId,
      messageId: messageId ?? assistantRowIdForTurn(turnId),
      snapshot: () => (producer
        ? {
            content: producer.finalText?.() ?? '',
            ...(producer.draftParts ? { parts: producer.draftParts() } : {}),
            ...(producer.usage ? { usage: producer.usage() } : {}),
            ...(opts.model ? { model: opts.model } : {}),
          }
        : null),
      ...(transformText ? { transformText } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    })
  }

  /** Settle the durable row with authoritative values (or retract it when the
   *  turn produced nothing), and stamp the id onto the result. */
  const settleRow = async (result: DetachedTurnResult): Promise<DetachedTurnResult> => {
    if (!draft) return result
    const transform = opts.persist?.transformText
    const content = transform ? await transform(result.text) : result.text
    const rawParts = transform
      ? await Promise.all(
          result.parts.map(async (part) =>
            String((part as { type?: unknown }).type ?? '') === 'text'
              ? { ...part, text: await transform(String((part as { text?: unknown }).text ?? '')) }
              : part,
          ),
        )
      : result.parts
    const parts = toChatMessageParts(rawParts)
    if (!content.trim() && parts.length === 0) {
      await draft.discard()
      return { ...result, messageId: null }
    }
    const values: AssistantRowValues = {
      content,
      ...(parts.length > 0 ? { parts } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(result.usage.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
      ...(result.usage.reasoningTokens !== undefined ? { reasoningTokens: result.usage.reasoningTokens } : {}),
      ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
      ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
      ...(result.usage.costUsd !== undefined ? { costUsd: result.usage.costUsd } : {}),
    }
    await draft.finalize(values)
    return { ...result, messageId: draft.rowId() ?? null }
  }

  const completed = async (): Promise<DetachedTurnFinal | null> => {
    if (!opts.completedResult) return null
    try {
      return (await opts.completedResult()) ?? null
    } catch (err) {
      opts.log?.('[chat-routes] runDetachedTurn completedResult lookup failed', { turnId, err: String(err) })
      return null
    }
  }

  let prior: string | null = null
  try {
    prior = await store.getStatus(turnId)
  } catch (err) {
    // A transient store blip must NOT silently fall through to a full re-stream
    // (which would duplicate a completed turn's buffer) — surface it.
    opts.log?.('[chat-routes] runDetachedTurn getStatus failed; treating as no prior', { turnId, err: String(err) })
  }

  if (prior === 'complete') return await settleRow(cachedResultFrom(await completed()))

  if (prior === 'running') {
    // A prior attempt marked the turn running and then this worker crashed. The
    // detached SESSION may have finished server-side while we were gone — the
    // authoritative check is `completedResult` (findCompletedTurn). If it
    // completed, settle the stuck `running` buffer and return it.
    const final = await completed()
    if (final) {
      await store.setStatus(turnId, 'complete', scopeId).catch((err) => {
        opts.log?.('[chat-routes] runDetachedTurn failed to settle a completed running turn', { turnId, err: String(err) })
      })
      return await settleRow(cachedResultFrom(final))
    }
    // Genuine re-run: clear the partial buffer first, or the fresh tap's seq
    // (restarting at 0) interleaves with the orphaned rows.
    if (opts.resetBuffer) {
      await opts.resetBuffer(turnId).catch((err) => {
        opts.log?.('[chat-routes] runDetachedTurn resetBuffer failed; re-stream may duplicate rows', { turnId, err: String(err) })
      })
    } else {
      opts.log?.('[chat-routes] runDetachedTurn re-streaming over a running buffer without resetBuffer; rows may duplicate', { turnId })
    }
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

  producer = createSandboxChatProducer({
    events: opts.events,
    model: opts.model,
    isRenderableInteraction: opts.isRenderableInteraction,
    declineInteraction: opts.declineInteraction,
    promoteFilePart: opts.promoteFilePart,
    log: opts.log,
  })

  let runError: string | undefined
  try {
    for await (const ev of producer.stream) {
      const type = (ev as { type?: unknown }).type
      if (typeof type === 'string' && TERMINAL_ERROR_TYPES.has(type)) runError = errorMessageOf(ev)
      await tap.onEvent(ev)
      // Same coalesced cadence the interactive lane uses: the durable row
      // tracks the run so a viewer arriving after the hot buffer's short window
      // reads it from storage.
      draft?.notify(ev as { type?: unknown })
    }
    await tap.done(runError ? 'error' : 'complete')
  } catch (err) {
    await tap.done('error').catch(() => {})
    // Settle any in-flight draft before propagating so the partial row a
    // re-invoke will adopt is a complete write, not a half-landed one.
    await draft?.close().catch(() => {})
    throw err
  }

  const text = producer.finalText?.() ?? ''
  const parts = producer.assistantParts?.() ?? []
  let usage: ChatTurnUsage = producer.usage?.() ?? {}

  if (!runError && !hasUsage(usage)) {
    const final = await completed()
    if (final?.usage) usage = { ...usage, ...final.usage }
    if (!text && final?.text) {
      return await settleRow({ state: 'completed', text: final.text, parts: final.parts ?? parts, usage, cached: false })
    }
  }

  if (runError) return await settleRow({ state: 'failed', text, parts, usage, error: runError, cached: false })
  return await settleRow({ state: 'completed', text, parts, usage, cached: false })
}
