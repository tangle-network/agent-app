/**
 * Mission trace context — mint + thread the trace ids that join a mission's
 * step attempts and its delegated agent runs into ONE trace tree.
 *
 * ID formats are byte-compatible with agent-runtime's trace propagation
 * (`readTraceContextFromEnv` / OTLP export): 32 lowercase hex chars for a
 * trace id (16 bytes), 16 for a span id (8 bytes). The env pair from
 * {@link traceEnv} is exactly what agent-runtime's MCP subprocess reads at
 * startup (`TRACE_ID` + `PARENT_SPAN_ID`), so a delegation dispatched with it
 * parents its loop→round→iteration spans under the mission's step span.
 *
 * Pure functions, no deps. Ids are DETERMINISTIC when a key is supplied
 * (missionId / step-attempt seed) so a crashed driver re-mints the identical
 * context on re-dispatch and the re-run joins the same trace instead of
 * forking a new one; without a key they are random.
 */

export interface MissionTraceContext {
  /** 32-hex trace id shared by every span in the mission's tree. */
  traceId: string
  /** 16-hex span id of the mission root — the parent of every step span. */
  rootSpanId: string
}

export interface StepSpanContext {
  traceId: string
  /** 16-hex span id of this step attempt (or any nested unit of work). */
  spanId: string
  /** The span this one nests under. */
  parentSpanId: string
}

/**
 * Mint a mission's trace context. With `missionId` the ids are a pure
 * function of it; omitted, both ids are random.
 */
export function createMissionTraceContext(missionId?: string): MissionTraceContext {
  if (missionId !== undefined && missionId !== '') {
    return {
      traceId: hex64(fnv1a64(`mission-trace:${missionId}`)) + hex64(fnv1a64(`mission-trace:2:${missionId}`)),
      rootSpanId: hex64(fnv1a64(`mission-root-span:${missionId}`)),
    }
  }
  return { traceId: randomHex(16), rootSpanId: randomHex(8) }
}

/**
 * Derive a child span context under `parent` — one per step attempt (seed
 * e.g. `"${stepId}#${attempt}"`), or nested under another step span. With a
 * seed the span id is deterministic for the same parent + seed; omitted, it
 * is random.
 */
export function childSpanContext(
  parent: MissionTraceContext | StepSpanContext,
  seed?: string,
): StepSpanContext {
  const parentSpanId = 'rootSpanId' in parent ? parent.rootSpanId : parent.spanId
  const spanId =
    seed !== undefined && seed !== ''
      ? hex64(fnv1a64(`span:${parent.traceId}:${parentSpanId}:${seed}`))
      : randomHex(8)
  return { traceId: parent.traceId, spanId, parentSpanId }
}

/**
 * The env pair a delegation subprocess inherits — agent-runtime's
 * `readTraceContextFromEnv` reads exactly these names. `PARENT_SPAN_ID` is
 * the span the dispatched work nests under: the root for a mission context,
 * the step-attempt span for a step context.
 */
export function traceEnv(ctx: MissionTraceContext | StepSpanContext): {
  TRACE_ID: string
  PARENT_SPAN_ID: string
} {
  return {
    TRACE_ID: ctx.traceId,
    PARENT_SPAN_ID: 'rootSpanId' in ctx ? ctx.rootSpanId : ctx.spanId,
  }
}

// FNV-1a 64-bit over UTF-16 code units — a stable, dependency-free digest for
// deterministic ids. Not cryptographic; trace ids only need uniqueness within
// a tenant's missions, not unforgeability.
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash
}

function hex64(value: bigint): string {
  return value.toString(16).padStart(16, '0')
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
