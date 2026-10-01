/** Application wiring over Runtime's observation and certified-delivery owners. */
import { createCertifiedDelivery } from './certified-delivery'
import type { ChatTurnProducer } from '@tangle-network/agent-runtime/durable'
import {
  createIntelligenceClient,
  type CertifiedPromptSourceOptions,
  type IntelligenceConfig,
  type IntelligenceClient,
  type RunRecord,
  type TraceMeta,
} from '@tangle-network/agent-runtime/intelligence'

/** One adapter per authorization scope. Never share a tenant's client with another tenant. */
export interface ApplicationIntelligenceOptions {
  /** Resolve trusted server configuration lazily. Runtime owns export and redaction. */
  config: () => IntelligenceConfig
  /** Opt-in prompt guidance only; this grants no tool, data, budget or activation authority. */
  delivery?: {
    enabled(): boolean
    config(): CertifiedPromptSourceOptions
  }
  /** Receives fixed diagnostic text, never raw errors, credentials or stream contents. */
  warn?(message: string): void
}

export interface ObservedApplicationProducer<P extends ChatTurnProducer = ChatTurnProducer> {
  produce(signal: AbortSignal): P
  /** Host-derived identifiers only. An omitted runId is a diagnostic, not joinable execution proof. */
  meta: Omit<TraceMeta, 'input'>
  signal?: AbortSignal
  /** Delegate preserves native generator cleanup/throw recovery. Abort interrupts pending reads. */
  cancellation?: 'delegate' | 'abort'
}

export interface ApplicationRunExport {
  traceId: string
  exportConfigured: boolean | null
  /** Queueing or flushing a batch is not an acknowledgement for this particular run. */
  delivery: 'unconfirmed' | 'unconfigured' | 'unavailable'
}

/** Shared app entry points; Runtime/Eval/Intelligence still own search, evidence and activation. */
export interface ApplicationIntelligence {
  observeProducer<P extends ChatTurnProducer>(request: ObservedApplicationProducer<P>): Promise<P>
  /** Native jobs pass the retained Runtime record, never a reconstructed viewer transcript. */
  recordRun(record: RunRecord): ApplicationRunExport
  /** Record an explicit metadata-only lifecycle observation, without inventing semantic success. */
  recordObservation(meta: Omit<TraceMeta, 'input'>, costUsd?: number): Promise<void>
  composePrompt(base: string): Promise<string>
  flush(): Promise<void>
  doctor(): ReturnType<IntelligenceClient['doctor']>
  exportStats(): ReturnType<IntelligenceClient['exportStats']>
}

function snapshotMeta(meta: Omit<TraceMeta, 'input'>): Omit<TraceMeta, 'input'> {
  return { runId: meta.runId, traceId: meta.traceId, model: meta.model,
    provider: meta.provider, labels: { ...meta.labels } }
}

/** Race a single pull, not a second drain. Late source rejection stays observed by Promise.race. */
async function pullWithSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation()
    }), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createApplicationIntelligence(options: ApplicationIntelligenceOptions): ApplicationIntelligence {
  let client: IntelligenceClient | undefined
  let delivery: ReturnType<typeof createCertifiedDelivery> | undefined
  const getClient = () => client ??= createIntelligenceClient(options.config())
  const warn = () => {
    try { options.warn?.('[intelligence] application observation unavailable') } catch {
      // A diagnostic callback cannot replace the original execution result.
    }
  }
  const recordObservation: ApplicationIntelligence['recordObservation'] = async (meta, costUsd) => {
    const captured = snapshotMeta(meta)
    try {
      await getClient().traceRun(captured, async (trace) => {
        if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) {
          trace.recordOutcome({ costUsd })
        }
      })
    } catch { warn() }
  }

  return {
    async observeProducer<P extends ChatTurnProducer>(request: ObservedApplicationProducer<P>): Promise<P> {
      const meta = snapshotMeta(request.meta)
      const controller = new AbortController()
      const signal = request.signal
        ? AbortSignal.any([controller.signal, request.signal]) : controller.signal
      const interrupt = request.cancellation === 'abort'
      const producer = request.produce(signal)
      const source = producer.stream
      let consumerClosed = false
      const stream = (async function* (): ChatTurnProducer['stream'] {
        const startedAt = Date.now()
        let termination: 'exhausted' | 'interrupted' | 'failed' = 'exhausted'
        let cleanup = 'confirmed'
        try {
          yield* {
            [Symbol.asyncIterator]() {
              return {
                next: (...args: [] | [unknown]) => interrupt
                  ? pullWithSignal(() => source.next(...args), signal) : source.next(...args),
                throw: source.throw.bind(source),
                return: (value: void | PromiseLike<void>) => {
                  termination = 'interrupted'
                  return source.return(value)
                },
              }
            },
          }
        } catch (error) {
          termination = interrupt && signal.aborted ? 'interrupted' : 'failed'
          if (!(interrupt && consumerClosed)) throw error
        } finally {
          if (interrupt && signal.aborted) {
            // An uncooperative producer may still be running. Request cleanup
            // without hanging the caller, and never certify that it completed.
            cleanup = 'unconfirmed'
            void source.return().catch(warn)
          }
          const completedAt = Date.now()
          await recordObservation({ ...meta, labels: {
            ...meta.labels,
            'tangle.observation.kind': 'stream-lifecycle',
            'tangle.stream.termination': termination,
            'tangle.stream.cleanup': cleanup,
            'tangle.started_at_ms': startedAt,
            'tangle.completed_at_ms': completedAt,
            'tangle.duration_ms': Math.max(0, completedAt - startedAt),
          } })
        }
      })()
      if (interrupt) {
        const close = stream.return.bind(stream)
        stream.return = async (value) => {
          consumerClosed = true
          controller.abort(new Error('Chat stream consumer cancelled'))
          return close(value)
        }
        stream.throw = async (error) => {
          consumerClosed = true
          controller.abort(error)
          await close(undefined)
          throw error
        }
      }
      // Forward live getters and bind methods to their actual owner. In
      // particular a served-model getter must not be sampled before execution.
      const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>()
      return new Proxy(producer, {
        get(target, key) {
          if (key === 'stream') return stream
          const value = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          const cached = methods.get(key)
          if (cached?.original === value) return cached.bound
          const bound = value.bind(target)
          methods.set(key, { original: value, bound })
          return bound
        },
      })
    },
    recordRun(record) {
      try {
        const observer = getClient()
        const exportConfigured = observer.doctor().exportConfigured
        const traceId = observer.exportRunRecord(record)
        return { traceId, exportConfigured, delivery: exportConfigured ? 'unconfirmed' : 'unconfigured' }
      } catch {
        warn()
        return { traceId: record.traceId, exportConfigured: null, delivery: 'unavailable' }
      }
    },
    recordObservation,
    async composePrompt(base) {
      if (!options.delivery?.enabled()) return base
      delivery ??= createCertifiedDelivery(options.delivery.config())
      const composed = await delivery.composePrompt(base)
      return options.delivery.enabled() ? composed : base
    },
    async flush() { if (client) await client.flush() },
    doctor: () => getClient().doctor(),
    exportStats: () => client?.exportStats(),
  }
}
