import type { SandboxChatProducerOptions } from './sandbox-producer'
import type { ChatTurnModelAttribution } from './turn-routes'
import { asRecord, asString, type JsonRecord } from '../stream/index'
import { buildModelChain } from '../model-resolution/failover'
import { streamWithModelFailover, resolveEmptyTurnRetries, summarizeFailoverReason, type ModelFailoverStreamHandle } from './model-failover-stream'

function parseEffectiveBackend(data: JsonRecord): Omit<
  ChatTurnModelAttribution,
  'requestedModel' | 'echoReceived'
> | undefined {
  const backend = asRecord(data.effectiveBackend)
  if (!backend) return undefined
  const provider = asString(backend.provider)
  const model = asString(backend.model)
  const rawSource = asString(backend.source)
  const source =
    rawSource === 'request' || rawSource === 'environment' || rawSource === 'profile'
      ? rawSource
      : undefined
  if (!provider && !model && !source) return undefined
  return {
    ...(model ? { servedModel: model } : {}),
    ...(provider ? { servedProvider: provider } : {}),
    ...(source ? { servedSource: source } : {}),
  }
}

export function createSandboxModelSource(options: SandboxChatProducerOptions, log: (message: string, meta?: Record<string, unknown>) => void) {
  if (options.openEvents && !options.model) {
    throw new Error(
      'createSandboxChatProducer: `openEvents` requires `model` — failover must know which model it is running',
    )
  }
  if (!options.openEvents && !options.events) {
    throw new Error('createSandboxChatProducer: pass `openEvents` (failover-capable) or `events`')
  }
  // A fixed `events` stream cannot be re-opened, so the retry silently does
  // nothing. A config that asks for recovery and receives none is the exact
  // silent-no-op class this seam exists to remove — refuse it at construction
  // rather than let a product believe blank turns are being retried.
  if (!options.openEvents && resolveEmptyTurnRetries(options.emptyTurnRetries) > 0) {
    throw new Error(
      'createSandboxChatProducer: `emptyTurnRetries` requires `openEvents` — a fixed `events` stream cannot be re-opened',
    )
  }
  const chain = options.model
    ? buildModelChain(options.model, options.modelFailover === false ? [] : (options.fallbackModels ?? []))
    : []

  /** Fallback notices waiting to be emitted. `onFallback` fires from inside the
   *  first pull of the failover stream, where a generator cannot yield, so the
   *  notice is queued and drained at the top of the next loop iteration —
   *  landing immediately before the serving model's first event. */
  const pendingModelNotices: Array<{ id: string; text: string }> = []
  let modelNoticeCount = 0

  let failover: ModelFailoverStreamHandle | undefined
  let source: AsyncIterable<unknown>
  if (options.openEvents) {
    failover = streamWithModelFailover({
      models: chain,
      open: options.openEvents,
      log,
      ...(options.modelPolicy ? { policy: options.modelPolicy } : {}),
      ...(options.openTimeoutMs !== undefined ? { openTimeoutMs: options.openTimeoutMs } : {}),
      ...(options.firstResponseTimeoutMs !== undefined
        ? { firstResponseTimeoutMs: options.firstResponseTimeoutMs }
        : {}),
      ...(options.emptyTurnRetries !== undefined ? { emptyTurnRetries: options.emptyTurnRetries } : {}),
      ...(options.onEmptyTurnRetry ? { onEmptyTurnRetry: options.onEmptyTurnRetry } : {}),
      ...(options.liveLifecycleEvents !== undefined ? { liveLifecycleEvents: options.liveLifecycleEvents } : {}),
      onFallback: (info) => {
        modelNoticeCount += 1
        pendingModelNotices.push({
          id: `model-fallback-${modelNoticeCount}`,
          // Named models on both sides: a quality regression after a downgrade
          // must be attributable to the model that actually answered. The
          // REASON is condensed — a real edge 5xx arrives as Cloudflare's HTML
          // error page, and the raw text put `<!DOCTYPE html><!--[if lt IE 7]>…`
          // into the customer's transcript. The verbatim text is still on
          // `modelFailover.attempts[].reason` for the operator.
          text: `${info.from} was unavailable (${summarizeFailoverReason(info.reason)}) — answered with ${info.to} instead.`,
        })
        options.onModelFallback?.(info)
      },
    })
    source = failover.events
  } else {
    source = options.events!
  }

  /** The model that ACTUALLY served this turn. Read lazily everywhere (the
   *  `model` getter, the draft snapshot, the persisted row) so a fallback that
   *  happens after the row was drafted still lands on the final write. */
  const servingModel = (): string | undefined => failover?.servingModel() ?? options.model
  const modelState = { effectiveBackend: undefined as ReturnType<typeof parseEffectiveBackend> }
  let substitutionNoticeQueued = false
  const servedModel = (): string | undefined => modelState.effectiveBackend?.servedModel ?? servingModel()

  const captureEffectiveBackend = (data: JsonRecord | undefined): void => {
    if (!data) return
    const parsed = parseEffectiveBackend(data)
    if (!parsed) return
    modelState.effectiveBackend = parsed
    const sentModel = servingModel()
    if (
      substitutionNoticeQueued ||
      !options.model ||
      !sentModel ||
      !parsed.servedModel ||
      parsed.servedModel === sentModel
    ) return
    substitutionNoticeQueued = true
    pendingModelNotices.push({
      id: 'model-substitution-1',
      text: `Requested ${sentModel} — the sandbox answered with ${parsed.servedModel} instead.`,
    })
  }
  return { pendingModelNotices, source, captureEffectiveBackend, servedModel, servingModel, failover, modelState }
}
