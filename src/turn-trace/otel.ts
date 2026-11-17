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
import {
  msToUnixNano, type OtlpSpan, type OtlpTraceExport, otlpTraceExport, readOtlpPartialSuccess, toOtlpAttributes, toW3CTraceId,
} from '@tangle-network/agent-trace-contract/otlp'
import { TURN_SPAN_KINDS, turnTraceId, type TurnSpanAttrs, type TurnSpanKind, type TurnTraceSink, type TurnTraceSnapshot } from './recorder'

export type { OtlpSpan, OtlpTraceExport } from '@tangle-network/agent-trace-contract/otlp'

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
 * A Tangle trace id as the 32-hex OTLP trace id. The rule is agent-trace-contract's `toW3CTraceId`, the one the Sandbox
 * SDK, agent-eval and agent-runtime use too, so every export of the same turn lands in the same OTLP trace.
 */
export function otlpTraceId(traceId: string): string {
  return toW3CTraceId(traceId)
}

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
    startTimeUnixNano: msToUnixNano(snapshot.startedAt),
    endTimeUnixNano: msToUnixNano(snapshot.endedAt),
    attributes: toOtlpAttributes(rootAttrs, { doubles: ROOT_MEASUREMENTS }),
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
      startTimeUnixNano: msToUnixNano(span.startMs),
      endTimeUnixNano: msToUnixNano(span.endMs),
      attributes: toOtlpAttributes(attrs),
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
      const body = otlpTraceExport(
        toOtlpAttributes({ 'service.name': options.project, 'tangle.project': options.project }),
        SCOPE,
        buildTurnTraceOtelSpans(snapshot, { project: options.project, ...labels }),
      )
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      const text = await response.text()
      if (!response.ok) return fail(`HTTP ${response.status} from the OTLP ingest`)
      // A 2xx can still refuse part of a batch (`partialSuccess.rejectedSpans`).
      const { rejectedSpans } = readOtlpPartialSuccess(text)
      if (rejectedSpans > 0) fail(`the OTLP ingest rejected ${rejectedSpans} spans`)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'turn trace export failed')
    }
  }
}

/**
 * One finished turn's spans as an OTLP JSON export, read back from where its sink sent them; null when the store holds
 * no trace for that execution (not exported yet, past retention, or written by another app).
 */
export type TurnTraceReader = (executionId: string, options?: { signal?: AbortSignal }) => Promise<OtlpTraceExport | null>

/** A span as Intelligence's `GET /v1/traces/:traceId/spans` serializes it: resource, scope and span attributes merged. */
interface IntelligenceSpanRow {
  id: string
  parentSpanId?: string | null
  name: string
  startUnixNano: string
  endUnixNano: string
  attributes?: Record<string, unknown> | null
  statusCode?: string | null
}

/**
 * Attributes the reader leaves out: the ones the ingest merged in from the export's resource and scope (the export
 * carries them once, outside the spans), and a failed span's error text, which quotes whatever the thrown error held
 * (an ORM error's parameters, a provider's 400 quoting the prompt). A failed span keeps its error status.
 */
const OMITTED_ATTRS: ReadonlySet<string> = new Set([
  'service.name', 'tangle.project', 'otel.scope.name', 'otel.scope.version', 'otel.original_attributes', 'otel.attribute_collisions',
  // MUTATION: keep error text
])

/**
 * The turn spans `createIntelligenceTurnTraceSink` exported for `executionId`, rebuilt as the OTLP export it posted.
 * Only spans under this package's scope whose root names this execution are kept: a span another exporter wrote into
 * the same trace (a box agent, the Router) can carry prompt or answer text, and this sink's spans carry metadata only.
 */
function turnTraceExport(rows: IntelligenceSpanRow[], executionId: string, project: string): OtlpTraceExport | null {
  const ours = rows.filter((row) =>
    row.attributes?.['otel.scope.name'] === SCOPE.name && row.attributes?.['otel.scope.version'] === SCOPE.version)
  const spanId = (row: IntelligenceSpanRow) => row.id.slice(row.id.lastIndexOf(':') + 1)
  const kept = new Set(ours.filter((row) => row.name === 'agent_app.turn' && row.attributes?.['tangle.execution_id'] === executionId).map(spanId))
  if (kept.size === 0) return null
  // The roots' descendants, whatever order the rows come in.
  for (let size = -1; size !== kept.size;) {
    size = kept.size
    for (const row of ours) if (row.parentSpanId && kept.has(row.parentSpanId)) kept.add(spanId(row))
  }
  const traceId = otlpTraceId(turnTraceId(executionId))
  const spans = ours.filter((row) => kept.has(spanId(row))).map((row): OtlpSpan => {
    const attrs = Object.fromEntries(Object.entries(row.attributes ?? {})
      .filter(([key, value]) => !OMITTED_ATTRS.has(key) && ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean>
    return {
      traceId,
      spanId: spanId(row),
      ...(row.parentSpanId ? { parentSpanId: row.parentSpanId } : {}),
      name: row.name,
      kind: 1,
      startTimeUnixNano: row.startUnixNano,
      endTimeUnixNano: row.endUnixNano,
      attributes: toOtlpAttributes(attrs, row.name === 'agent_app.turn' ? { doubles: ROOT_MEASUREMENTS } : {}),
      status: { code: row.statusCode === 'ERROR' ? 2 : row.statusCode === 'OK' ? 1 : 0 },
    }
  })
  return otlpTraceExport(toOtlpAttributes({ 'service.name': project, 'tangle.project': project }), SCOPE, spans)
}

/**
 * Read a turn's trace back from Tangle Intelligence with the key its sink sends under (the same options), so a chat
 * route can show a turn's owner its own waterfall. Intelligence scopes the read to the key's tenant and redacts at
 * ingest; this keeps only the turn exporter's own spans. Throws when Intelligence refuses or cannot be reached.
 */
export function createIntelligenceTurnTraceReader(options: Omit<IntelligenceTurnTraceSinkOptions, 'onError'>): TurnTraceReader {
  const base = (options.baseUrl ?? DEFAULT_INTELLIGENCE_BASE_URL).replace(/\/+$/, '')
  return async (executionId, { signal } = {}) => {
    const apiKey = options.apiKey?.trim() || resolveIngestKey()
    if (!apiKey) throw new Error(`no Intelligence key: set ${INGEST_KEY_ENV.join(', ')} or pass apiKey`)
    const rows: IntelligenceSpanRow[] = []
    let cursor: string | null = null
    // The recorder keeps at most 1000 spans a turn and Intelligence pages 5000 by default, so one page is the norm.
    for (let page = 0; page < 10; page++) {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const response = await fetch(`${base}/v1/traces/${otlpTraceId(turnTraceId(executionId))}/spans${query}`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 5_000), ...(signal ? [signal] : [])]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} from Intelligence`)
      const body = await response.json() as { items?: IntelligenceSpanRow[]; nextCursor?: string | null }
      rows.push(...(body.items ?? []))
      cursor = body.nextCursor ?? null
      if (!cursor) break
    }
    return turnTraceExport(rows, executionId, options.project)
  }
}
