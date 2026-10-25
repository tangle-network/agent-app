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

/** `doubles` names measurements that stay `doubleValue` when they land on a whole number, so a reader sees one type per key. */
function attributes(record: Record<string, string | number | boolean>, doubles: ReadonlySet<string> = new Set()): OtlpSpan['attributes'] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return []
    return [{
      key,
      value: typeof value === 'number' ? (Number.isInteger(value) && !doubles.has(key) ? { intValue: value.toString() } : { doubleValue: value })
        : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value },
    }]
  })
}

/** The root span's measured numbers: one decimal, so each is always a `doubleValue`. */
const ROOT_MEASUREMENTS: ReadonlySet<string> = new Set([
  'tangle.duration_ms',
  'tangle.turn.wall_ms',
  'tangle.turn.covered_ms',
  'tangle.turn.coverage_pct',
  'tangle.turn.uncovered_ms',
  'tangle.turn.largest_gap_ms',
  'tangle.turn.first_visible_ms',
  'tangle.turn.first_text_ms',
  ...TURN_SPAN_KINDS.map((kind) => `tangle.turn.${kind}_ms`),
])

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
    ...(summary.firstVisibleMs === undefined ? {} : { 'tangle.turn.first_visible_ms': summary.firstVisibleMs }),
    ...(summary.firstTextMs === undefined ? {} : { 'tangle.turn.first_text_ms': summary.firstTextMs }),
    ...(summary.d1Queries === undefined ? {} : { 'tangle.turn.d1_queries': summary.d1Queries }),
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
    attributes: attributes(rootAttrs, ROOT_MEASUREMENTS),
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
  /**
   * The tenant key the ingest requires. Omit it: the sink reads the Sandbox product key from the first of
   * `SANDBOX_PRODUCTION_API_KEY`, `TCLOUD_SANDBOX_API_KEY` and `SANDBOX_API_KEY` that is set, the platform key the
   * ingest verifies. Legal's Worker `TANGLE_API_KEY` got 401 on every export (#468), so a key is never assumed: a refusal is a console warning.
   */
  apiKey?: string
  /** Default `https://intelligence.tangle.tools`; spans go to `<base>/v1/otlp/v1/traces`. */
  baseUrl?: string
  /** Called with a short reason when a delivery fails. Never receives span content. Default: a console warning. */
  onError?: (reason: string) => void
  /** Milliseconds one POST may take (default 5000). */
  timeoutMs?: number
}

const DEFAULT_INTELLIGENCE_BASE_URL = 'https://intelligence.tangle.tools'
/** The Sandbox product key names, in the order the apps' sandbox lanes prefer them. Read per delivery: a Worker's env is not populated at module scope. */
const INGEST_KEY_ENV = ['SANDBOX_PRODUCTION_API_KEY', 'TCLOUD_SANDBOX_API_KEY', 'SANDBOX_API_KEY'] as const

/** The key the ingest verifies, from the host's environment: what the sink uses when it is given none, and what an app's other Intelligence client should use too. */
export function resolveIngestKey(): string | undefined {
  if (typeof process === 'undefined') return undefined
  for (const name of INGEST_KEY_ENV) {
    const value = process.env?.[name]?.trim()
    if (value) return value
  }
  return undefined
}
const SCOPE = { name: '@tangle-network/agent-app', version: 'turn-trace' }

/**
 * The sink a chat route or a Worker turn hands each finished trace to: one OTLP POST per turn, awaited, so a host that
 * runs it under `waitUntil` keeps the isolate alive until delivery. It never throws; every failure, including a missing
 * key and a non-2xx answer, goes to `onError` (a console warning by default), because a silent sink hid Legal's 401s.
 */
export function createIntelligenceTurnTraceSink(options: IntelligenceTurnTraceSinkOptions): TurnTraceSink {
  const url = `${(options.baseUrl ?? DEFAULT_INTELLIGENCE_BASE_URL).replace(/\/+$/, '')}/v1/otlp/v1/traces`
  const report = options.onError ?? ((reason: string) => console.warn(`[turn-trace] export failed: ${reason}`))
  const fail = (reason: string) => { try { report(reason.slice(0, 200)) } catch { /* telemetry only */ } }
  let missingKeyReported = false
  return async (snapshot, labels) => {
    const apiKey = options.apiKey?.trim() || resolveIngestKey()
    if (!apiKey) {
      if (!missingKeyReported) fail(`no ingest key: set ${INGEST_KEY_ENV.join(', ')} or pass apiKey`)
      missingKeyReported = true
      return
    }
    try {
      const body = {
        resourceSpans: [{
          resource: { attributes: attributes({ 'service.name': options.project, 'tangle.project': options.project }) },
          scopeSpans: [{ scope: SCOPE, spans: buildTurnTraceOtelSpans(snapshot, { project: options.project, ...labels }) }],
        }],
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
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
