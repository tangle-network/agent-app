/**
 * One trace per agent turn: a root span for the turn's wall time and named
 * child spans for where that time went (admission, each model call, each tool
 * call, the box claim and prompt, persistence).
 *
 * This module only records. It has no imports, so the Router engine, the
 * sandbox helpers and the chat route share it from any runtime, a Worker
 * included. `./otel` turns a finished trace into OTLP spans for Tangle
 * Intelligence.
 *
 * The turn's trace id is its execution id in the charset every hop accepts
 * ({@link turnTraceId}), sent as `x-tangle-trace-id` on every Router and
 * Sandbox call, so a Router dispatch row and a sandbox record join the turn's
 * spans by one id.
 */

/** What a span's time is spent on. Each instant of the turn is credited to the deepest open span's kind. */
export type TurnSpanKind =
  | 'admission'
  | 'router'
  | 'model'
  | 'network'
  | 'tool'
  | 'sandbox'
  | 'persist'
  | 'other'

export const TURN_SPAN_KINDS: readonly TurnSpanKind[] = ['admission', 'router', 'model', 'network', 'tool', 'sandbox', 'persist', 'other']

/** Bounded primitive metadata. Never prompts, answers, tool arguments or credentials. */
export type TurnSpanAttrs = Record<string, string | number | boolean>

export interface TurnSpanRecord {
  spanId: string
  /** The root span's id for a top-level child. */
  parentSpanId: string
  name: string
  kind: TurnSpanKind
  startMs: number
  endMs: number
  attrs: TurnSpanAttrs
  /** Set when the span ended in failure; a short code or message, never content. */
  error?: string
  /** True when the turn finished while the span was still open. */
  unfinished?: boolean
}

export interface TurnSpan {
  readonly id: string
  /** Merge attributes. A later value replaces an earlier one. */
  set(attrs: TurnSpanAttrs): TurnSpan
  /** End now. A second call changes nothing. `error` marks the span failed. */
  end(attrs?: TurnSpanAttrs, error?: unknown): void
  /** A child that starts now. */
  child(name: string, kind: TurnSpanKind, attrs?: TurnSpanAttrs): TurnSpan
  /** A child whose times are already known. */
  record(name: string, kind: TurnSpanKind, startMs: number, endMs: number, attrs?: TurnSpanAttrs): TurnSpan
}

/** How much of the turn's wall time is inside named spans, and what the time was spent on. */
export interface TurnTraceSummary {
  traceId: string
  wallMs: number
  /** Wall time inside at least one child span. */
  coveredMs: number
  /** `coveredMs / wallMs` as a percentage, one decimal. */
  coveragePct: number
  uncoveredMs: number
  /** The longest stretch with no span open: where an unnamed wait hides. */
  largestGapMs: number
  /** Wall time credited to the deepest open span's kind. Sums to `coveredMs`. */
  byKind: Record<TurnSpanKind, number>
  spans: number
  modelCalls: number
  toolCalls: number
  /** Spans refused after the per-turn cap. */
  dropped: number
  /** From the request to the first visible text the member could read (see {@link TurnTrace.markFirstText}); absent when none streamed. */
  firstTextMs?: number
  /** D1 round trips in the turn scope, when its binding is instrumented. */
  d1Queries?: number
}

export interface TurnTraceSnapshot {
  traceId: string
  /** The id the root span is exported under. */
  rootSpanId: string
  executionId: string
  startedAt: number
  endedAt: number
  spans: TurnSpanRecord[]
  summary: TurnTraceSummary
  /** `ok`, or the failure the turn ended with. */
  status: 'ok' | 'error'
  error?: string
}

/** Where a finished turn's trace goes. `labels` are the host's metadata for the root span (session, user, workspace). */
export type TurnTraceSink = (snapshot: TurnTraceSnapshot, labels: TurnSpanAttrs) => void | Promise<void>

export interface TurnTrace {
  /** The turn's execution id in the charset the Router and Sandbox accept. Send it as `x-tangle-trace-id`. */
  readonly traceId: string
  readonly executionId: string
  readonly startedAt: number
  /** The span a top-level child hangs from. */
  readonly root: TurnSpan
  /** Name the turn's execution id once it is known. Spans recorded earlier keep their times. */
  bind(executionId: string): void
  start(name: string, kind: TurnSpanKind, attrs?: TurnSpanAttrs, parent?: TurnSpan): TurnSpan
  record(name: string, kind: TurnSpanKind, startMs: number, endMs: number, attrs?: TurnSpanAttrs, parent?: TurnSpan): TurnSpan
  /** Run `work` inside a span; the span ends when it settles, failed if it throws. */
  measure<T>(name: string, kind: TurnSpanKind, work: (span: TurnSpan) => Promise<T> | T, attrs?: TurnSpanAttrs, parent?: TurnSpan): Promise<T>
  /**
   * Note that the turn's first visible text reached the member. The chat route calls it on the first text event of
   * either lane; a product that owns its turn calls it itself. Only the first call counts. The summary's
   * `firstTextMs` then reads from the request, so it holds admission, the box or the Router, and the model.
   */
  markFirstText(at?: number): void
  /** Read the current numbers without ending the trace. */
  summary(now?: number): TurnTraceSummary
  /** Read the spans recorded so far without ending the trace; an open span reads as ending at `now`. */
  spans(now?: number): TurnSpanRecord[]
  /** End the trace: open spans close at `endedAt`, and later spans are refused. A second call returns the first result. */
  finish(outcome?: { error?: unknown; endedAt?: number }): TurnTraceSnapshot
}

export interface CreateTurnTraceOptions {
  /** Epoch ms the turn began (default now). A route passes its request time so admission is inside the trace. */
  startedAt?: number
  executionId?: string
  now?: () => number
  /** Most spans one turn keeps (default 1000); the rest are counted as dropped. */
  maxSpans?: number
  /** Live counter captured by the server turn owner; no Node dependency in the recorder. */
  d1QueryCounter?: { readonly queries: number }
}

const TRACE_ID_PATTERN = /^[\w-]{8,200}$/
const MAX_ATTRS = 48
const MAX_ATTR_STRING = 200

/** True when the Router and the Sandbox API keep this id as a `x-tangle-trace-id`. */
export function isTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value)
}

/**
 * The turn's execution id as a trace id. Execution ids carry `:` (`app:session:turn`),
 * which the Router drops from `x-tangle-trace-id`, so every character outside
 * `[A-Za-z0-9_-]` becomes `_`. An id already in the charset is returned as it is.
 */
export function turnTraceId(executionId: string): string {
  // An id in the charset is the caller's own, whatever its length (the Router drops one under 8 characters; it is not rewritten here).
  if (/^[\w-]{1,200}$/.test(executionId)) return executionId
  const id = executionId.replace(/[^\w-]/g, '_').slice(0, 200)
  return id.length >= 8 ? id : id.padEnd(8, '_')
}

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes)
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(out)
  else for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256)
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('')
}

function boundedAttrs(attrs: TurnSpanAttrs): TurnSpanAttrs {
  const out: TurnSpanAttrs = {}
  let count = 0
  for (const [key, value] of Object.entries(attrs)) {
    if (count >= MAX_ATTRS) break
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key.slice(0, 80)] = typeof value === 'string' ? value.slice(0, MAX_ATTR_STRING) : value
    count++
  }
  return out
}

function errorText(error: unknown): string {
  if (error instanceof Error) return (error.name === 'Error' ? error.message : `${error.name}: ${error.message}`).slice(0, MAX_ATTR_STRING)
  return String(error).slice(0, MAX_ATTR_STRING)
}

const zeroKinds = (): Record<TurnSpanKind, number> => ({
  admission: 0, router: 0, model: 0, network: 0, tool: 0, sandbox: 0, persist: 0, other: 0,
})

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * Coverage and the per-kind split for a set of spans over `[startMs, endMs]`.
 * Exported for a reader that holds the spans of a finished trace.
 */
export function summarizeTurnSpans(
  spans: readonly Pick<TurnSpanRecord, 'spanId' | 'parentSpanId' | 'kind' | 'name' | 'startMs' | 'endMs'>[],
  rootSpanId: string,
  startMs: number,
  endMs: number,
  traceId: string,
  dropped = 0,
): TurnTraceSummary {
  const wallMs = Math.max(0, endMs - startMs)
  const parent = new Map(spans.map((span) => [span.spanId, span.parentSpanId]))
  const depthOf = (id: string): number => {
    let depth = 0
    for (let at = parent.get(id); at !== undefined && at !== rootSpanId; at = parent.get(at)) {
      depth++
      if (depth > 64) break
    }
    return depth
  }
  const clipped = spans
    .map((span) => ({ span, start: Math.max(startMs, span.startMs), end: Math.min(endMs, span.endMs), depth: depthOf(span.spanId) }))
    .filter((entry) => entry.end > entry.start)
  const points = [...new Set([startMs, endMs, ...clipped.flatMap((entry) => [entry.start, entry.end])])].sort((a, b) => a - b)
  const byKind = zeroKinds()
  let coveredMs = 0
  let largestGapMs = 0
  let gap = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i]!
    const to = points[i + 1]!
    let deepest: (typeof clipped)[number] | undefined
    for (const entry of clipped) {
      if (entry.start <= from && entry.end >= to && (!deepest || entry.depth > deepest.depth || (entry.depth === deepest.depth && entry.start > deepest.start))) deepest = entry
    }
    if (deepest) {
      byKind[deepest.span.kind] += to - from
      coveredMs += to - from
      gap = 0
    } else {
      gap += to - from
      largestGapMs = Math.max(largestGapMs, gap)
    }
  }
  for (const kind of TURN_SPAN_KINDS) byKind[kind] = round1(byKind[kind])
  return {
    traceId,
    wallMs: round1(wallMs),
    coveredMs: round1(coveredMs),
    coveragePct: wallMs > 0 ? round1((coveredMs / wallMs) * 100) : 0,
    uncoveredMs: round1(wallMs - coveredMs),
    largestGapMs: round1(largestGapMs),
    byKind,
    spans: spans.length,
    modelCalls: spans.filter((span) => span.name === 'model.call').length,
    toolCalls: spans.filter((span) => span.name === 'tool.call').length,
    dropped,
  }
}

export function createTurnTrace(options: CreateTurnTraceOptions = {}): TurnTrace {
  const now = options.now ?? Date.now
  const startedAt = options.startedAt ?? now()
  const maxSpans = options.maxSpans ?? 1000
  const rootId = randomHex(8)
  let executionId = options.executionId ?? `pending_${randomHex(6)}`
  let traceId = turnTraceId(executionId)
  const records = new Map<string, TurnSpanRecord>()
  const open = new Set<string>()
  let dropped = 0
  let finished: TurnTraceSnapshot | undefined
  let firstTextAt: number | undefined

  // A refused or late span still returns a handle, so instrumentation never branches on the trace's state.
  const inert = (id: string): TurnSpan => {
    const handle: TurnSpan = {
      id,
      set: () => handle,
      end: () => {},
      child: () => inert(rootId),
      record: () => inert(rootId),
    }
    return handle
  }

  const handleFor = (id: string): TurnSpan => {
    const handle: TurnSpan = {
      id,
      set(attrs) {
        const record = records.get(id)
        if (record && !finished) record.attrs = boundedAttrs({ ...record.attrs, ...attrs })
        return handle
      },
      end(attrs, error) {
        const record = records.get(id)
        if (!record || !open.has(id) || finished) return
        open.delete(id)
        record.endMs = Math.max(record.startMs, now())
        if (attrs) record.attrs = boundedAttrs({ ...record.attrs, ...attrs })
        if (error !== undefined) record.error = errorText(error)
      },
      child: (name, kind, attrs) => trace.start(name, kind, attrs, handle),
      record: (name, kind, start, end, attrs) => trace.record(name, kind, start, end, attrs, handle),
    }
    return handle
  }

  const add = (name: string, kind: TurnSpanKind, startMs: number, endMs: number | undefined, attrs: TurnSpanAttrs | undefined, parent: TurnSpan | undefined): TurnSpan => {
    if (finished) return inert(rootId)
    if (records.size >= maxSpans) {
      dropped++
      return inert(rootId)
    }
    const spanId = randomHex(8)
    records.set(spanId, {
      spanId,
      parentSpanId: parent && parent.id !== spanId ? parent.id : rootId,
      name: name.slice(0, 80),
      kind,
      startMs,
      endMs: endMs ?? startMs,
      attrs: attrs ? boundedAttrs(attrs) : {},
    })
    if (endMs === undefined) open.add(spanId)
    return handleFor(spanId)
  }

  const rootHandle: TurnSpan = {
    id: rootId,
    set: () => rootHandle,
    end: () => {},
    child: (name, kind, attrs) => trace.start(name, kind, attrs),
    record: (name, kind, start, end, attrs) => trace.record(name, kind, start, end, attrs),
  }

  const withMeasurements = (summary: TurnTraceSummary): TurnTraceSummary => ({
    ...summary,
    ...(firstTextAt === undefined ? {} : { firstTextMs: round1(firstTextAt - startedAt) }),
    ...(options.d1QueryCounter === undefined ? {} : { d1Queries: options.d1QueryCounter.queries }),
  })

  const trace: TurnTrace = {
    get traceId() { return traceId },
    get executionId() { return executionId },
    startedAt,
    root: rootHandle,
    bind(id) {
      executionId = id
      traceId = turnTraceId(id)
    },
    start: (name, kind, attrs, parent) => add(name, kind, now(), undefined, attrs, parent),
    record: (name, kind, startMs, endMs, attrs, parent) => add(name, kind, startMs, Math.max(startMs, endMs), attrs, parent),
    async measure(name, kind, work, attrs, parent) {
      const span = trace.start(name, kind, attrs, parent)
      try {
        const result = await work(span)
        span.end()
        return result
      } catch (error) {
        span.end(undefined, error)
        throw error
      }
    },
    markFirstText(at) {
      if (finished || firstTextAt !== undefined) return
      firstTextAt = Math.max(startedAt, at ?? now())
    },
    summary(at) {
      if (finished) return finished.summary
      const end = at ?? now()
      return withMeasurements(summarizeTurnSpans(trace.spans(end), rootId, startedAt, end, traceId, dropped))
    },
    spans(at) {
      const end = at ?? finished?.endedAt ?? now()
      return [...records.values()].map((record) => open.has(record.spanId) ? { ...record, endMs: end } : { ...record })
    },
    finish(outcome) {
      if (finished) return finished
      const endedAt = Math.max(startedAt, outcome?.endedAt ?? now())
      for (const id of open) {
        const record = records.get(id)!
        record.endMs = Math.max(record.startMs, endedAt)
        record.unfinished = true
      }
      open.clear()
      const spans = [...records.values()].sort((a, b) => a.startMs - b.startMs)
      finished = {
        traceId,
        rootSpanId: rootId,
        executionId,
        startedAt,
        endedAt,
        spans,
        summary: withMeasurements(summarizeTurnSpans(spans, rootId, startedAt, endedAt, traceId, dropped)),
        status: outcome?.error === undefined ? 'ok' : 'error',
        ...(outcome?.error === undefined ? {} : { error: errorText(outcome.error) }),
      }
      return finished
    },
  }
  return trace
}
