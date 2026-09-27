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
    traceId: string;
    /** 16-hex span id of the mission root — the parent of every step span. */
    rootSpanId: string;
}
/** Define context information for a step span including trace, span, and parent span identifiers */
export interface StepSpanContext {
    traceId: string;
    /** 16-hex span id of this step attempt (or any nested unit of work). */
    spanId: string;
    /** The span this one nests under. */
    parentSpanId: string;
}
/**
 * Mint a mission's trace context. With `missionId` the ids are a pure
 * function of it; omitted, both ids are random.
 */
export declare function createMissionTraceContext(missionId?: string): MissionTraceContext;
/**
 * Derive a child span context under `parent` — one per step attempt (seed
 * e.g. `"${stepId}#${attempt}"`), or nested under another step span. With a
 * seed the span id is deterministic for the same parent + seed; omitted, it
 * is random.
 */
export declare function childSpanContext(parent: MissionTraceContext | StepSpanContext, seed?: string): StepSpanContext;
/**
 * The env pair a delegation subprocess inherits — agent-runtime's
 * `readTraceContextFromEnv` reads exactly these names. `PARENT_SPAN_ID` is
 * the span the dispatched work nests under: the root for a mission context,
 * the step-attempt span for a step context.
 */
export declare function traceEnv(ctx: MissionTraceContext | StepSpanContext): {
    TRACE_ID: string;
    PARENT_SPAN_ID: string;
};
