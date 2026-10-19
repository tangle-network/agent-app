/**
 * A finished turn trace as OTLP spans, sent to Tangle Intelligence.
 *
 * The span builders and the exporter are agent-runtime's (`createOtelExporter`,
 * `toOtelAttributes`, `padTraceId`); this file only maps the turn's tree onto
 * them, using the GenAI semantic-convention keys the runtime's own builders
 * write (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.*`,
 * `gen_ai.tool.name`) and OpenInference's span kind.
 *
 * Server only: it imports the runtime root, which a browser bundle must not.
 */
import {
  createOtelExporter,
  padSpanId,
  padTraceId,
  toOtelAttributes,
  type OtelExporter,
  type OtelSpan,
} from '@tangle-network/agent-runtime'
import { TURN_SPAN_KINDS, type TurnSpanAttrs, type TurnSpanKind, type TurnTraceSink, type TurnTraceSnapshot } from './recorder'

/** OpenInference span kind per turn span: model calls read as LLM, tool calls as TOOL. */
const SPAN_KIND: Partial<Record<string, 'LLM' | 'TOOL'>> = { 'model.call': 'LLM', 'tool.call': 'TOOL' }

const msToNs = (ms: number) => (BigInt(Math.floor(ms)) * 1_000_000n).toString()

/**
 * The root span (`agent_app.turn`) carries the host's labels and the turn's
 * numbers: wall time, the share inside child spans, and the time credited to
 * each kind of span. Children follow under it.
 */
export function buildTurnTraceOtelSpans(snapshot: TurnTraceSnapshot, labels: TurnSpanAttrs = {}): OtelSpan[] {
  const traceId = padTraceId(snapshot.traceId)
  const root = padSpanId(snapshot.rootSpanId)
  const { summary } = snapshot
  const rootAttrs: Record<string, string | number | boolean> = {
    ...labels,
    'openinference.span.kind': 'CHAIN',
    'tangle.execution_id': snapshot.executionId,
    'tangle.trace_id': snapshot.traceId,
    'tangle.started_at_ms': snapshot.startedAt,
    'tangle.completed_at_ms': snapshot.endedAt,
    'tangle.duration_ms': summary.wallMs,
    'tangle.turn.wall_ms': summary.wallMs,
    'tangle.turn.covered_ms': summary.coveredMs,
    'tangle.turn.coverage_pct': summary.coveragePct,
    'tangle.turn.uncovered_ms': summary.uncoveredMs,
    'tangle.turn.largest_gap_ms': summary.largestGapMs,
    'tangle.turn.spans': summary.spans,
    'tangle.turn.model_calls': summary.modelCalls,
    'tangle.turn.tool_calls': summary.toolCalls,
    ...(summary.dropped ? { 'tangle.turn.spans_dropped': summary.dropped } : {}),
    ...Object.fromEntries(TURN_SPAN_KINDS.map((kind: TurnSpanKind) => [`tangle.turn.${kind}_ms`, summary.byKind[kind]])),
  }
  const spans: OtelSpan[] = [{
    traceId,
    spanId: root,
    name: 'agent_app.turn',
    kind: 1,
    startTimeUnixNano: msToNs(snapshot.startedAt),
    endTimeUnixNano: msToNs(snapshot.endedAt),
    attributes: toOtelAttributes(rootAttrs),
    status: snapshot.status === 'ok' ? { code: 1 } : { code: 2, ...(snapshot.error ? { message: snapshot.error } : {}) },
  }]
  for (const span of snapshot.spans) {
    const attrs: Record<string, string | number | boolean> = {
      ...span.attrs,
      'openinference.span.kind': SPAN_KIND[span.name] ?? 'CHAIN',
      'tangle.turn.span_kind': span.kind,
      'agent.parent.confidence': 'explicit',
      ...(span.name === 'tool.call' ? { 'gen_ai.operation.name': 'execute_tool' } : {}),
      ...(span.unfinished ? { 'tangle.turn.unfinished': true } : {}),
      ...(span.error ? { 'error.message': span.error } : {}),
    }
    spans.push({
      traceId,
      spanId: padSpanId(span.spanId),
      parentSpanId: padSpanId(span.parentSpanId),
      name: span.name,
      kind: 1,
      startTimeUnixNano: msToNs(span.startMs),
      endTimeUnixNano: msToNs(span.endMs),
      attributes: toOtelAttributes(attrs),
      status: span.error ? { code: 2, message: span.error } : { code: 1 },
    })
  }
  return spans
}

export interface IntelligenceTurnTraceSinkOptions {
  /** The Intelligence project the spans belong to, e.g. `legal-agent`. */
  project: string
  /** The tenant key the ingest requires. Without one the sink does nothing. */
  apiKey: string | undefined
  /** Default `https://intelligence.tangle.tools`; spans go to `<base>/v1/otlp`. */
  baseUrl?: string
  /** Called with a short reason when a delivery fails. Never receives span content. */
  onError?: (reason: string) => void
}

const DEFAULT_INTELLIGENCE_BASE_URL = 'https://intelligence.tangle.tools'

/**
 * The sink a chat route or a Worker turn hands each finished trace to. The
 * exporter is built on first use, inside a request, because a Worker refuses a
 * timer at module scope. Each trace is flushed before the sink returns, so a
 * host that runs it under `waitUntil` keeps the isolate alive until delivery.
 */
export function createIntelligenceTurnTraceSink(options: IntelligenceTurnTraceSinkOptions): TurnTraceSink {
  let exporter: OtelExporter | undefined
  const exporterFor = (apiKey: string): OtelExporter | undefined => {
    exporter ??= createOtelExporter({
      endpoint: `${(options.baseUrl ?? DEFAULT_INTELLIGENCE_BASE_URL).replace(/\/+$/, '')}/v1/otlp`,
      headers: { authorization: `Bearer ${apiKey}` },
      serviceName: options.project,
      resourceAttributes: { 'tangle.project': options.project },
    })
    return exporter
  }
  return async (snapshot, labels) => {
    if (!options.apiKey) return
    try {
      const sink = exporterFor(options.apiKey)
      if (!sink) return
      for (const span of buildTurnTraceOtelSpans(snapshot, { project: options.project, ...labels })) sink.exportSpan(span)
      await sink.flush()
    } catch (error) {
      try { options.onError?.(error instanceof Error ? error.message.slice(0, 160) : 'turn trace export failed') } catch { /* telemetry only */ }
    }
  }
}
