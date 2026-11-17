/**
 * The OTLP JSON `routes.trace` answers, projected onto the trace inspector (charts `FlowTrace`) on the turn's own
 * clock, and the trace URL of a turn in history. No React: the drawer renders it, and a test reads the route's answer
 * through it.
 */
import type { FlowSpan, FlowTrace } from '@tangle-network/charts'
import { decodeOtlpTraceExport, type OtlpDecodedValue } from '@tangle-network/agent-trace-contract/otlp'
import { executionIdOfAssistantRow, turnTraceUrl } from '../turn-trace/url'

/** The trace URL of the turn an assistant row answered, from the path the client posts turns to; null for a row the
 *  chat route did not key by its execution id. */
export function turnTraceUrlForMessage(turnPath: string, messageId: string): string | null {
  const executionId = executionIdOfAssistantRow(messageId)
  return executionId ? `${turnPath}/turns/${executionId}/trace` : null // MUTATION: unencoded
}

const num = (value: OtlpDecodedValue | undefined): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const nanosToMs = (nanos: string | undefined): number => (nanos ? Number(BigInt(nanos) / 1000n) / 1000 : 0)

/** What the inspector shows for each kind of turn span: the turn is the agent row, model and tool calls are theirs, and
 *  every other step (admission, network, the Router, the box, persistence) is a wait the member sat through. */
function flowKind(name: string, spanKind: OtlpDecodedValue | undefined, isRoot: boolean): FlowSpan['kind'] {
  if (isRoot) return 'pipeline'
  if (spanKind === 'model' || name === 'model.call') return 'model'
  if (spanKind === 'tool' || name === 'tool.call') return 'tool'
  return 'waiting'
}

export interface TurnTraceFlow {
  flow: FlowTrace
  traceId: string
  wallMs?: number
  coveragePct?: number
  firstVisibleMs?: number
  firstTextMs?: number
}

/** The OTLP JSON `routes.trace` answers, projected onto the inspector's trace on the turn's own clock. Null when it holds
 *  no turn root. */
export function turnTraceFlow(exported: unknown): TurnTraceFlow | null {
  const spans = decodeOtlpTraceExport(exported)
  const root = spans.find((span) => span.name === 'agent_app.turn' && !span.parent_span_id)
  if (!root) return null
  const origin = nanosToMs(root.start_time_unix_nano)
  const attr = root.span_attributes
  const flow: FlowSpan[] = spans.map((span) => {
    const a = span.span_attributes
    const isRoot = span === root
    const detail = a['gen_ai.request.model'] ?? a['gen_ai.tool.name']
    const promptTokens = num(a['gen_ai.usage.input_tokens'])
    const completionTokens = num(a['gen_ai.usage.output_tokens'])
    const cachedTokens = num(a['gen_ai.usage.cache_read.input_tokens'])
    return {
      id: span.span_id,
      ...(!isRoot && span.parent_span_id ? { parentId: span.parent_span_id } : {}),
      kind: flowKind(span.name, a['tangle.turn.span_kind'], isRoot),
      name: isRoot ? 'Turn' : span.name,
      startMs: nanosToMs(span.start_time_unix_nano) - origin,
      endMs: nanosToMs(span.end_time_unix_nano) - origin,
      status: span.status_code === 2 ? 'failed' : 'done',
      ...(typeof detail === 'string' && !isRoot ? { detail } : {}),
      ...(isRoot && typeof a['gen_ai.request.model'] === 'string' ? { detail: a['gen_ai.request.model'] } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      ...(a.approx === true ? { approx: true } : {}),
    }
  })
  const modelCalls = num(attr['tangle.turn.model_calls'])
  const toolCalls = num(attr['tangle.turn.tool_calls'])
  const wallMs = num(attr['tangle.turn.wall_ms'])
  const coveragePct = num(attr['tangle.turn.coverage_pct'])
  const firstVisibleMs = num(attr['tangle.turn.first_visible_ms'])
  const firstTextMs = num(attr['tangle.turn.first_text_ms'])
  return {
    traceId: root.trace_id,
    flow: {
      spans: flow,
      totalMs: nanosToMs(root.end_time_unix_nano) - origin,
      ...(modelCalls !== undefined ? { modelCalls } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      errors: flow.filter((span) => span.status === 'failed').length,
    },
    ...(wallMs !== undefined ? { wallMs } : {}),
    ...(coveragePct !== undefined ? { coveragePct } : {}),
    ...(firstVisibleMs !== undefined ? { firstVisibleMs } : {}),
    ...(firstTextMs !== undefined ? { firstTextMs } : {}),
  }
}
