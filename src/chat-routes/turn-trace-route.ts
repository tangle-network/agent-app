/**
 * A turn's trace for its owner: where `createChatTurnRoutes` sends and reads each turn's spans, the trace fields of
 * the turn receipt, and `routes.trace`, which serves one turn's spans to a caller who may read its thread.
 */
import { deriveExecutionId } from '@tangle-network/agent-runtime/durable'
import { createIntelligenceTurnTraceReader, createIntelligenceTurnTraceSink, otlpTraceId, type TurnTraceReader } from '../turn-trace/otel'
import { turnTraceId, type TurnTraceSink } from '../turn-trace/recorder'
import type { ChatTurnAuthorization, ChatTurnAuthorizeArgs, ChatTurnTraceOptions } from './turn-route-contracts'

/** The route's trace store: every turn goes to Intelligence unless the product turns it off (`turnTrace: false`). */
export function turnTraceWiring<TContext>(projectId: string, turnTrace: ChatTurnTraceOptions<TContext> | false | undefined) {
  const traceOptions = turnTrace === false ? undefined : turnTrace
  const traceSink: TurnTraceSink | undefined = turnTrace === false
    ? undefined
    : (traceOptions?.sink ?? createIntelligenceTurnTraceSink({ project: projectId }))
  // The default sink's store is read back with the same key; a product's own sink names its reader.
  const traceReader: TurnTraceReader | undefined = turnTrace === false
    ? undefined
    : (traceOptions?.read ?? (traceOptions?.sink ? undefined : createIntelligenceTurnTraceReader({ project: projectId })))
  /** The turn receipt's trace fields: the OTLP trace the turn's spans export under, and where its owner reads them. */
  const traceReceipt = (request: Request, executionId: string): Record<string, string> => ({
    ...(traceSink ? { traceId: otlpTraceId(turnTraceId(executionId)) } : {}),
    ...(traceReader
      ? { traceUrl: `${new URL(request.url).pathname.replace(/\/+$/, '')}/turns/${encodeURIComponent(executionId)}/trace` }
      : {}),
  })
  return { traceOptions, traceSink, traceReader, traceReceipt }
}

/** `routes.trace`: the turn's trace for a caller who may read its thread; 404 for anyone else and for a trace not stored yet. */
export function createTurnTraceRoute<TContext>({ projectId, authorize, reader, log }: {
  projectId: string
  authorize(args: ChatTurnAuthorizeArgs): Promise<ChatTurnAuthorization<TContext>>
  reader: TurnTraceReader | undefined
  log(message: string, meta?: Record<string, unknown>): void
}) {
  const notFound = (code: string) =>
    Response.json({ error: 'No trace for this turn.', code }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  return async (request: Request, params: { turnId: string }): Promise<Response> => {
    // A router may hand the id over decoded or not; an execution id always has `:`, its encoded form never does.
    const raw = params.turnId?.trim() ?? ''
    let executionId: string
    try {
      executionId = raw.includes(':') ? raw : decodeURIComponent(raw)
    } catch {
      return notFound('turn_trace_not_found')
    }
    const threadId = executionThreadId(executionId, projectId)
    if (!threadId) return notFound('turn_trace_not_found')
    // Reading a turn's trace is reading its thread: the same check as running-turn discovery, on the product's rows.
    const auth = await authorize({ request, intent: 'running', threadId })
    // Not signed in and the product's own outage stay what they are; every other refusal reads as no such turn.
    if (!auth.ok) return auth.response.status === 401 || auth.response.status >= 500 ? auth.response : notFound('turn_trace_not_found')
    if (auth.intent !== undefined && auth.intent !== 'running') return notFound('turn_trace_not_found')
    if (!reader) return notFound('turn_trace_unreadable')
    let exported: Awaited<ReturnType<TurnTraceReader>>
    try {
      exported = await reader(executionId, { signal: request.signal })
    } catch (err) {
      log('[chat-routes] turn trace read failed', { error: err instanceof Error ? err.message : String(err) })
      return Response.json({ error: 'The trace store did not answer. Try again.', code: 'turn_trace_unavailable' }, { status: 502 })
    }
    if (!exported) return notFound('turn_trace_not_found')
    return Response.json(exported, { headers: { 'Cache-Control': 'private, no-store' } })
  }
}

/** The thread an execution id of this project names (`deriveExecutionId`, then an optional `:retry:<id>`), or null. */
function executionThreadId(executionId: string, projectId: string): string | null {
  const [, session, index] = executionId.split(':')
  if (!session || !/^\d+$/.test(index ?? '')) return null
  try {
    const threadId = decodeURIComponent(session)
    const turnExecutionId = deriveExecutionId({ projectId, sessionId: threadId, turnIndex: Number(index) })
    return executionId === turnExecutionId || executionId.startsWith(`${turnExecutionId}:retry:`) ? threadId : null
  } catch {
    return null // malformed encoding, or a turn index or id deriveExecutionId refuses
  }
}
