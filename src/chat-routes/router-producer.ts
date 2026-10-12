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
import { runRouterTurn, type RouterTurnOptions, type RouterTurnOutcome } from '../runtime/router-turn'
import { createReasoningClock } from './reasoning-clock'
import type { ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'
import type { ProducerWireEvent } from './wire'

export type RouterTurnProducerOptions = Omit<RouterTurnOptions, 'onEvent'> & {
  /** Observe the finished turn (placement records, metrics, billing). */
  onOutcome?: (outcome: RouterTurnOutcome) => void
}

export function createRouterTurnProducer(options: RouterTurnProducerOptions): ChatTurnRouteProducer {
  const queue: ProducerWireEvent[] = []
  let wake: (() => void) | null = null
  let done = false
  let outcome: RouterTurnOutcome | null = null
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

  const run = runRouterTurn({
    ...options,
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
      } else if (event.type === 'usage') {
        push({ type: 'usage', usage: { promptTokens: event.promptTokens, completionTokens: event.completionTokens } })
      } else if (event.type === 'tool_event') {
        // Recorded on the tool's part, so a reload shows what the tool did, and streamed as it happens.
        const part = toolParts.get(event.callId)
        if (part) {
          const state = part.state as Record<string, unknown>
          part.state = { ...state, events: [...(state.events as unknown[] ?? []), { kind: event.kind, data: event.data, at: event.at }] }
        }
        push({ type: 'tool.event', data: { toolCallId: event.callId, toolName: event.toolName, kind: event.kind, data: event.data, at: event.at } })
      }
    },
  }).then(result => {
    outcome = result
    options.onOutcome?.(result)
    if (result.failure) {
      push({ type: 'error', data: { message: result.failure.message, code: result.failure.code } })
    }
  }).finally(() => {
    reasoningClock.settle()
    done = true
    wake?.()
  })

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

  const usage = (): ChatTurnUsage => ({
    inputTokens: outcome?.usage.promptTokens ?? 0,
    outputTokens: outcome?.usage.completionTokens ?? 0,
  })

  return {
    stream: stream() as ChatTurnRouteProducer['stream'],
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
