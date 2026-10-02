import type { IntelligenceClient } from '@tangle-network/agent-runtime/intelligence'
import type { ChatTurnRouteProducer } from './turn-routes'

/** Host-resolved metadata only. Neither input nor output content is exported. */
export interface ChatTurnIntelligenceOptions {
  client: () => Pick<IntelligenceClient, 'traceRun'>
  sessionId: string
  userId?: string
  workspaceId?: string
  /** Exact execution identity, when retained by the execution owner. */
  runId?: string
  traceId?: string
  /** Requested model. This is not a receipt for the model that served. */
  model?: string
  /** Existing transport cancellation evidence; grants no new abort authority. */
  signal?: AbortSignal
  /** Receives no exception text, which may contain private customer material. */
  onObservationError?: () => void
}

/**
 * Observe the source iterator without an execution loop, relay, queue or eager
 * pull. The source still owns cancellation and serializes its own operations.
 * Stream termination is not task correctness, reviewer acceptance or delivery.
 */
export function observeChatTurnStream<TEvent>(
  source: AsyncGenerator<TEvent, void, unknown>,
  options: ChatTurnIntelligenceOptions,
): AsyncGenerator<TEvent, void, unknown> {
  const { client, sessionId, userId, workspaceId, runId, traceId, model, signal, onObservationError } = options
  let state: 'idle' | 'running' | 'terminal' = 'idle'
  let startedAt = 0
  let interrupted = false
  let observation: Promise<void> | undefined

  const finish = (termination: 'exhausted' | 'interrupted' | 'failed'): Promise<void> => {
    if (state !== 'running') return observation ?? Promise.resolve()
    state = 'terminal'
    const completedAt = Date.now()
    const observedTermination = signal?.aborted ? 'interrupted' : termination
    observation = Promise.resolve().then(async () => {
      await client().traceRun({
        ...(runId !== undefined ? { runId } : {}),
        ...(traceId !== undefined ? { traceId } : {}),
        ...(model !== undefined ? { model } : {}),
        labels: {
          'tangle.sessionId': sessionId,
          ...(userId !== undefined ? { 'tangle.userId': userId } : {}),
          ...(workspaceId !== undefined ? { 'tangle.workspaceId': workspaceId } : {}),
          'tangle.observation.kind': 'stream-lifecycle',
          'tangle.stream.termination': observedTermination,
          'tangle.started_at_ms': startedAt,
          'tangle.completed_at_ms': completedAt,
          'tangle.duration_ms': Math.max(0, completedAt - startedAt),
        },
      }, async () => undefined)
    }).catch(() => {
      // Even a diagnostic callback must not replace an execution error.
      try { onObservationError?.() } catch { /* Best-effort telemetry only. */ }
    })
    return observation
  }

  const invoke = async (
    method: 'next' | 'return' | 'throw',
    operation: () => ReturnType<typeof source.next>,
  ): Promise<Awaited<ReturnType<typeof source.next>>> => {
    if (state === 'idle') {
      // A pre-start close still reaches the source to release factory-owned
      // resources, but does not manufacture an executed-turn observation.
      if (method === 'next') {
        state = 'running'
        startedAt = Date.now()
      } else {
        state = 'terminal'
      }
    }
    try {
      const result = await operation()
      // Apply return intent in source settlement order. A queued return must
      // not relabel an earlier naturally completed next() as cancellation.
      if (method === 'return' && state === 'running') interrupted = true
      if (result.done) await finish(interrupted ? 'interrupted' : 'exhausted')
      return result
    } catch (error) {
      await finish('failed')
      throw error
    }
  }

  return {
    [Symbol.asyncIterator]() { return this },
    next(...args) { return invoke('next', () => source.next(...args)) },
    return(value) { return invoke('return', () => source.return(value)) },
    throw(error) { return invoke('throw', () => source.throw(error)) },
    async [Symbol.asyncDispose]() { await this.return(undefined) },
  }
}

/**
 * Adapter for product producer factories. It preserves every declared
 * ChatTurnRouteProducer projection, lazily bound to the original receiver,
 * including class-backed or frozen producers. No output is read.
 */
export async function produceChatTurnWithIntelligence(
  options: ChatTurnIntelligenceOptions & {
    produce: () => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
  },
): Promise<ChatTurnRouteProducer> {
  // Freeze scalar metadata before an asynchronous producer can change context.
  const snapshot: ChatTurnIntelligenceOptions = { ...options }
  const producer = await options.produce()
  return {
    stream: observeChatTurnStream(producer.stream, snapshot),
    finalText: () => producer.finalText(),
    get assistantParts() { return producer.assistantParts?.bind(producer) },
    get draftParts() { return producer.draftParts?.bind(producer) },
    get usage() { return producer.usage?.bind(producer) },
    get model() { return producer.model },
    get modelFailover() { return producer.modelFailover?.bind(producer) },
    get modelAttribution() { return producer.modelAttribution?.bind(producer) },
  }
}
