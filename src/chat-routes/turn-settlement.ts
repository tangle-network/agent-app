/** Lifecycle hooks and trace settlement for the route's existing live projection. */
import type { ChatTurnIdentity } from '@tangle-network/agent-runtime/durable'
import type { TurnTraceSink, TurnTraceSnapshot, TurnTraceSummary } from '../turn-trace/recorder'
import { otlpTraceId } from '../turn-trace/otel'
import { noteMeasuredTurnFacts, readableTurnFailure } from '../turn-trace/turn-facts'
import type { AdmittedTurn } from './turn-admission'
import type { AdmittedTurnState } from './turn-execution'
import { failureCodeOf } from './turn-event-stream'
import type { ResolvedChatTurnRoutesOptions } from './route-storage'
import type {
  ChatTurnLifecycleComplete, ChatTurnModelAttribution, ChatTurnRequestContext, ChatTurnTraceOptions,
} from './turn-route-contracts'

/** One requested-versus-served projection for persistence and both completion receipts. */
export function modelAttributionFields(attribution: ChatTurnModelAttribution | undefined) {
  return {
    ...(attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {}),
    ...(attribution?.servedModel ? { servedModel: attribution.servedModel } : {}),
    ...(attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {}),
    ...(attribution?.servedSource ? { servedSource: attribution.servedSource } : {}),
  }
}

/** The lifecycle's timing for a settled turn, noted for the rollout timing store so it can fill a product row that
 *  omits it (rollout/d1 `record`). */
function settledTurnTiming(turnStreamId: string, at: {
  requestAt: number; startedAt: number; firstVisibleAt?: number
  firstTextAt?: number; model?: string
  failure?: { data?: Record<string, unknown>; error: unknown }
}, trace: TurnTraceSummary) {
  const measured = {
    admissionMs: at.startedAt - at.requestAt,
    ...(at.firstVisibleAt === undefined ? {} : { firstVisibleMs: at.firstVisibleAt - at.startedAt }),
    ...(at.firstTextAt === undefined ? {} : { firstTextMs: at.firstTextAt - at.startedAt }),
  }
  const failureCode = at.failure ? readableTurnFailure(at.failure.error, at.failure.data) : undefined
  noteMeasuredTurnFacts(turnStreamId, { requestReceivedAt: at.requestAt, ...measured, ...(at.model ? { model: at.model } : {}),
    ...(failureCode ? { failureCode } : {}) })
  return { ...measured, trace }
}

export function createTurnSettlement<TContext, TResource>(
  state: AdmittedTurnState<TContext>,
  trace: AdmittedTurn<TContext>['trace'],
  options: ResolvedChatTurnRoutesOptions<TContext, TResource>,
  executionId: string,
  traceSink: TurnTraceSink | undefined,
  identity: ChatTurnIdentity,
  traceOptions: ChatTurnTraceOptions<TContext> | undefined,
  context: TContext,
  turnStreamId: `${string}-${string}-${string}-${string}-${string}`,
  log: (message: string, meta?: Record<string, unknown>) => void,
  ctx: ChatTurnRequestContext | undefined,
  userMessageId: () => string | null | undefined,
) {
  const assistantRowId = (): string | null => state.assistantMessageId ?? state.draft?.rowId() ?? null

  /**
   * End the turn's trace once: write its summary line, and arm its export for `exportTrace`. A turn handed to a
   * durable owner ends here when this request's live projection ends; the owner settles everything else.
   */
  const endTrace = (failed: boolean, terminalError: unknown): TurnTraceSnapshot => {
    const failureCode = failed
      ? (failureCodeOf(state.lastFailureData) ?? (terminalError instanceof Error ? terminalError.name : 'turn_failed'))
      : undefined
    const snapshot = trace.finish(failureCode === undefined ? {} : { error: failureCode })
    if (state.traceEnded) return snapshot
    state.traceEnded = true
    const handedOff = state.completionHandoff || state.legacyHandoff
    // One line per turn in the host's logs (Workers Logs), so first text and coverage are readable without Intelligence.
    console.info(JSON.stringify({
      event: 'agent_app_turn_trace',
      project: options.projectId,
      executionId,
      otlpTraceId: otlpTraceId(snapshot.traceId),
      failed,
      ...(failureCode ? { failureCode } : {}),
      ...(handedOff ? { handedOff: true } : {}),
      ...(state.gatedTurn ? { gated: true } : {}),
      ...snapshot.summary,
    }))
    // Sent by `exportTrace`, after the turn lock is released: a slow collector must not hold the next send.
    const sink = traceSink
    if (sink) {
      state.pendingTraceExport = () => sink(snapshot, {
        'tangle.sessionId': identity.sessionId,
        'tangle.userId': identity.userId,
        'tangle.tenantId': identity.tenantId,
        'tangle.turn.failed': failed,
        ...(state.gatedTurn ? { 'tangle.turn.gated': true } : {}),
        ...(handedOff ? { 'tangle.turn.handed_off': true } : {}),
        ...(failureCode ? { 'tangle.turn.failure_code': failureCode } : {}),
        ...(traceOptions?.labels?.({ identity, executionId, context }) ?? {}),
      })
    }
    return snapshot
  }

  /** Gated turns report telemetry without claiming that a producer started. */
  const startLifecycle = (gated = false): Promise<void> | undefined => {
    if (gated) state.gatedTurn = true
    state.turnStartedAtMs = Date.now()
    if (!gated) state.turnStarted = true
    const lifecycle = options.lifecycle
    if (!lifecycle?.onTurnStart) return
    return (async () => {
      try {
        await lifecycle.onTurnStart!({
          identity, executionId, turnStreamId, context, startedAt: state.turnStartedAtMs,
          requestReceivedAt: trace.startedAt, admissionMs: state.turnStartedAtMs - trace.startedAt,
        })
      } catch (err) {
        log('[chat-routes] lifecycle.onTurnStart failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  // Exactly one terminal lifecycle hook, after the turn settles (idempotent).
  // Failure is this route's own verdict (`runFailed` from error/failed
  // events, or a drain/sync throw), not the engine's envelope.
  const fireTerminalLifecycle = async (failed: boolean, terminalError: unknown): Promise<void> => {
    if (state.lifecycleSettled) return
    state.lifecycleSettled = true
    // Keep the actual producer cause for server hooks when Runtime emits only a
    // message. A late Stop never replaces a richer failure already observed.
    terminalError ??= state.producerError
    // The trace ends with the turn, before the product's own hooks run, so their work is not in its wall time.
    const snapshot = endTrace(failed, terminalError)
    const lifecycle = options.lifecycle
    const backend = { userMessageId: userMessageId(),
      backendTerminal: Boolean(state.producer) && (state.producer?.terminalObserved?.() ?? true) }
    const durationMs = Date.now() - state.turnStartedAtMs
    const timing = settledTurnTiming(turnStreamId, {
      requestAt: trace.startedAt, startedAt: state.turnStartedAtMs,
      firstVisibleAt: state.firstVisibleAtMs, firstTextAt: state.firstTextAtMs, model: state.producer?.model,
      failure: failed ? { data: state.lastFailureData, error: terminalError } : undefined,
    }, snapshot.summary)
    try {
      if (!lifecycle) {
        // No hooks to run; the trace still goes to its sink below.
      } else if (failed) {
        await lifecycle.onTurnError?.({
          identity, executionId, turnStreamId, context, durationMs, ...timing, ...backend,
          error: terminalError ?? state.lastFailureData ?? new Error('chat turn failed'),
        })
      } else {
        const failoverInfo = state.producer?.modelFailover?.()
        const attribution = state.producer?.modelAttribution?.()
        const completed: ChatTurnLifecycleComplete<TContext> = {
          identity, executionId, turnStreamId, context, durationMs, ...timing, ...backend,
          finalText: state.cancellationAbort?.signal.aborted ? '' : state.producer?.finalText() ?? '',
          usage: state.producer?.usage?.() ?? {},
          assistantMessageId: assistantRowId(),
          ...(state.gatedTurn ? { gated: true } : {}),
          ...(state.producer?.model ? { model: state.producer.model } : {}),
          ...modelAttributionFields(attribution),
          ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
        }
        if (!state.gatedTurn) state.settledTurn = completed
        await lifecycle.onTurnComplete?.(completed)
      }
    } catch (err) {
      log('[chat-routes] lifecycle terminal hook failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** Send the finished trace to its sink. Never throws. */
  const exportTrace = async (): Promise<void> => {
    const send = state.pendingTraceExport
    state.pendingTraceExport = undefined
    if (!send) return
    try {
      await send()
    } catch (err) {
      log('[chat-routes] turn trace sink failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** The product's follow-up work for a turn that ended cleanly, once its lock is released. Never throws. */
  const runAfterSettle = async (): Promise<void> => {
    const info = state.settledTurn
    state.settledTurn = undefined
    const afterSettle = options.lifecycle?.afterSettle
    if (!info || !afterSettle) return
    try {
      await afterSettle(info)
    } catch (err) {
      log('[chat-routes] lifecycle.afterSettle failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** Export after the response is on its way: under `waitUntil` where the host has one. */
  const exportTraceInBackground = (): void => {
    const sent = exportTrace()
    if (ctx?.waitUntil) ctx.waitUntil(sent)
    else void sent.catch(() => { })
  }
  return { endTrace, exportTraceInBackground, startLifecycle, fireTerminalLifecycle, assistantRowId, exportTrace, runAfterSettle }
}

