/**
 * A finished turn trace as OTLP spans, sent to Tangle Intelligence.
 *
 * The attribute vocabulary is the one agent-runtime's span builders write
 * (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.*`,
 * `gen_ai.tool.name`, OpenInference's span kind, `agent.parent.confidence`), and
 * the wire shape is the one its `createOtelExporter` posts to
 * `<base>/v1/otlp/v1/traces`.
 *
 * It does not import agent-runtime. The runtime root pulls the whole sandbox
 * SDK into a Worker bundle, and the SDK's chain client imports `viem`, which a
 * Worker build cannot resolve (Hospitality's release failed on exactly that);
 * and its exporter keeps a timer a Worker refuses at module scope. One OTLP
 * POST per finished turn needs neither.
 */
import { TURN_SPAN_KINDS, type TurnSpanAttrs, type TurnSpanKind, type TurnTraceSink, type TurnTraceSnapshot } from './recorder'

/** One OTLP/JSON span, as Intelligence's ingest reads it. */
export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } }>
  status: { code: number; message?: string }
}

function attributes(record: Record<string, string | number | boolean>): OtlpSpan['attributes'] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return []
    return [{
      key,
      value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: value.toString() } : { doubleValue: value })
        : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value },
    }]
  })
}

/**
 * A Tangle trace id as the 32-hex OTLP trace id. The mapping is the Sandbox SDK's `otelTraceIdForTangleTrace`, so a
 * Sandbox trace export of the same turn lands in the same OTLP trace. An id that is already 32 hex, or a UUID, is used as it is.
 */
export function otlpTraceId(traceId: string): string {
  if (/^[0-9a-f]{32}$/.test(traceId)) return traceId
  const dashless = traceId.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/.test(dashless)) return dashless
  return hexId(traceId, 32)
}

function hexId(input: string, length: number): string {
  const hashes = [2166136261, 2654435769, 2246822507, 3266489909]
  for (const byte of new TextEncoder().encode(input)) {
    for (let lane = 0; lane < hashes.length; lane += 1) hashes[lane] = Math.imul((hashes[lane] as number) ^ (byte + lane), 16777619)
  }
  let out = hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, '0')).join('')
  while (out.length < length) out += hexId(`${input}:${out.length}`, 32)
  return out.slice(0, length)
}

const msToNs = (ms: number) => (BigInt(Math.floor(ms)) * 1_000_000n).toString()

/** OpenInference span kind per turn span: model calls read as LLM, tool calls as TOOL. */
const SPAN_KIND: Partial<Record<string, 'LLM' | 'TOOL'>> = { 'model.call': 'LLM', 'tool.call': 'TOOL' }

/**
 * The root span (`agent_app.turn`) carries the host's labels and the turn's
 * numbers: wall time, the share inside child spans, and the time credited to
 * each kind of span. Children follow under it.
 */
export function buildTurnTraceOtelSpans(snapshot: TurnTraceSnapshot, labels: TurnSpanAttrs = {}): OtlpSpan[] {
  const traceId = otlpTraceId(snapshot.traceId)
  const root = snapshot.rootSpanId
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
  const spans: OtlpSpan[] = [{
    traceId,
    spanId: root,
    name: 'agent_app.turn',
    kind: 1,
    startTimeUnixNano: msToNs(snapshot.startedAt),
    endTimeUnixNano: msToNs(snapshot.endedAt),
    attributes: attributes(rootAttrs),
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
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: 1,
      startTimeUnixNano: msToNs(span.startMs),
      endTimeUnixNano: msToNs(span.endMs),
      attributes: attributes(attrs),
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
  /** Default `https://intelligence.tangle.tools`; spans go to `<base>/v1/otlp/v1/traces`. */
  baseUrl?: string
  /** Called with a short reason when a delivery fails. Never receives span content. */
  onError?: (reason: string) => void
  /** Milliseconds one POST may take (default 5000). */
  timeoutMs?: number
}

const DEFAULT_INTELLIGENCE_BASE_URL = 'https://intelligence.tangle.tools'
const SCOPE = { name: '@tangle-network/agent-app', version: 'turn-trace' }

/**
 * The sink a chat route or a Worker turn hands each finished trace to: one OTLP POST per turn, awaited, so a host that
 * runs it under `waitUntil` keeps the isolate alive until delivery. It never throws; a failure goes to `onError`.
 */
export function createIntelligenceTurnTraceSink(options: IntelligenceTurnTraceSinkOptions): TurnTraceSink {
  const url = `${(options.baseUrl ?? DEFAULT_INTELLIGENCE_BASE_URL).replace(/\/+$/, '')}/v1/otlp/v1/traces`
  const fail = (reason: string) => { try { options.onError?.(reason.slice(0, 200)) } catch { /* telemetry only */ } }
  return async (snapshot, labels) => {
    if (!options.apiKey) return
    try {
      const body = {
        resourceSpans: [{
          resource: { attributes: attributes({ 'service.name': options.project, 'tangle.project': options.project }) },
          scopeSpans: [{ scope: SCOPE, spans: buildTurnTraceOtelSpans(snapshot, { project: options.project, ...labels }) }],
        }],
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      const text = await response.text()
      if (!response.ok) return fail(`HTTP ${response.status} from the OTLP ingest`)
      // A 2xx can still refuse part of a batch (`partialSuccess.rejectedSpans`).
      const rejected = Number((JSON.parse(text || '{}') as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess?.rejectedSpans ?? 0)
      if (rejected > 0) fail(`the OTLP ingest rejected ${rejected} spans`)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'turn trace export failed')
    }
  }
}
