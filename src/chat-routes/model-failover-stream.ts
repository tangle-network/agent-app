/**
 * Model failover for a STREAMING turn.
 *
 * `/model-resolution`'s `runWithModelFailover` already owns the policy: walk a
 * chain, classify a resolved-or-thrown signal, re-throw a non-outage failure
 * immediately, and carry the attempt trail. This module does NOT re-implement
 * any of that — it composes it. What it adds is the one thing a whole-call
 * primitive cannot express, because a stream fails PARTWAY:
 *
 *   **A turn may only fail over before its first client-visible byte.**
 *
 * Once a text delta, tool call, or ask has reached the browser (and the
 * persisted transcript), restarting on another model would duplicate the
 * answer. So each attempt is probed: open the stream, pull events into a small
 * buffer, and decide at the first meaningful event whether this model is
 * serving. Committing replays the buffer and hands the live iterator through;
 * abandoning discards the buffer (those events describe the dead model's
 * session — including its `step-finish` usage, which must never be billed) and
 * lets `runWithModelFailover` walk to the next model.
 *
 * The classification itself is `isUpstreamUnavailable` verbatim, so this path
 * inherits the measured facts from the 2026-07-25 outage — above all that an
 * outage is NOT always a thrown error: the sandbox RESOLVES a terminal `error`
 * event carrying `{ errorCode: 'provider_inference_unavailable' }`, which a
 * classifier inspecting only `catch` misses entirely. That resolved shape is
 * the whole reason the breakage went unnoticed, so it is classified here first.
 *
 * Conservative by construction:
 * - A terminal failure that is NOT an outage (400, bad schema, content filter)
 *   COMMITS rather than failing over — it surfaces to the user exactly as it
 *   does today. Those fail identically on every model; walking the chain would
 *   only multiply latency and spend to reach the same error.
 * - A clean stream that simply produced nothing is NOT retried. An empty answer
 *   is not evidence of a dead upstream, and a silent re-roll on another model is
 *   precisely the unattributable downgrade this work exists to prevent.
 * - A chain of length 1 costs nothing: one attempt, no extra call, no added
 *   latency, byte-identical to no failover at all.
 */

import {
  isUpstreamUnavailable,
  runWithModelFailover,
  type ModelFailoverAttempt,
} from '../model-resolution/failover'
import { asRecord, asString } from '../stream/index'

/** Terminal event types that end an attempt with a failure verdict. */
const TERMINAL_FAILURE_TYPES = new Set(['error', 'session.run.failed'])

/**
 * Part types that carry no transcript content. They are buffered like anything
 * else — replayed verbatim when the attempt commits — but their presence alone
 * never commits a model, so an outage arriving right after a `step-start` is
 * still recoverable. `step-finish` matters most: it carries the abandoned
 * attempt's token/cost receipt, which must be discarded rather than billed.
 */
const NON_COMMITTING_PART_TYPES = new Set(['step-start', 'step-finish'])

/**
 * True when `event` puts content in front of the user (or in the persisted
 * transcript), making a restart on another model unsafe.
 *
 * Deliberately an allow-list of KNOWN-INERT types rather than a deny-list: an
 * unrecognized event commits. Getting this wrong in the safe direction costs a
 * missed failover; getting it wrong the other way duplicates a user's answer.
 */
export function isCommittingSandboxEvent(event: unknown): boolean {
  const record = asRecord(event)
  if (!record) return false
  const type = asString(record.type) ?? ''
  if (!type) return false

  if (type === 'message.part.updated') {
    const part = asRecord(asRecord(record.data)?.part)
    const partType = asString(part?.type) ?? ''
    if (NON_COMMITTING_PART_TYPES.has(partType)) return false
    // A text/reasoning part with NO content yet (the platform opens the part
    // with `text: ""` before the first token — verbatim in the 2026-07-26
    // capture) puts nothing in front of the user; discarding it cannot
    // duplicate an answer. The first real token commits.
    if (partType === 'text' || partType === 'reasoning') {
      const text = asString(part?.text) ?? asString(part?.content) ?? ''
      return text.length > 0
    }
    return true
  }

  // Session/turn lifecycle, progress status, and warnings belong to the
  // attempt, not the transcript — discardable with an abandoned model. Every
  // entry here was OBSERVED on a real box (2026-07-26 capture: a dead model
  // emits `start`, `execution.started`, `status`×3, `session.updated`×2,
  // `warning`×2 BEFORE its terminal `error` — any one of them committing
  // would pin the turn to the dead model and kill the failover).
  if (
    type === 'start' ||
    type === 'execution.started' ||
    type === 'status' ||
    type === 'model-processing' ||
    type === 'session.created' ||
    type === 'session.updated' ||
    type === 'session.idle' ||
    type === 'step-start' ||
    type === 'step-finish' ||
    type === 'turn' ||
    type === 'warning'
  ) {
    return false
  }

  // Everything else — text/tool shapes the producer folds, asks, plans,
  // `result`/`done`, and any type this shell does not recognize — commits.
  return true
}

/** A terminal failure event, classified. `outage` decides failover vs surface. */
interface TerminalFailure {
  outage: boolean
  reason: string
  code?: string
}

/**
 * Classify a terminal failure event. Returns `null` for any non-terminal event.
 *
 * The RESOLVED shape is checked first and deliberately: the sandbox reports an
 * upstream outage by resolving `{ success: false, errorCode:
 * 'provider_inference_unavailable' }` inside a terminal `error` event's `data`,
 * never by throwing. Both `data` and the whole record are offered to
 * `isUpstreamUnavailable` so a payload nested either way is caught.
 */
export function classifyTerminalFailure(event: unknown): TerminalFailure | null {
  const record = asRecord(event)
  if (!record) return null
  const type = asString(record.type) ?? ''
  if (!TERMINAL_FAILURE_TYPES.has(type)) return null

  const data = asRecord(record.data)
  const outage = isUpstreamUnavailable(data) || isUpstreamUnavailable(record)
  const reason =
    asString(data?.message) ??
    asString(data?.error) ??
    asString(data?.reason) ??
    asString(record.message) ??
    `sandbox stream reported ${type}`
  const code = asString(data?.errorCode) ?? asString(data?.code)
  return { outage, reason, ...(code ? { code } : {}) }
}

/** A model that served: its buffered preamble plus the still-live iterator. */
interface AttemptCommit {
  committed: true
  buffered: unknown[]
  /** `null` when the stream already ended during the probe. */
  iterator: AsyncIterator<unknown> | null
}

/**
 * A model whose upstream is down. `error`/`errorCode` are read by
 * `runWithModelFailover`'s attempt-trail describe(), so the trail names the
 * real upstream cause rather than a wrapper's own words.
 */
interface AttemptOutage {
  committed: false
  error: string
  errorCode?: string
}

type AttemptOutcome = AttemptCommit | AttemptOutage

/** Open the raw turn stream for one specific model. */
export type OpenModelStream = (args: {
  model: string
  /** 1 for the preferred model, 2 for the first fallback, and so on. */
  attempt: number
}) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>

/** Fired when a model is abandoned and the next one is about to be tried. */
export interface ModelFallbackInfo {
  from: string
  to: string
  reason: string
}

/** Define inputs for streaming a turn across a model failover chain */
export interface ModelFailoverStreamOptions {
  /** Preferred model first, then fallbacks in descending preference. */
  models: readonly string[]
  open: OpenModelStream
  /** Override the commit-point rule. Default {@link isCommittingSandboxEvent}. */
  isCommitting?: (event: unknown) => boolean
  onFallback?: (info: ModelFallbackInfo) => void
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** The failover-wrapped stream plus the attribution every consumer needs. */
export interface ModelFailoverStreamHandle {
  events: AsyncGenerator<unknown, void, unknown>
  /** The model that actually served. `undefined` until the first pull resolves it. */
  servingModel(): string | undefined
  /** Every model tried, in order, with the reason each was abandoned. */
  attempts(): ModelFailoverAttempt[]
  /** True when the preferred model did not serve — the attributability signal. */
  usedFallback(): boolean
}

/** Abandon a dead attempt's iterator. Never allowed to mask the outage. */
async function closeIterator(iterator: AsyncIterator<unknown>, log?: ModelFailoverStreamOptions['log']): Promise<void> {
  try {
    await iterator.return?.()
  } catch (err) {
    log?.('[chat-routes] abandoning a failed model stream threw', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Wrap `open` in reactive model failover, streaming from the first model in
 * `models` that reaches its commit point.
 *
 * Zero added latency on the happy path: the preferred model is opened first and,
 * the moment it emits anything meaningful, its events flow straight through.
 *
 * @throws ModelFailoverExhaustedError when every model's upstream is down, and
 *         re-throws a non-outage error from the FIRST model without walking the
 *         chain (both behaviors inherited from `runWithModelFailover`).
 */
export function streamWithModelFailover(
  options: ModelFailoverStreamOptions,
): ModelFailoverStreamHandle {
  const committing = options.isCommitting ?? isCommittingSandboxEvent
  let serving: string | undefined
  let trail: ModelFailoverAttempt[] = []
  let fellBack = false
  let attemptIndex = 0

  const probe = async (model: string): Promise<AttemptOutcome> => {
    attemptIndex += 1
    const source = await options.open({ model, attempt: attemptIndex })
    const iterator = source[Symbol.asyncIterator]()
    const buffered: unknown[] = []

    for (;;) {
      // A THROWN failure propagates untouched: `runWithModelFailover` classifies
      // it (outage → next model, anything else → re-thrown to the caller).
      const next = await iterator.next()
      if (next.done) {
        // Clean end. Nothing to fail over to — an empty answer is not an outage.
        return { committed: true, buffered, iterator: null }
      }

      const event = next.value
      const failure = classifyTerminalFailure(event)
      if (failure?.outage) {
        await closeIterator(iterator, options.log)
        return {
          committed: false,
          error: failure.reason,
          ...(failure.code ? { errorCode: failure.code } : {}),
        }
      }

      buffered.push(event)
      // A terminal NON-outage failure surfaces exactly as it does today.
      if (failure) return { committed: true, buffered, iterator }
      if (committing(event)) return { committed: true, buffered, iterator }
    }
  }

  const events = (async function* (): AsyncGenerator<unknown, void, unknown> {
    let handle: AttemptCommit
    try {
      const outcome = await runWithModelFailover<AttemptOutcome>({
        models: options.models,
        run: probe,
        // The probe has already classified the raw payload with
        // `isUpstreamUnavailable`; this reads its verdict rather than
        // re-classifying a wrapper object, so the two can never disagree.
        isUnavailableResult: (result) => result.committed === false,
        onFallback: (attempt, nextModel) => {
          const info: ModelFallbackInfo = {
            from: attempt.model,
            to: nextModel,
            reason: attempt.reason ?? 'upstream unavailable',
          }
          options.log?.('[chat-routes] model upstream unavailable; falling over', { ...info })
          options.onFallback?.(info)
        },
      })
      serving = outcome.model
      trail = outcome.attempts
      fellBack = outcome.usedFallback
      handle = outcome.value as AttemptCommit
    } catch (err) {
      // Exhaustion carries the full trail; keep it so the receipt still names
      // every model tried even though the turn produced nothing.
      const attempts = (err as { attempts?: ModelFailoverAttempt[] })?.attempts
      if (Array.isArray(attempts)) trail = attempts
      throw err
    }

    for (const event of handle.buffered) yield event

    const live = handle.iterator
    if (!live) return
    try {
      for (;;) {
        const next = await live.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      // The consumer may abandon this generator mid-turn (client drop); close
      // the underlying stream rather than leaking it.
      await closeIterator(live, options.log)
    }
  })()

  return {
    events,
    servingModel: () => serving,
    attempts: () => trail,
    usedFallback: () => fellBack,
  }
}
