/**
 * `createHybridTurnProducer`: the default chat turn. The model answers first
 * through the Tangle Router with the app's tools in process, and work that
 * needs a computer escalates to the workspace box through one `sandbox_run`
 * call whose answer comes back to the model.
 *
 * WHY THIS IS THE DEFAULT. Measured on production: the
 * Hospitality Router lane gave first text at 3.6 s with 0 of 39 failures; its
 * sandbox lane 31.0 s with 2 of 8. Legal's sandbox lane gave first text at
 * p50 137 s because the box agent writes nothing until its last tool call. The
 * box only wins after about 8 tool calls through the API path (3 to 6 when it
 * is warm), and those turns still reach it here, through `sandbox_run`.
 *
 * THE BOX. The producer starts it at most once per turn and every caller
 * shares that start: the speculator, the `sandbox_run` call, and a start that
 * admission already began (`box.started`, from {@link startHybridBox} in
 * `afterAuthorize`). A failed start is forgotten, so the tool's own call
 * retries it. Across isolates the product's `acquire` keeps its existing
 * single flight (`runForegroundSandboxSingleFlight` over the D1 claim, or the
 * warm lease).
 *
 * THE SPECULATOR is always on: words that ask for execution, a code fence or a
 * process-shaped attachment start the box before the model call, and the model
 * naming `sandbox_run` starts it while the call's arguments still stream.
 *
 * FIRST WORDS. Unless the product passes its own `guidance`, the prompt tells
 * the model to say in one sentence what it is about to do before its first
 * tool call, so a turn that writes a deliverable or escalates to the box shows
 * text at the model's first token, not after its last tool call.
 *
 * The trace passes through: model calls, tool calls, the box claim and the box
 * run are recorded under the turn's `trace` when the route gives one.
 * A typed computer failure also emits a persisted warning; the Router keeps
 * answering without relying on the model to explain that failure faithfully.
 * The warning's `detail` is the failure's redacted cause chain, so the cause is
 * in the transcript, not only in a log line a Worker does not keep.
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import { redactErrorMessage } from '../redact/index'
import { noticePart } from '../interactions/contract'
import type { RouterTurnTool } from '../runtime/router-turn'
import {
  createEscalationSpeculator,
  escalationHints,
  type EscalationHint,
  type EscalationInput,
} from '../sandbox/escalation-speculator'
import { createSandboxRunTool, SandboxRunError, sandboxRunFailureDetail, type SandboxRunToolOptions } from '../sandbox/sandbox-run-tool'
import { createComputerStep, type ComputerStepOptions } from '../sandbox/computer-step'
import type { PersistedChatMessageForTurn } from '../stream/index'
import { createRouterTurnProducer, type RouterTurnProducerOptions } from './router-producer'
import type { ChatTurnRouteProducer } from './turn-routes'
import type { ChatTurnPartInput, ChatTurnRequestPayload } from './wire'
import type { ProducerNoticeEvent } from './wire'

// The lead-in covers every tool, not only sandbox_run: on Legal's Router lane the model streamed a
// submit_proposal payload for 45 s before its first word, so first text came at 54.9 s after a first token at 3.8 s.
/** What the default prompt adds so the Router lane answers first and escalates out loud. */
export const HYBRID_TURN_GUIDANCE =
  'Start your reply with text: before your first tool call, write one short sentence telling the member what you are ' +
  'about to do, so they never wait in silence. Use sandbox_run only for work that needs code execution or files on ' +
  "the workspace computer. Give the sandbox agent the member's requirements, paths and exact field names, " +
  'not model-written code; the sandbox agent writes and runs the code. Report what it returns.'

const DEFAULT_SANDBOX_RUN_TIMEOUT_MS = 4 * 60_000

export interface HybridTurnBox {
  /** Start or adopt the workspace box. The product provisions, binds and bills it, and keeps its own single flight
   *  across isolates. A throw reaches the model as `sandbox_unavailable` (or the `SandboxRunError` it throws). */
  acquire(signal: AbortSignal): Promise<SandboxInstance>
  /** A start admission already began ({@link startHybridBox}); the producer takes it as the turn's start. */
  started?: Promise<SandboxInstance>
  /** Runs the task on the box and returns its answer. Omit it and pass `computer` for agent-app's computer step. */
  runTask?: SandboxRunToolOptions['runTask']
  /** agent-app's computer step ({@link createComputerStep}): the first of the turn's models the box key allows, one
   *  session value, stable step ids, durable receipts and the copy of the step's files into the product's Vault.
   *  `parentExecutionId` defaults to the turn's execution id on the chat route, else the trace id. */
  computer?: ComputerStepOptions
  /** Wall-clock cap for one `sandbox_run` call, box start included. Default 4 minutes. */
  timeoutMs?: number
  warm?: SandboxRunToolOptions['warm']
  /** Every computer failure with its cause. The producer already persists the redacted cause chain on the turn's
   *  warning notice (`detail`), and logs it when this is omitted. */
  onFailure?: SandboxRunToolOptions['onFailure']
  /** What the turn's warning notice keeps as `detail` for a failed call. Members read that notice in the transcript.
   *  Default: the redacted cause chain ({@link sandboxRunFailureDetail}). Return undefined to keep a cause that holds
   *  private platform diagnostics off the transcript; `onFailure` still receives the full error. */
  failureDetail?(error: SandboxRunError): string | undefined
  /** The tool's name and description. Default `sandbox_run` and its shared description. */
  name?: string
  description?: string
  /** Dispose this turn's opaque client credentials/resources after any started acquire settles. Never retire the box. */
  dispose?(): Promise<void> | void
}

export interface HybridTurnProducerOptions extends RouterTurnProducerOptions {
  /** The app's in-process tools. `sandbox_run` is added after them. */
  tools?: RouterTurnTool[]
  box: HybridTurnBox
  /** The text the speculator reads. Default `userMessage`; pass what the member typed when `userMessage` carries
   *  injected context that would trip the execution words. */
  speculateOn?: string
  /** The turn's attachments, for the speculator. */
  attachments?: EscalationInput['attachments']
  onSpeculate?(hint: EscalationHint): void
  /** Appended to `systemPrompt`. Default {@link HYBRID_TURN_GUIDANCE}; `false` when the prompt already says it. */
  guidance?: string | false
}

/**
 * Start the box at admission when the request asks for execution, so its resume overlaps the turn lock and the
 * profile pin instead of following them. Call it in `afterAuthorize` with the turn's body and hand the promise to
 * the producer as `box.started`. Returns undefined, and starts nothing, for a turn that does not look like it needs
 * the box.
 */
export function startHybridBox(
  body: Pick<ChatTurnRequestPayload, 'content' | 'parts'>,
  acquire: () => Promise<SandboxInstance>,
): Promise<SandboxInstance> | undefined {
  const attachments = (body.parts ?? []).map(part => ({
    ...(part.mediaType ? { mediaType: part.mediaType } : {}),
    ...(part.filename ? { name: part.filename } : {}),
  }))
  if (escalationHints({ text: body.content ?? '', attachments }).length === 0) return undefined
  const started = acquire()
  // The producer or the caller's release awaits it; a start nobody awaits must not surface as an unhandled rejection.
  started.catch(() => undefined)
  return started
}

/** The turn's prompt as the text the model reads: text parts joined; file parts are not text. */
export function turnPromptText(prompt: string | readonly ChatTurnPartInput[]): string {
  return typeof prompt === 'string' ? prompt : prompt.map(part => part.type === 'text' ? part.text : '').join('\n')
}

/** Whether the turn carries files. Files live in the box, so a turn with them runs on the sandbox lane. */
export function turnCarriesFiles(prompt: string | readonly ChatTurnPartInput[]): boolean {
  return typeof prompt !== 'string' && prompt.some(part => part.type !== 'text')
}

/** The conversation so far as the plain text history a Router turn replays: the last `limit` user and assistant
 *  messages that have text. Tool parts are not replayed. */
export function routerTurnHistory(
  priorMessages: ReadonlyArray<Pick<PersistedChatMessageForTurn, 'role' | 'content'>>,
  limit = 40,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return priorMessages
    .filter((message): message is { role: 'user' | 'assistant'; content: string } =>
      (message.role === 'user' || message.role === 'assistant') && Boolean(message.content?.trim()))
    .slice(-limit)
    .map(({ role, content }) => ({ role, content }))
}

export function createHybridTurnProducer(options: HybridTurnProducerOptions): ChatTurnRouteProducer {
  const { box, tools = [], speculateOn, attachments, onSpeculate, guidance, onSettled, admitted, signal, ...router } = options
  const abort = new AbortController()
  const stop = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
  void admitted?.catch(error => { abort.abort(error) })
  const timeoutMs = box.timeoutMs ?? DEFAULT_SANDBOX_RUN_TIMEOUT_MS
  let activeTasks = 0
  let unconfirmed = false

  let start: Promise<SandboxInstance> | undefined = box.started?.catch((error: unknown) => {
    start = undefined
    throw error
  })
  // A turn that never calls the box never awaits its admission start; that start's failure is not unhandled.
  start?.catch(() => undefined)
  const acquire = async (): Promise<SandboxInstance> => {
    await admitted
    stop.throwIfAborted()
    return start ??= box.acquire(stop).catch((error: unknown) => { start = undefined; throw error })
  }

  let settled: Promise<void> | undefined
  const settle = () => settled ??= (async () => {
    abort.abort(new Error('The hybrid turn settled'))
    await (box.started ?? start)?.catch(() => undefined)
    const results = await Promise.allSettled([Promise.resolve().then(() => box.dispose?.()), Promise.resolve().then(() => onSettled?.())])
    for (const result of results) if (result.status === 'rejected') {
      console.error(JSON.stringify({ event: 'hybrid_turn_settle_failed', error: redactErrorMessage(result.reason) }))
    }
  })()

  try {
    const step = box.computer
      ? createComputerStep({ ...box.computer, parentExecutionId: box.computer.parentExecutionId ?? router.traceId })
      : undefined
    const runBoxTask = box.runTask ?? step?.runTask
    if (!runBoxTask) throw new Error('A hybrid box needs runTask or computer')
    const warnings = new Map<string, ProducerNoticeEvent>()
    // Each failed call's redacted cause chain, by call id, recorded before the engine reports the call's error.
    const details = new Map<string, string>()
    const withWarnings = (parts: Array<Record<string, unknown>>) => parts.flatMap(part => {
      const warning = warnings.get(String(part.callID ?? part.id ?? ''))
      return warning ? [part, noticePart(warning.noticeKind, warning.id, warning.text, warning.code, warning.detail)] : [part]
    })
    const sandboxRun = createSandboxRunTool({
      box: () => acquire(),
      runTask: async (...args) => {
        await admitted
        stop.throwIfAborted()
        if (unconfirmed || activeTasks > 0) throw new SandboxRunError('sandbox_unconfirmed', 'An earlier computer step may still be running; no further task was dispatched.')
        activeTasks++
        try { return await runBoxTask(...args) }
        catch (error) {
          if (!(error instanceof SandboxRunError) || error.code === 'sandbox_unconfirmed') unconfirmed = true
          throw error
        } finally { activeTasks-- }
      },
      memberRequest: router.userMessage,
      timeoutMs,
      signal: stop,
      ...(box.warm ? { warm: box.warm } : {}),
      onFailure: (error, call) => {
        const detail = box.failureDetail ? box.failureDetail(error) : sandboxRunFailureDetail(error)
        if (call.callId && detail) details.set(call.callId, detail)
        if (box.onFailure) box.onFailure(error, call)
        else console.error(JSON.stringify({ event: 'agent_app_sandbox_run_failed', callId: call.callId ?? null, code: error.code,
          detail: sandboxRunFailureDetail(error) }))
      },
      ...(box.name ? { name: box.name } : {}),
      ...(box.description ? { description: box.description } : {}),
    })
    const speculator = createEscalationSpeculator({
      warm: acquire,
      escalationTools: [sandboxRun.name],
      ...(onSpeculate ? { onSpeculate } : {}),
    })
    speculator.onInput({ text: speculateOn ?? router.userMessage, ...(attachments ? { attachments } : {}) })

    const extra = guidance === false ? '' : [guidance ?? HYBRID_TURN_GUIDANCE, step?.guidance].filter(Boolean).join('\n\n')
    const producer = createRouterTurnProducer({
      ...router,
      systemPrompt: Promise.resolve(router.systemPrompt).then(prompt => !extra ? prompt : typeof prompt === 'string'
        ? `${prompt}\n\n${extra}` : { ...prompt, stable: [...(prompt.stable ?? []), extra] }),
      tools: [...tools, sandboxRun],
      admitted,
      // A turn that calls the box must outlive the call it waits on.
      budgetMs: router.budgetMs ?? timeoutMs + 60_000,
      signal: stop,
      onSettled: settle,
      onEvent: event => {
        speculator.onEvent(event as { type: string; toolName?: string })
        if (event.type === 'tool' && event.status === 'error' && event.toolName === sandboxRun.name && !stop.aborted) {
          const code = event.error.code
          if (code === 'sandbox_unconfirmed') unconfirmed = true
          if (code === 'sandbox_unavailable' || code === 'sandbox_failed' || code === 'sandbox_unconfirmed' || code === 'sandbox_empty') {
            const detail = details.get(event.callId)
            warnings.set(event.callId, {
              type: 'notice', noticeKind: 'warning', id: `sandbox-warning:${event.callId}`, code,
              text: code === 'sandbox_unavailable'
                ? 'The workspace computer is unavailable. I can continue with work that does not need it.'
                : 'The computer step did not return a confirmed answer. I can continue with work that does not need it.',
              ...(detail ? { detail } : {}),
            })
          }
        }
        router.onEvent?.(event)
      },
    })
    const events = (async function* () {
      for await (const event of producer.stream) {
        yield event
        if (event.type === 'tool_result') {
          const warning = warnings.get(event.toolCallId)
          if (warning) yield warning
        }
      }
    })()
    // Closing before the wrapper's first pull must still abort the running Router.
    const end = events.return.bind(events)
    const fail = events.throw.bind(events)
    events.return = async value => {
      const closing = producer.stream.return(value)
      try { return await end(value) } finally { await closing }
    }
    events.throw = async error => {
      const closing = producer.stream.throw(error)
      try { return await fail(error) } finally { await closing }
    }
    return { ...producer, stream: events,
      terminalObserved: () => activeTasks === 0 && !unconfirmed,
      assistantParts: () => withWarnings(producer.assistantParts?.() ?? []),
      draftParts: () => withWarnings(producer.draftParts?.() ?? []),
      get model() { return producer.model },
    }
  } catch (error) {
    // Construction failures use the same tracked lifetime as stream failures, including a key still arriving.
    return createRouterTurnProducer({ ...router, systemPrompt: Promise.reject(error), signal: stop, onSettled: settle })
  }
}
