import { assistantRowIdForTurn, createAssistantDraftWriter } from '../chat-routes/draft-persistence'
import { observeNativeCompletion, type NativeCompletionReceipt, type NativeCompletionSessionSource } from '../chat-routes/native-completion'
import type { ChatTurnMessageStore } from '../chat-routes/turn-route-contracts'
import { createTurnTrace, type TurnTrace, type TurnTraceSink, type TurnSpan, type TurnTraceSnapshot } from '../turn-trace/index'
import { createD1TurnEventStore } from '../stream/turn-buffer'
import { releaseDurableTurnLock, type TurnStreamNamespaceLike, type TurnStreamAuth } from '../turn-stream/adapters'
import { ensureCloudflareWorkflowInstance, type CloudflareWorkflowBindingLike } from './workflow-instance'
import { createD1NativeCompletionStore, type NativeCompletionPayload, type NativeCompletionCheckpoint } from './native-completion-store'
import type { D1Like } from './index'
import type { NativeCompletionWorkflowOptions } from './native-completion-workflow'
import type { CloudflareWorkflowEventLike, CloudflareWorkflowStepLike } from './detached-turn-workflow'

export const NATIVE_CHECKPOINT_MAX_BYTES = 256 * 1024
const encoder = new TextEncoder()

export async function nativeCompletionWorkflowId(executionId: string, prefix: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(executionId))
  return `${prefix}-${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`
}

/** A handed-off projection must never export the durable owner's root early. */
export function createNativeCompletionTraceSink(attached: TurnTraceSink) {
  const owned = new Set<string>()
  return {
    own: (rootSpanId: string) => { owned.add(rootSpanId) },
    sink: ((snapshot, labels) => owned.has(snapshot.rootSpanId) ? undefined : attached(snapshot, labels)) as TurnTraceSink,
  }
}

export interface NativeCompletionTimingSource {
  readonly startedAt: number
  phases(): Record<string, number>
  concurrent(): Record<string, number>
  queries(): Record<string, number>
}

/** Build a checkpoint without ending or replacing the original request trace. */
export function nativeCompletionCheckpoint(trace: TurnTrace, timing: NativeCompletionTimingSource,
  turnStartedAt: number): NativeCompletionCheckpoint {
  const now = Date.now()
  const summary = trace.summary(now)
  const checkpoint: NativeCompletionCheckpoint = {
    requestStartedAt: trace.startedAt, phaseStartedAt: timing.startedAt, turnStartedAt,
    ...(summary.firstVisibleMs === undefined ? {} : { firstVisibleAt: trace.startedAt + summary.firstVisibleMs }),
    ...(summary.firstTextMs === undefined ? {} : { firstTextAt: trace.startedAt + summary.firstTextMs }),
    trace: { traceId: trace.traceId, executionId: trace.executionId, rootSpanId: trace.root.id,
      startedAt: trace.startedAt, spans: [], summary: { ...summary }, truncatedSpans: 0 },
    phasesMs: timing.phases(), concurrentMs: timing.concurrent(), queries: timing.queries(),
  }
  // D1 cells and Workflow results have finite byte budgets. Prefix retention
  // keeps parents ahead of their children; clocks and root identity never trim.
  const spans = trace.spans(now)
  let bytes = encoder.encode(JSON.stringify(checkpoint)).byteLength + 1024
  for (const span of spans) {
    const size = encoder.encode(JSON.stringify(span)).byteLength + 1
    if (bytes + size > NATIVE_CHECKPOINT_MAX_BYTES) break
    checkpoint.trace.spans.push(span)
    bytes += size
  }
  const truncated = spans.length - checkpoint.trace.spans.length
  checkpoint.trace.truncatedSpans = truncated
  checkpoint.trace.summary.dropped += truncated
  if (truncated) checkpoint.checkpointTruncated = true
  if (encoder.encode(JSON.stringify(checkpoint)).byteLength > NATIVE_CHECKPOINT_MAX_BYTES) {
    throw new Error('Native completion checkpoint metadata exceeds its byte budget')
  }
  return checkpoint
}

/** Reuse the trace owner's reducer, retaining every original exported identity. */
export function nativeCompletionTerminalTrace(checkpoint: NativeCompletionCheckpoint,
  endedAt: number, error?: string): TurnTraceSnapshot {
  const original = checkpoint.trace
  const reducer = createTurnTrace({ startedAt: original.startedAt, executionId: original.executionId, now: () => endedAt })
  const parents = new Map<string, TurnSpan>([[original.rootSpanId, reducer.root]])
  for (const span of original.spans) {
    parents.set(span.spanId, reducer.record(span.name, span.kind, span.startMs, span.endMs,
      span.attrs, parents.get(span.parentSpanId) ?? reducer.root))
  }
  if (checkpoint.firstVisibleAt !== undefined) reducer.markFirstVisible(checkpoint.firstVisibleAt)
  if (checkpoint.firstTextAt !== undefined) reducer.markFirstText(checkpoint.firstTextAt)
  const reduced = reducer.finish({ endedAt, ...(error ? { error } : {}) })
  return { ...reduced, summary: { ...reduced.summary, dropped: original.summary.dropped,
      ...(original.summary.d1Queries === undefined ? {} : { d1Queries: original.summary.d1Queries }) },
    traceId: original.traceId, rootSpanId: original.rootSpanId,
    executionId: original.executionId, spans: original.spans }
}

/** Binding to the existing native completion owner. The product owns authorized source resolution and reconciliation. */
export interface NativeCompletionOwnerOptions<TPayload extends NativeCompletionPayload, TSource extends NativeCompletionSessionSource> {
  database: D1Like
  table: string
  messages: ChatTurnMessageStore
  /** The requested model is product data; the native receipt overrides it when available. */
  model(payload: TPayload): string
  lock: { namespace: TurnStreamNamespaceLike; auth: TurnStreamAuth }
  workflow: { binding: CloudflareWorkflowBindingLike<TPayload>; prefix: string }
  reconcile(payload: TPayload, source: TSource): Promise<boolean>
}

export function createNativeCompletionOwner<TPayload extends NativeCompletionPayload, TSource extends NativeCompletionSessionSource>(
  options: NativeCompletionOwnerOptions<TPayload, TSource>,
) {
  const store = createD1NativeCompletionStore<TPayload>(options.database, options.table)
  const persistTranscript = async (payload: TPayload, receipt: NativeCompletionReceipt): Promise<string> => {
    if (receipt.completedTurnIds.length && !receipt.completedTurnIds.includes(payload.nativeExecutionId)) {
      throw new Error('Native completion changed attempts before terminal persistence')
    }
    const messageId = assistantRowIdForTurn(payload.executionId)
    await createAssistantDraftWriter({ store: options.messages, threadId: payload.threadId,
      messageId, snapshot: () => null }).finalize({ content: receipt.text, parts: receipt.parts as never,
      model: receipt.servedModel ?? options.model(payload), ...receipt.usage })
    return messageId
  }
  const finalizeBuffer = async (payload: TPayload, receipt: NativeCompletionReceipt) => {
    await createD1TurnEventStore(options.database).setStatus(payload.turnStreamId,
      receipt.state === 'completed' ? 'complete' : 'error', payload.threadId)
  }
  const releaseLock = async (payload: TPayload) => { await releaseDurableTurnLock(options.lock.namespace, payload.lock, options.lock.auth) }
  const observe = (payload: TPayload, source: TSource | null, readonly = false) => observeNativeCompletion({
    source, admissionStore: readonly ? { ...store.admissionStore, renew: id => store.admissionStore.read(id) } : store.admissionStore,
    executionId: payload.executionId, sessionId: payload.sessionId, turnId: payload.nativeExecutionId,
    registeredAt: payload.registeredAt,
  })
  return {
    store, persistTranscript, finalizeBuffer, releaseLock, observe, reconcile: options.reconcile,
    /** Bind the maintained workflow algorithm; domain effects remain product callbacks. */
    workflow(input: {
      event: CloudflareWorkflowEventLike<TPayload>; step: CloudflareWorkflowStepLike
      initialize(): void
      source(payload: TPayload): Promise<TSource | null>
      observe?(payload: TPayload): ReturnType<typeof observe>
      settle(payload: TPayload, receipt: NativeCompletionReceipt, messageId: string): Promise<void>
      timing(payload: TPayload, checkpoint: NativeCompletionCheckpoint, trace: TurnTraceSnapshot, receipt: NativeCompletionReceipt): Promise<void>
      exportTrace(payload: TPayload, trace: TurnTraceSnapshot): Promise<void>
    }): NativeCompletionWorkflowOptions<TPayload, string> {
      const { event, step } = input, name = options.workflow.prefix
      const required = async () => {
        input.initialize()
        const row = await store.read(event.payload.executionId)
        if (!row) throw new Error('Native completion admission is missing')
        return row
      }
      let terminalAt: number
      return {
        event, step,
        observe: async () => {
          const { payload } = await required()
          return input.observe ? input.observe(payload) : observe(payload, await input.source(payload))
        },
        prepare: async (_initial, receipt) => {
          if ((await required()).vaultReconciledAt) return receipt
          for (let pass = 0; ; pass++) {
            const complete = await step.do(`${name}:vault-reconciliation:${pass}`, async () => {
              const { payload } = await required(), source = await input.source(payload)
              if (!source) throw new Error('Native completion sandbox is unavailable for reconciliation')
              return options.reconcile(payload, source)
            })
            if (complete) break
          }
          return receipt
        },
        persistTranscript: async (_initial, receipt) => persistTranscript((await required()).payload, receipt),
        settle: async (_initial, receipt, messageId) => {
          terminalAt = await step.do(`${name}:terminal-clock`, async () => Date.now())
          await input.settle((await required()).payload, receipt, messageId)
          await step.do(`${name}:timing`, async () => {
            const { payload, checkpoint } = await required()
            await input.timing(payload, checkpoint, nativeCompletionTerminalTrace(checkpoint, terminalAt, receipt.error), receipt)
          })
        },
        finalizeBuffer: async (_initial, receipt) => finalizeBuffer((await required()).payload, receipt),
        releaseLock: async () => releaseLock((await required()).payload),
        afterRelease: async (_initial, receipt) => {
          // Export retries must never hold a finished customer's lock.
          await step.do(`${name}:root-export`, async () => {
            const { payload, checkpoint } = await required()
            await input.exportTrace(payload, nativeCompletionTerminalTrace(checkpoint, terminalAt, receipt.error))
          })
          await step.do(`${name}:finalized`, () => store.finalized(event.payload.executionId))
        },
      }
    },
    async register(input: { payload: TPayload; trace: TurnTrace; timing: NativeCompletionTimingSource;
      turnStartedAt: number; source: TSource; handoffCompletion(): Promise<void> }) {
      const snapshot = () => nativeCompletionCheckpoint(input.trace, input.timing, input.turnStartedAt)
      let retained = snapshot()
      await store.register(input.payload, retained)
      await ensureCloudflareWorkflowInstance(options.workflow.binding, {
        id: await nativeCompletionWorkflowId(input.payload.executionId, options.workflow.prefix), params: input.payload,
      })
      await input.handoffCompletion()
      return {
        async projectionEnded(answered?: boolean) {
          const { executionId } = input.payload
          await store.checkpoint(executionId, snapshot())
          await store.projectionEnded(executionId)
          if (!answered) return
          // Read-only exact ledger observation cannot reclaim the request's relinquished lease.
          try {
            const row = await store.read(executionId)
            if (!row) return
            const observation = await observe(row.payload, input.source, true)
            if (observation.state !== 'completed' || !await options.reconcile(row.payload, input.source)) return
            await store.vaultReconciled(executionId)
            await persistTranscript(row.payload, observation.receipt)
            await finalizeBuffer(row.payload, observation.receipt)
            await releaseLock(row.payload)
          } catch (error) {
            // The durable owner still writes the row and releases the lock.
            console.warn('native completion early release skipped', error instanceof Error ? error.message : String(error))
          }
        },
        async capture(eventType?: string) {
          if (retained.firstVisibleAt !== undefined && retained.firstTextAt !== undefined) return
          if (retained.firstVisibleAt !== undefined && eventType && eventType !== 'text' && eventType !== 'message.part.updated') return
          const summary = input.trace.summary()
          const visibleAt = summary.firstVisibleMs === undefined ? undefined : input.trace.startedAt + summary.firstVisibleMs
          const textAt = summary.firstTextMs === undefined ? undefined : input.trace.startedAt + summary.firstTextMs
          if (visibleAt === retained.firstVisibleAt && textAt === retained.firstTextAt) return
          const next = snapshot()
          await store.checkpoint(input.payload.executionId, next)
          retained = next
        },
      }
    },
  }
}
