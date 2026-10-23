/**
 * The chat-route producer for a Router turn: `runRouterTurn` behind the same
 * `produce` seam the sandbox lane uses (`createSandboxChatProducer`). The route
 * persists, buffers, replays and settles the turn exactly as it does for the
 * sandbox; only the producer differs.
 *
 * The engine is pushed, the route pulls: engine events land in a queue that the
 * `stream` generator drains in order, so a slow consumer never drops a frame
 * and the engine never waits on the consumer.
 */
import { composeRouterTurnPromptSections, runRouterTurn, type RouterTurnEvent, type RouterTurnOptions, type RouterTurnOutcome, type RouterTurnPromptOptions, type RouterTurnTool } from '../runtime/router-turn'
import { createReasoningClock } from './reasoning-clock'
import { redactErrorMessage } from '../redact/index'
import type { ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'
import type { ProducerWireEvent } from './wire'

type RouterTurnKey = string | { key: string; fetchImpl?: typeof fetch; revoke(): Promise<void> }
type RouterTurnPrompt = string | (RouterTurnPromptOptions & { profile: Parameters<typeof composeRouterTurnPromptSections>[0] })

export type RouterTurnProducerOptions = Omit<RouterTurnOptions, 'onEvent' | 'systemPrompt' | 'apiKey'> & {
  /** The turn's key, including any claim still in flight. A lease's fetch and retirement belong to this producer. */
  apiKey: RouterTurnKey | Promise<RouterTurnKey>
  /** Domain-authored stable and per-turn bytes; composition and prefix validation are automatic. */
  systemPrompt: RouterTurnPrompt | Promise<RouterTurnPrompt>
  /** Final admission: model text may start earlier, but every tool waits for this request's committed domain state. */
  admitted?: Promise<unknown>
  /** Observe the finished turn (placement records, metrics, billing). */
  onOutcome?: (outcome: RouterTurnOutcome) => void
  /** Observe each engine event after the producer has projected it (a box speculator, metrics). A throw is ignored. */
  onEvent?: (event: RouterTurnEvent) => void
  /** Retire product resources once, including initialization failure and cancellation before the stream is read. */
  onSettled?(): Promise<void> | void
}

export function createRouterTurnProducer(options: RouterTurnProducerOptions): ChatTurnRouteProducer {
  const abort = new AbortController()
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal
  void options.admitted?.catch(error => { abort.abort(error) })
  const credential = Promise.resolve(options.apiKey)
  let credentialSettled = false
  void credential.then(() => { credentialSettled = true }, () => { credentialSettled = true })
  let retired: Promise<void> | undefined
  const retire = () => retired ??= credential.then(async key => {
    if (typeof key !== 'string') await key.revoke()
  }, () => undefined).catch(error => {
    console.error(JSON.stringify({ event: 'router_turn_key_retire_failed', error: redactErrorMessage(error) }))
  })
  let stop: (reason: unknown) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => { stop = reject })
  const stopped = () => { stop(signal.reason); void retire() }
  signal.addEventListener('abort', stopped, { once: true })
  if (signal.aborted) stopped()
  const queue: ProducerWireEvent[] = []
  let wake: (() => void) | null = null
  let done = false
  let outcome: RouterTurnOutcome | null = null
  // The runtime starts usage at zero, so only a reported usage event makes the counts real.
  let usageReported = false
  const parts: Array<Record<string, unknown>> = []
  const toolParts = new Map<string, Record<string, unknown>>()
  let textPart: { type: 'text'; text: string } | null = null
  let textSegment = 0
  let reasoningPart: { type: 'reasoning'; text: string } | null = null
  // Each reasoning part's start and end, the same timing the sandbox producer persists.
  const reasoningClock = createReasoningClock<Record<string, unknown>>()

  const push = (event: ProducerWireEvent) => {
    queue.push(event)
    wake?.()
  }

  const run = Promise.race([Promise.all([credential, options.systemPrompt]), cancelled]).then(([key, prompt]) => {
    signal.throwIfAborted()
    return runRouterTurn({
      ...options,
      apiKey: typeof key === 'string' ? key : key.key,
      fetchImpl: typeof key === 'string' ? options.fetchImpl : key.fetchImpl ?? options.fetchImpl,
      signal,
      tools: options.tools?.map(tool => ({ ...tool, run: async (...args: Parameters<RouterTurnTool['run']>) => {
        await options.admitted; signal.throwIfAborted(); return tool.run(...args)
      } })),
      systemPrompt: typeof prompt === 'string' ? prompt : composeRouterTurnPromptSections(prompt.profile, prompt).text,
      showReasoning: options.showReasoning ?? true,
      onEvent: event => {
        if (event.type === 'text') {
          if (event.segment !== textSegment || !textPart) {
            textSegment = event.segment
            textPart = { type: 'text', text: '' }
            parts.push(textPart)
          }
          textPart.text += event.delta
          reasoningPart = null
          reasoningClock.settle()
          push({ type: 'text', text: event.delta })
        } else if (event.type === 'reasoning') {
          // A reasoning run is one part until a word or a tool interrupts it.
          if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', text: '' }
            parts.push(reasoningPart)
          }
          reasoningPart.text += event.delta
          reasoningClock.reasoning(reasoningPart)
          push({ type: 'reasoning', text: event.delta })
        } else if (event.type === 'tool') {
          reasoningPart = null
          // The model stopped reasoning when it called the tool.
          reasoningClock.settle(event.startedAt)
          if (event.status === 'running') {
            const part = { type: 'tool', id: event.callId, callID: event.callId, tool: event.toolName,
              state: { status: 'running', input: event.input, time: { start: event.startedAt } } }
            toolParts.set(event.callId, part)
            parts.push(part)
            push({ type: 'tool_call', call: { toolCallId: event.callId, toolName: event.toolName, args: event.input } })
          } else {
            const part = toolParts.get(event.callId)
            const state = event.status === 'completed'
              ? { status: 'completed', output: event.output, time: { start: event.startedAt, end: event.endedAt } }
              : { status: 'error', error: event.error.message, time: { start: event.startedAt, end: event.endedAt } }
            if (part) part.state = { ...(part.state as Record<string, unknown>), ...state }
            push({ type: 'tool_result', toolCallId: event.callId, toolName: event.toolName,
              outcome: event.status === 'completed' ? { ok: true, result: event.output } : { ok: false, message: event.error.message, code: event.error.code } })
          }
        } else if (event.type === 'repeat') {
          // The repeat's reasoning is a new run: close the failed call's part so the two never merge.
          reasoningPart = null
          reasoningClock.settle()
        } else if (event.type === 'usage') {
          usageReported = true
          push({ type: 'usage', usage: { promptTokens: event.promptTokens, completionTokens: event.completionTokens,
            ...(event.cachedPromptTokens !== undefined ? { cachedPromptTokens: event.cachedPromptTokens } : {}) } })
        } else if (event.type === 'tool_event') {
          // Recorded on the tool's part, so a reload shows what the tool did, and streamed as it happens.
          const part = toolParts.get(event.callId)
          if (part) {
            const state = part.state as Record<string, unknown>
            part.state = { ...state, events: [...(state.events as unknown[] ?? []), { kind: event.kind, data: event.data, at: event.at }] }
          }
          push({ type: 'tool.event', data: { toolCallId: event.callId, toolName: event.toolName, kind: event.kind, data: event.data, at: event.at } })
        }
        if (options.onEvent) {
          try { options.onEvent(event) } catch { /* an observer never changes the turn */ }
        }
      },
    })
  }).then(result => {
    outcome = result
    options.onOutcome?.(result)
    if (result.failure) {
      push({ type: 'error', data: { message: result.failure.message, code: result.failure.code } })
    }
  }).finally(async () => {
    const retiring = retire()
    if (credentialSettled) await retiring
    try { await options.onSettled?.() } catch (error) {
      console.error(JSON.stringify({ event: 'router_turn_settle_failed', error: redactErrorMessage(error) }))
    }
    signal.removeEventListener('abort', stopped)
    reasoningClock.settle()
    done = true
    wake?.()
  })
  void run.catch(() => undefined)

  async function* stream(): AsyncGenerator<ProducerWireEvent, void, unknown> {
    for (;;) {
      while (queue.length) yield queue.shift()!
      if (done) break
      await new Promise<void>(resolve => { wake = resolve })
      wake = null
    }
    await run
  }

  // A reasoning part carries its run's time; a run still open in a mid-turn draft has a start and no end.
  const snapshot = () => parts.map(part => part.type === 'reasoning'
    ? { ...part, time: reasoningClock.time(part) }
    : { ...part })

  // A turn whose Router reported no usage stores no counts (null), never a made-up 0.
  const usage = (): ChatTurnUsage => !outcome || !usageReported ? {} : ({
    // The Router's prompt tokens include the cached ones; the sandbox lanes report input and cache reads apart, so
    // the stored row counts them apart here too and `inputTokens + cacheReadTokens` is the prompt on either lane.
    inputTokens: outcome.usage.promptTokens - (outcome.usage.cachedPromptTokens ?? 0),
    outputTokens: outcome.usage.completionTokens,
    ...(outcome.usage.cachedPromptTokens !== undefined ? { cacheReadTokens: outcome.usage.cachedPromptTokens } : {}),
  })

  const events = stream()
  const end = events.return.bind(events)
  const fail = events.throw.bind(events)
  events.return = async value => {
    abort.abort(new Error('The chat route stopped reading this turn'))
    try { return await end(value) } finally { const retiring = retire(); if (credentialSettled) await retiring }
  }
  events.throw = async error => {
    abort.abort(error)
    try { return await fail(error) } finally { const retiring = retire(); if (credentialSettled) await retiring }
  }

  return {
    stream: events as ChatTurnRouteProducer['stream'],
    // The route tracks this continuation even when failure is visible before a pending key arrives.
    cleanup: run.then(retire, retire),
    finalText: () => outcome?.text ?? '',
    assistantParts: snapshot,
    draftParts: snapshot,
    usage,
    get model() { return outcome?.servedModel ?? options.model },
    modelAttribution: () => ({
      requestedModel: options.model,
      ...(outcome?.servedModel ? { servedModel: outcome.servedModel } : {}),
      echoReceived: Boolean(outcome?.servedModel),
    }),
  }
}
