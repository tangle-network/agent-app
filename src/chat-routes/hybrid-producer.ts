/**
 * `createHybridTurnProducer`: the default chat turn. The model answers first
 * through the Tangle Router with the app's tools in process, and work that
 * needs a computer escalates to the workspace box through one `sandbox_run`
 * call whose answer comes back to the model.
 *
 * WHY THIS IS THE DEFAULT. Measured on production (2026-10-19/20): the
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
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { RouterTurnTool } from '../runtime/router-turn'
import {
  createEscalationSpeculator,
  escalationHints,
  type EscalationHint,
  type EscalationInput,
} from '../sandbox/escalation-speculator'
import { createSandboxRunTool, type SandboxRunToolOptions } from '../sandbox/sandbox-run-tool'
import type { PersistedChatMessageForTurn } from '../stream/index'
import { createRouterTurnProducer, type RouterTurnProducerOptions } from './router-producer'
import type { ChatTurnRouteProducer } from './turn-routes'
import type { ChatTurnPartInput, ChatTurnRequestPayload } from './wire'

// The lead-in covers every tool, not only sandbox_run: on Legal's Router lane (2026-10-20) the model streamed a
// submit_proposal payload for 45 s before its first word, so first text came at 54.9 s after a first token at 3.8 s.
/** What the default prompt adds so the Router lane answers first and escalates out loud. */
export const HYBRID_TURN_GUIDANCE =
  'Start your reply with text: before your first tool call, write one short sentence telling the member what you are ' +
  'about to do, so they never wait in silence. Use sandbox_run only for work that needs code execution or files on ' +
  'the workspace computer; describe the whole task in it and report what it returns.'

const DEFAULT_SANDBOX_RUN_TIMEOUT_MS = 4 * 60_000

export interface HybridTurnBox {
  /** Start or adopt the workspace box. The product provisions, binds and bills it, and keeps its own single flight
   *  across isolates. A throw reaches the model as `sandbox_unavailable` (or the `SandboxRunError` it throws). */
  acquire(signal: AbortSignal): Promise<SandboxInstance>
  /** A start admission already began ({@link startHybridBox}); the producer takes it as the turn's start. */
  started?: Promise<SandboxInstance>
  /** Runs the task on the box and returns its answer: `sandboxPromptRunner(shell, …)` or the product's runner. */
  runTask: SandboxRunToolOptions['runTask']
  /** Wall-clock cap for one `sandbox_run` call, box start included. Default 4 minutes. */
  timeoutMs?: number
  warm?: SandboxRunToolOptions['warm']
  onFailure?: SandboxRunToolOptions['onFailure']
  /** The tool's name and description. Default `sandbox_run` and its shared description. */
  name?: string
  description?: string
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
  /** Runs once when the turn's stream ends, however it ends (revoke a per-turn key, close a key scope). Its
   *  failure is logged, never thrown to the route. */
  onSettled?(): Promise<void> | void
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
  const { box, tools = [], speculateOn, attachments, onSpeculate, guidance, onSettled, signal, ...router } = options
  const abort = new AbortController()
  const stop = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
  const timeoutMs = box.timeoutMs ?? DEFAULT_SANDBOX_RUN_TIMEOUT_MS

  let start: Promise<SandboxInstance> | undefined = box.started?.catch((error: unknown) => {
    start = undefined
    throw error
  })
  const acquire = (): Promise<SandboxInstance> => (start ??= box.acquire(stop).catch((error: unknown) => {
    start = undefined
    throw error
  }))

  const sandboxRun = createSandboxRunTool({
    box: () => acquire(),
    runTask: box.runTask,
    timeoutMs,
    signal: stop,
    ...(box.warm ? { warm: box.warm } : {}),
    ...(box.onFailure ? { onFailure: box.onFailure } : {}),
    ...(box.name ? { name: box.name } : {}),
    ...(box.description ? { description: box.description } : {}),
  })
  const speculator = createEscalationSpeculator({
    warm: acquire,
    escalationTools: [sandboxRun.name],
    ...(onSpeculate ? { onSpeculate } : {}),
  })
  speculator.onInput({ text: speculateOn ?? router.userMessage, ...(attachments ? { attachments } : {}) })

  const extra = guidance === false ? '' : (guidance ?? HYBRID_TURN_GUIDANCE)
  const producer = createRouterTurnProducer({
    ...router,
    systemPrompt: extra ? `${router.systemPrompt}\n\n${extra}` : router.systemPrompt,
    tools: [...tools, sandboxRun],
    // A turn that calls the box must outlive the call it waits on.
    budgetMs: router.budgetMs ?? timeoutMs + 60_000,
    signal: stop,
    onEvent: event => {
      speculator.onEvent(event as { type: string; toolName?: string })
      router.onEvent?.(event)
    },
  })

  let settled = false
  const settle = async () => {
    if (settled) return
    settled = true
    try {
      await onSettled?.()
    } catch (error) {
      console.error(JSON.stringify({ event: 'hybrid_turn_settle_failed',
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }))
    }
  }

  return {
    ...producer,
    stream: (async function* () {
      let finished = false
      try {
        for await (const event of producer.stream) yield event
        finished = true
      } finally {
        // The route stopped reading this turn (a caller that cancels on disconnect): stop the engine and its box call.
        if (!finished) abort.abort(new Error('The chat route stopped reading this turn'))
        await settle()
      }
    })() as ChatTurnRouteProducer['stream'],
    get model() { return producer.model },
  }
}
