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
 * - A clean stream that produced nothing NEVER walks the chain. An empty answer
 *   is not evidence of a dead upstream, and a silent re-roll on another model is
 *   precisely the unattributable downgrade this work exists to prevent. Opt-in
 *   `emptyTurnRetries` re-runs the SAME model instead, which leaves attribution
 *   untouched — measured on production 2026-07-27, an empty turn is a transient
 *   platform flake that a same-model re-run recovers (8 hard cases: 7/8
 *   delivered on the first pass, 8/8 with one re-run, at a cost of 1 extra turn
 *   in 9). Default `0`, so the behavior is unchanged unless a product asks.
 * - A responsive chain of length 1 costs no extra call or latency and remains
 *   byte-identical to no failover. A silent chain is now deliberately bounded.
 */

import {
  isUpstreamUnavailable,
  ModelFailoverExhaustedError,
  readHttpStatusHint,
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
    type === 'model.processing' ||
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

/**
 * Condense an abandoned attempt's raw failure text into something safe to show
 * a customer in the transcript.
 *
 * Measured on the live router 2026-07-27 19:40 UTC: an edge 5xx arrives as
 * Cloudflare's full HTML error PAGE, so the verbatim reason began
 * `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie"…` and the
 * fallback notice pasted 200 bytes of that markup into the answer the customer
 * reads. The cause is worth stating; the markup is not.
 *
 * Only the DISPLAY string is condensed. The full text stays on
 * `modelFailover.attempts[].reason` for the operator, so nothing is lost —
 * this narrows what the customer sees, never what telemetry records.
 */
export function summarizeFailoverReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'upstream unavailable'

  // An HTML error page carries no message worth quoting — the status is the
  // whole content. Detected on the ORIGINAL text, before collapsing, because
  // that is the form the producer hands over.
  if (/<!doctype html|<html[\s>]/i.test(collapsed)) {
    const status = readHttpStatusHint(collapsed)
    return status ? `HTTP ${status}` : 'upstream returned an error page'
  }

  // Anything else is a real message. Cap it so a verbose upstream cannot push
  // the answer off the screen, and cut on a word boundary when one is near.
  const LIMIT = 160
  if (collapsed.length <= LIMIT) return collapsed
  const clipped = collapsed.slice(0, LIMIT)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > LIMIT - 30 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
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
  /** Cancel transport work when this attempt is drained or abandoned. */
  abort: () => void
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
  timeoutCode?: ModelAttemptTimeoutCode
}

type AttemptOutcome = AttemptCommit | AttemptOutage

/** Open the raw turn stream for one specific model. */
export type OpenModelStream = (args: {
  model: string
  /** 1 for the preferred model, 2 for the first fallback, and so on. */
  attempt: number
  /** Aborted when this attempt times out, is abandoned, or finishes. Forward
   *  this to `streamSandboxPrompt(..., { signal })` so a blocked transport is
   *  cancelled immediately rather than only receiving iterator.return(). */
  signal: AbortSignal
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
  /**
   * Maximum time to open/start one model's event source, including its first
   * iterator pull. Default 120 seconds, matching the sandbox provisioning
   * ceiling so cold infrastructure startup is bounded independently from
   * provider inference.
   */
  openTimeoutMs?: number
  /**
   * Hard deadline from the source's first lifecycle event to its first
   * answer-bearing event. Default 60 seconds. Processing/lifecycle events do
   * not commit the attempt and do not extend this deadline.
   */
  firstResponseTimeoutMs?: number
  /** Override the commit-point rule. Default {@link isCommittingSandboxEvent}. */
  isCommitting?: (event: unknown) => boolean
  onFallback?: (info: ModelFallbackInfo) => void
  /**
   * How many times to RE-RUN THE SAME MODEL when a turn completes having
   * produced no assistant text at all. Default `0` — byte-identical to no
   * retry.
   *
   * This is deliberately not a chain walk. Falling over to a different model
   * on an empty answer is the unattributable downgrade this module refuses to
   * do; re-running the SAME model changes nothing about attribution, because
   * the model that serves is the model that was asked for.
   *
   * Bounded by the same commit rule as failover: only a turn whose ONLY
   * committing event is a terminal receipt with no text is retried, so nothing
   * that reached the user can ever be produced twice.
   */
  emptyTurnRetries?: number
  /** Fired when an empty turn is discarded and the same model re-run. */
  onEmptyTurnRetry?: (info: EmptyTurnRetryInfo) => void
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** One same-model re-run of a turn that completed with no assistant text. */
export interface EmptyTurnRetryInfo {
  model: string
  /** 1 for the first re-run. */
  retry: number
  /** How many re-runs remain after this one. */
  remaining: number
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

/** Default ceiling for opening/starting one source through its first event. */
export const DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS = 120_000

/** Default ceiling for the first answer-bearing event after the source's first event. */
export const DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = 60_000

/** Structured timeout codes surfaced by the producer on final exhaustion. */
export type ModelAttemptTimeoutCode =
  | 'model_stream_open_timeout'
  | 'provider_first_response_timeout'

/** Every configured model was exhausted and the final one timed out. */
export class ModelFailoverTimeoutError extends ModelFailoverExhaustedError {
  readonly code: ModelAttemptTimeoutCode
  readonly model: string
  readonly timeoutMs: number

  constructor(input: {
    attempts: ModelFailoverAttempt[]
    code: ModelAttemptTimeoutCode
    model: string
    timeoutMs: number
  }) {
    super(input.attempts)
    this.name = 'ModelFailoverTimeoutError'
    this.code = input.code
    this.model = input.model
    this.timeoutMs = input.timeoutMs
    this.message = input.code === 'model_stream_open_timeout'
      ? `Opening the model event source for ${input.model} exceeded ${input.timeoutMs}ms.`
      : `Model ${input.model} produced no first answer-bearing event within ${input.timeoutMs}ms.`
  }
}

function resolveTimeoutMs(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than 0`)
  }
  return Math.max(1, Math.trunc(value))
}

const TIMED_OUT = Symbol('model-attempt-timed-out')

function deadlineAfter(timeoutMs: number): {
  promise: Promise<typeof TIMED_OUT>
  clear: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  return {
    promise,
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

/**
 * True when `event` is a terminal receipt (`result` / `done`) carrying no
 * assistant text.
 *
 * Measured on production `sandbox.tangle.tools` (2026-07-27, 28 turns through
 * the gtm-agent profile): a turn can end `{ outcome: { type: 'completed' } }`
 * with `finalText: ''` and zero token events — the platform reports success and
 * the customer's message is blank. It is not an outage, nothing throws, and
 * `isUpstreamUnavailable` correctly declines to classify it, so before this the
 * blank answer committed and shipped.
 */
function isEmptyTerminalReceipt(event: unknown): boolean {
  const record = asRecord(event)
  if (!record) return false
  const type = asString(record.type) ?? ''
  if (type !== 'result' && type !== 'done') return false
  const data = asRecord(record.data)
  const text = asString(data?.finalText) ?? asString(data?.text) ?? ''
  return text.trim().length === 0
}

/**
 * Hard ceiling on same-model re-runs. A turn that comes back blank three times
 * running is not a flake this can retry away, and each pass costs a full
 * sandbox turn — so the budget is capped rather than trusted.
 */
export const MAX_EMPTY_TURN_RETRIES = 3

/**
 * Coerce the caller's budget to a finite, bounded, non-negative integer.
 *
 * `Math.trunc(NaN)` is `NaN` and `retry >= NaN` is false for every `retry`, so
 * a naive clamp turns a bad config value into a loop that opens sandbox streams
 * until the worker dies. `Infinity` has the same shape. Both resolve to `0` —
 * an unusable budget disables the retry rather than running unbounded.
 */
export function resolveEmptyTurnRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const truncated = Math.trunc(value)
  if (truncated <= 0) return 0
  return Math.min(truncated, MAX_EMPTY_TURN_RETRIES)
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
 * @throws ModelFailoverTimeoutError when the final model times out,
 *         ModelFailoverExhaustedError when every model's upstream is down, and
 *         re-throws a non-outage error from the FIRST model without walking the
 *         chain (the latter behaviors are inherited from
 *         `runWithModelFailover`).
 */
export function streamWithModelFailover(
  options: ModelFailoverStreamOptions,
): ModelFailoverStreamHandle {
  const committing = options.isCommitting ?? isCommittingSandboxEvent
  const emptyTurnRetries = resolveEmptyTurnRetries(options.emptyTurnRetries)
  const openTimeoutMs = resolveTimeoutMs(
    options.openTimeoutMs,
    DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS,
    'openTimeoutMs',
  )
  const firstResponseTimeoutMs = resolveTimeoutMs(
    options.firstResponseTimeoutMs,
    DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
    'firstResponseTimeoutMs',
  )
  let serving: string | undefined
  let trail: ModelFailoverAttempt[] = []
  let fellBack = false
  let attemptIndex = 0
  let finalTimeout: {
    code: ModelAttemptTimeoutCode
    model: string
    timeoutMs: number
  } | undefined

  /**
   * One open-and-drain pass. `empty` marks the pass as an EMPTY TURN — the
   * only committing event was a terminal receipt with no assistant text, so
   * nothing reached the user and the pass can be discarded without any risk of
   * producing an answer twice. It still carries the outcome it would otherwise
   * have returned, so exhausting the retry budget is byte-identical to no
   * retry at all.
   */
  const drainOnce = async (model: string): Promise<{ outcome: AttemptOutcome; empty: boolean }> => {
    attemptIndex += 1
    const controller = new AbortController()
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort()
    }
    const opening = Promise.resolve().then(() => options.open({
      model,
      attempt: attemptIndex,
      signal: controller.signal,
    }))
    const openDeadline = deadlineAfter(openTimeoutMs)
    let opened: AsyncIterable<unknown> | typeof TIMED_OUT
    try {
      opened = await Promise.race([opening, openDeadline.promise])
    } catch (err) {
      openDeadline.clear()
      abort()
      throw err
    }
    if (opened === TIMED_OUT) {
      openDeadline.clear()
      abort()
      // A Promise cannot be forcibly cancelled. If the abandoned open settles
      // later, close its iterator immediately so it cannot leak a connection.
      void opening.then(
        (lateSource) => {
          try {
            void closeIterator(lateSource[Symbol.asyncIterator](), options.log)
          } catch (err) {
            options.log?.('[chat-routes] closing a late model stream threw', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        },
        (err) => {
          options.log?.('[chat-routes] abandoned model stream open rejected after timeout', {
            error: err instanceof Error ? err.message : String(err),
          })
        },
      )
      return {
        outcome: {
          committed: false,
          error: `Opening the model event source for ${model} exceeded ${openTimeoutMs}ms`,
          errorCode: 'model_stream_open_timeout',
          timeoutCode: 'model_stream_open_timeout',
        },
        empty: false,
      }
    }

    const source = opened
    let iterator: AsyncIterator<unknown>
    try {
      iterator = source[Symbol.asyncIterator]()
    } catch (err) {
      openDeadline.clear()
      abort()
      throw err
    }
    const buffered: unknown[] = []
    // Starting the source includes its first pull. `streamSandboxPrompt` is an
    // async generator, so its cold-start work does not execute until `next()`;
    // counting that time as provider inference would collapse the two phases.
    let next: IteratorResult<unknown> | typeof TIMED_OUT
    try {
      next = await Promise.race([
        Promise.resolve(iterator.next()),
        openDeadline.promise,
      ])
    } catch (err) {
      openDeadline.clear()
      abort()
      void closeIterator(iterator, options.log)
      throw err
    }
    openDeadline.clear()
    if (next === TIMED_OUT) {
      abort()
      void closeIterator(iterator, options.log)
      return {
        outcome: {
          committed: false,
          error: `Starting the model event source for ${model} exceeded ${openTimeoutMs}ms`,
          errorCode: 'model_stream_open_timeout',
          timeoutCode: 'model_stream_open_timeout',
        },
        empty: false,
      }
    }
    if (next.done) {
      abort()
      return { outcome: { committed: true, buffered, iterator: null, abort }, empty: true }
    }

    // One deadline for the WHOLE provider pre-response phase. Pulling a
    // lifecycle or processing event races the same promise; liveness cannot
    // reset the clock.
    const firstResponseDeadline = deadlineAfter(firstResponseTimeoutMs)

    for (;;) {
      const event = next.value
      let failure: TerminalFailure | null
      let commits = false
      try {
        failure = classifyTerminalFailure(event)
        commits = !failure && committing(event)
      } catch (err) {
        firstResponseDeadline.clear()
        abort()
        void closeIterator(iterator, options.log)
        throw err
      }
      if (failure?.outage) {
        firstResponseDeadline.clear()
        abort()
        void closeIterator(iterator, options.log)
        return {
          outcome: {
            committed: false,
            error: failure.reason,
            ...(failure.code ? { errorCode: failure.code } : {}),
          },
          empty: false,
        }
      }

      buffered.push(event)
      // A terminal NON-outage failure surfaces exactly as it does today.
      if (failure) {
        firstResponseDeadline.clear()
        return { outcome: { committed: true, buffered, iterator, abort }, empty: false }
      }
      if (commits) {
        firstResponseDeadline.clear()
        return { outcome: { committed: true, buffered, iterator, abort }, empty: isEmptyTerminalReceipt(event) }
      }

      // A THROWN failure propagates untouched: `runWithModelFailover` classifies
      // it (outage → next model, anything else → re-thrown to the caller).
      try {
        next = await Promise.race([
          Promise.resolve(iterator.next()),
          firstResponseDeadline.promise,
        ])
      } catch (err) {
        firstResponseDeadline.clear()
        abort()
        void closeIterator(iterator, options.log)
        throw err
      }
      if (next === TIMED_OUT) {
        firstResponseDeadline.clear()
        // Do not await `return()`: an async generator blocked inside `next()`
        // may not settle its return until that pull completes. Invoking it is
        // the cancellation signal; waiting for it would recreate the hang.
        abort()
        void closeIterator(iterator, options.log)
        return {
          outcome: {
            committed: false,
            error: `Model ${model} produced no first answer-bearing event within ${firstResponseTimeoutMs}ms`,
            errorCode: 'provider_first_response_timeout',
            timeoutCode: 'provider_first_response_timeout',
          },
          empty: false,
        }
      }
      if (next.done) {
        firstResponseDeadline.clear()
        abort()
        // Clean end with nothing committing. Not an outage — but also not an
        // answer, so it is re-runnable on the same model.
        return { outcome: { committed: true, buffered, iterator: null, abort }, empty: true }
      }
    }
  }

  const probe = async (model: string): Promise<AttemptOutcome> => {
    // Only the FINAL attempted model decides the exhaustion code. Clear a
    // prior model's timeout before this model can throw a different outage.
    finalTimeout = undefined
    for (let retry = 0; ; retry += 1) {
      const pass = await drainOnce(model)
      if (!pass.empty || retry >= emptyTurnRetries) {
        if (!pass.outcome.committed && pass.outcome.timeoutCode) {
          finalTimeout = {
            code: pass.outcome.timeoutCode,
            model,
            timeoutMs: pass.outcome.timeoutCode === 'model_stream_open_timeout'
              ? openTimeoutMs
              : firstResponseTimeoutMs,
          }
        } else {
          finalTimeout = undefined
        }
        return pass.outcome
      }
      // Discard the empty pass entirely — including its `step-finish` token
      // receipt, which must not be billed — and re-run the same model.
      const iterator = pass.outcome.committed ? pass.outcome.iterator : null
      if (pass.outcome.committed) pass.outcome.abort()
      if (iterator) void closeIterator(iterator, options.log)
      const info: EmptyTurnRetryInfo = { model, retry: retry + 1, remaining: emptyTurnRetries - retry - 1 }
      options.log?.('[chat-routes] turn completed with no assistant text; re-running the same model', {
        ...info,
      })
      options.onEmptyTurnRetry?.(info)
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
      if (err instanceof ModelFailoverExhaustedError && finalTimeout) {
        throw new ModelFailoverTimeoutError({
          attempts: trail,
          ...finalTimeout,
        })
      }
      throw err
    }

    for (const event of handle.buffered) yield event

    const live = handle.iterator
    if (!live) {
      handle.abort()
      return
    }
    try {
      for (;;) {
        const next = await live.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      // The consumer may abandon this generator mid-turn (client drop); close
      // the underlying stream rather than leaking it.
      handle.abort()
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
