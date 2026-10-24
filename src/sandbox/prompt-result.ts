import {
  type PromptInputPart,
  flattenHistory,
  resolveSandboxPromptBackend,
  mergeHistoryIntoParts,
} from './prompt-profile'
import type { StreamSandboxPromptOptions } from './prompt-options'
import type { SandboxRuntimeConfig } from './configuration'
import type { SandboxInstance, TurnDriveResult } from '@tangle-network/sandbox'
import { streamSandboxPrompt, emitSandboxActivity } from './prompt-dispatch'
import { type Outcome, ok, fail } from './outcome'
import { isTerminalPromptEvent } from './prompt-events'
import { SandboxRunError } from './sandbox-run-error'
import { redactErrorMessage } from '../redact'

/**
 * Stable identity for a streamed text part, so deltas of one part accumulate
 * together and two concurrent parts never overwrite each other. Harnesses spell
 * the id differently and some snapshot updates carry none at all.
 *
 * Deliberately NOT `/stream`'s `getPartKey`, despite the overlapping property
 * lookup: that one resolves a key for any persisted part across every type and
 * falls back to the CONSTANT `'current'`, which merges all id-less parts into a
 * single lane. Here an id-less part must stay distinct — merging two of them
 * would silently drop one candidate answer, the exact failure class this
 * function was changed to fix. Sharing three lines of lookup would also couple
 * `/sandbox` to `/stream`, which are independent subpaths today.
 */
function textPartId(part: Record<string, unknown> | undefined, fallback: string): string {
  for (const key of ['id', 'partId', 'messagePartId']) {
    const value = part?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return fallback
}

/**
 * The prompt text a harness may replay back as an assistant text part before it
 * answers. Both spellings are collected because `streamSandboxPrompt` dispatches
 * the HISTORY-FOLDED prompt, not the raw message — an echo replays what was sent.
 */
function dispatchedPromptTexts(
  message: string | PromptInputPart[],
  history: StreamSandboxPromptOptions['history'],
): string[] {
  const raw =
    typeof message === 'string'
      ? message
      : ((message.find((part) => part.type === 'text') as { text?: string } | undefined)?.text ?? '')
  return [...new Set([raw, flattenHistory(raw, history)].map((text) => text.trim()))].filter(Boolean)
}

/**
 * The last streamed text part that is not a replay of the prompt. Used only when
 * the turn carried no `result` receipt.
 *
 * Two distinct decisions, and only the first is content-based. WHICH parts are
 * eligible is decided by CONTENT — an echo is excluded because it matches the
 * dispatched prompt, at whatever position it arrived. Choosing among the
 * remaining eligible parts is then ordinal, last-wins, because a harness emits
 * reasoning/preamble parts before the answer. That ordering assumption is safe
 * in a way "skip the first part" was not: it can only pick the wrong part when a
 * turn produced several genuine non-echo texts and the final one is not the
 * answer, whereas the positional rule mis-fired on the single-answer case that
 * is overwhelmingly the common one.
 */
function lastNonPromptTextPart(parts: Map<string, string>, promptTexts: string[]): string {
  const values = Array.from(parts.values())
    .map((value) => value.trim())
    .filter((value) => value && !promptTexts.includes(value))
  return values.at(-1) ?? ''
}

/**
 * Aggregate a sandbox prompt event stream down to the turn's one final answer.
 *
 * Exported SEPARATELY from `runSandboxPrompt` because the aggregation is pure —
 * `AsyncIterable<event> -> string` — while the streaming half is not: a product
 * that mounts per-turn MCP servers or resolves its harness per workspace wraps
 * `streamSandboxPrompt` in its own generator. Binding this logic to one stream
 * function is exactly what pushed three products into forking the whole thing,
 * bug and all. Take this over a local copy no matter whose generator you drive.
 *
 * Two rules earn their keep, and both were learned from the naive version:
 *
 * - Text accumulates PER PART ID, never into one running buffer, so two
 *   concurrent text parts cannot overwrite each other.
 * - A prompt echo is identified by CONTENT, never by arrival position. The
 *   "skip whichever text part arrives first" shortcut is wrong on both sandbox
 *   lanes: on the delta lane (`box.streamPrompt`, explicit deltas) the first
 *   part is the answer's opening token, so the answer silently loses it; and
 *   when the echo arrives AFTER the answer, the function returns the caller's
 *   own prompt as the agent's reply. Both failures produce a plausible-looking
 *   string, the worst shape for the unattended cron/judge turns this exists for.
 *
 * A blank-but-present `result.finalText` is ignored in favour of the streamed
 * text rather than overwriting a real answer with whitespace.
 *
 * A turn with no answer is never returned as an empty string. It throws a
 * `SandboxRunError` that keeps the runtime's own account: `sandbox_unconfirmed`
 * when the stream never confirmed an end, `sandbox_failed` with the redacted
 * failure text the stream reported, else `sandbox_empty`. The error's cause
 * lists the event types the stream carried, so a product's failure log names
 * what the box did.
 *
 * @param events raw sandbox turn events, in order
 * @param message the prompt as handed to the stream, so an echo of it is dropped
 * @param history folded into the dispatched prompt by `streamSandboxPrompt`;
 *        pass whatever was passed there, since the echo replays the FOLDED text
 */
export async function collectSandboxPromptText(
  events: AsyncIterable<unknown>,
  message: string | PromptInputPart[],
  history?: StreamSandboxPromptOptions['history'],
): Promise<string> {
  const { answer, observation } = await collectSandboxPrompt(events, message, history)
  if (!answer) throw noAnswerError(observation)
  return answer
}

/** What a prompt stream reported besides its text. */
interface PromptStreamObservation {
  /** A `result`, or a `done` that is not the SDK's text-less cleanup after losing the stream. */
  terminal: boolean
  /** The first failure the stream reported, redacted. */
  failure?: string
  /** Event types in arrival order, with counts; text parts are keyed by part type. */
  types: Map<string, number>
}

const OBSERVED_TYPE_LIMIT = 16

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function failureText(data: Record<string, unknown> | undefined): string | undefined {
  const error = data?.error
  const text = [record(error)?.message, error, data?.message, data?.code]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return text === undefined ? undefined : redactErrorMessage(text)
}

function observePromptEvent(observation: PromptStreamObservation, type: string, data: Record<string, unknown> | undefined): void {
  const key = type === 'message.part.updated' ? `${type}(${String(record(data?.part)?.type ?? 'unknown')})` : type
  if (observation.types.has(key) || observation.types.size < OBSERVED_TYPE_LIMIT) {
    observation.types.set(key, (observation.types.get(key) ?? 0) + 1)
  }
  const status = data?.status
  const failed = type === 'error'
    || (type === 'done' && (status === 'failed' || status === 'cancelled'))
    || (type === 'result' && (data?.success === false || status === 'failed' || status === 'error' || Boolean(data?.error)))
  const text = failed ? failureText(data) : undefined
  // A failed `done` that carries the runtime's code or message is its recorded end; the
  // SDK's cleanup `done` after a lost stream carries neither.
  if (isTerminalPromptEvent({ type, data }) || (type === 'done' && text)) observation.terminal = true
  if (failed && !observation.failure && (text || type !== 'done')) observation.failure = text ?? `${type} event without a message`
}

function noAnswerError(observation: PromptStreamObservation): SandboxRunError {
  const types = Array.from(observation.types, ([type, count]) => `${type}×${count}`).join(', ') || 'no events'
  const cause = new Error(`Sandbox prompt stream carried ${types}; ${observation.terminal ? 'it reached a terminal event' : 'no terminal event'}.`)
  const failure = observation.failure
  if (!observation.terminal) {
    return new SandboxRunError('sandbox_unconfirmed', `The computer stopped reporting before its completion was confirmed. Its work may still be running.${failure ? ` ${failure}` : ''}`, { cause })
  }
  if (failure) return new SandboxRunError('sandbox_failed', `The computer reported a failed execution: ${failure}`, { cause })
  return new SandboxRunError('sandbox_empty', 'The sandbox finished without an answer.', { cause })
}

async function collectSandboxPrompt(
  events: AsyncIterable<unknown>,
  message: string | PromptInputPart[],
  history: StreamSandboxPromptOptions['history'],
): Promise<{ answer: string; observation: PromptStreamObservation }> {
  let finalText = ''
  const textParts = new Map<string, string>()
  let anonymousTextPart = 0
  const observation: PromptStreamObservation = { terminal: false, types: new Map() }

  for await (const rawEvent of events) {
    const event = rawEvent as { type?: string; data?: Record<string, unknown> }
    if (!event.type) continue
    observePromptEvent(observation, event.type, record(event.data))

    if (event.type === 'message.part.updated') {
      const part = event.data?.part as Record<string, unknown> | undefined
      const delta = typeof event.data?.delta === 'string' ? event.data.delta : null
      if (String(part?.type ?? '') === 'text') {
        const partId = textPartId(part, delta ? 'delta' : `text-${anonymousTextPart++}`)
        if (delta) textParts.set(partId, `${textParts.get(partId) ?? ''}${delta}`)
        else if (typeof part?.text === 'string') textParts.set(partId, part.text)
      }
    } else if (event.type === 'result') {
      const resultText = typeof event.data?.finalText === 'string' ? event.data.finalText : null
      if (resultText?.trim()) finalText = resultText
    }
  }

  const answer = finalText || lastNonPromptTextPart(textParts, dispatchedPromptTexts(message, history))
  return { answer, observation }
}

/**
 * Resolve a sandbox prompt by streaming it and aggregating the turn down to one
 * final string. The shell's profile / model / MCP resolution and severed-stream
 * fail-loud come from `streamSandboxPrompt`; the aggregation is
 * `collectSandboxPromptText`, which products driving their own generator should
 * import directly. Unlike that collector, an answer does not excuse a stream
 * that never confirmed its end or that reported a failure.
 */
export async function runSandboxPrompt(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string | PromptInputPart[],
  options?: StreamSandboxPromptOptions,
): Promise<string> {
  const { answer, observation } = await collectSandboxPrompt(streamSandboxPrompt(shell, box, message, options), message, options?.history)
  if (!answer || !observation.terminal || observation.failure) throw noAnswerError(observation)
  return answer
}

/** Define options to manage deterministic session resumption and turn idempotency in sandboxed drive turns */
export interface DriveSandboxTurnOptions extends StreamSandboxPromptOptions {
  /** Deterministic resume key — required. Every tick for the same logical turn
   * MUST reuse it so a crash + re-drive finds the in-flight session instead of
   * starting a second agent run. */
  sessionId: string
  /** Wall-clock cap in ms from the session's start. A still-running session past
   * the cap is cancelled and reported `failed` — bounds an unattended run, such as
   * a turn stalled on an interactive question with no consumer. Omit for no cap. */
  wallCapMs?: number
}

// One settle → poll → dispatch pass over a detached turn. Delegates to the SDK's
// `box.driveTurn` (@tangle-network/sandbox ≥ 0.10.5). Sandbox 0.37 admits the
// turn through the session message lane, so a SessionGateway consumer can observe it.
// The turn runs fire-and-detached server-side. ONE invocation returns its current
// state immediately. It never awaits the whole turn in-process, so it does not hold the
// worker alive for the run's duration (the durability trap the older box.prompt
// implementation quietly caused).
//
// This is the durable path for cron / mission-step / queue callers: re-invoke on
// your own schedule (Workflow step, DO alarm, queue tick) with the SAME
// `sessionId` and `turnId`. Dispatch is idempotent on that pair, so a crash +
// re-drive is a lookup, not a second agent run.
//
// The Outcome boundary separates a retryable transport failure from a settled
// turn: `fail` means the drive call itself threw (network blip — retry the tick);
// `ok` carries the SDK's discriminated `TurnDriveResult` — inspect `.state`:
//   - `running`   → the turn is still executing; re-tick after a delay of your choosing.
//   - `completed` → terminal; `.text` / `.result` hold the payload.
//   - `failed`    → terminal and deterministic; re-invoking will not change it (do not retry).
//   - `awaiting_plan_decision`, `blocked_on_approval`, `awaiting_question`,
//     `awaiting_interaction` → the turn settled waiting on a decision. Sandbox
//     0.45 reports the last three as `failed`.
/** Resolve a sandbox turn by processing a message with given configuration and options */
export async function driveSandboxTurn(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string | PromptInputPart[],
  options: DriveSandboxTurnOptions,
): Promise<Outcome<TurnDriveResult>> {
  // Configuration failures precede the retryable transport boundary.
  const backend = await resolveSandboxPromptBackend(shell, options, 'driveSandboxTurn')
  const prompt =
    typeof message === 'string'
      ? flattenHistory(message, options.history)
      : mergeHistoryIntoParts(message, options.history)
  try {
    const drive = await box.driveTurn(prompt, {
      sessionId: options.sessionId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.wallCapMs !== undefined ? { wallCapMs: options.wallCapMs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.expectedPublicProfileRequestDigest
        ? { expectedPublicProfileRequestDigest: options.expectedPublicProfileRequestDigest }
        : {}),
      ...(options.expectedSecretProfileReceipt
        ? { expectedSecretProfileReceipt: options.expectedSecretProfileReceipt }
        : {}),
      // Sandbox 0.37 drives through the session message lane, so a gateway
      // consumer can handle these events. Callers without one should omit
      // interactions so the run stays unattended.
      backend,
    } as Parameters<SandboxInstance['driveTurn']>[1])
    // The autonomous lane needs this most: a detached turn keeps the box
    // billable with nobody watching, and every tick that reports `running` is
    // fresh evidence it is still working. Without it the expectation ceiling
    // rests on whenever the box was last provisioned.
    emitSandboxActivity(options.spend, box)
    return ok(drive)
  } catch (err) {
    return fail(err)
  }
}
