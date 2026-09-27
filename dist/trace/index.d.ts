/**
 * `@tangle-network/agent-app/trace` — flow observability for agent turns.
 *
 * The turn buffer stamps `_t` (ms since turn start) on every event, so any
 * live stream OR any historical turn replayed from a TurnEventStore can be
 * reconstructed into a span trace: pipeline overhead, model segments (with
 * thinking TTFT), tool executions, token usage, and cost. Renderers turn
 * traces and multi-run samples into ASCII waterfalls and histograms — the
 * default artifact for "how did this run actually behave" questions across
 * evals, hill-climbs, and production debugging.
 *
 * Span boundaries derived from a buffered stream are quantized by the
 * pump's flush window and the reader's poll cadence (~100–400ms); spans
 * carry `approx: true` to keep reports honest about that.
 */
export * from './mission-trace';
export * from './flow-types';
export * from './mission-flow';
export * from './stage-timing';
import type { FlowTrace } from './flow-types';
/** Represent a timed event with a timestamp and associated event data */
export interface TimedEvent {
    /** ms since turn start (`_t` stamped by pumpBufferedTurn). */
    t: number;
    event: Record<string, unknown>;
}
/** Parse stored turn-event lines (JSON strings with `_t`) into TimedEvents. */
export declare function timedEventsFromLines(lines: string[]): TimedEvent[];
/**
 * Derive a span trace from timestamped turn events. Model segments are runs
 * of text/reasoning deltas; a tool span opens at the last delta before its
 * tool_call emission and closes at the matching tool_result.
 */
export declare function buildFlowTrace(events: TimedEvent[], opts?: {
    pricing?: {
        prompt?: string | number;
        completion?: string | number;
    };
}): FlowTrace;
/** ASCII waterfall cascade — the default artifact for explaining a flow. */
export declare function renderWaterfall(trace: FlowTrace, opts?: {
    width?: number;
}): string;
/** Summarize key statistics of a numerical distribution including count, min, percentiles, and max */
export interface DistributionSummary {
    n: number;
    min: number;
    p50: number;
    p90: number;
    max: number;
}
/** Summarize numeric values into a distribution summary including count, min, median, 90th percentile, and max */
export declare function summarize(values: number[]): DistributionSummary;
/** ASCII histogram for multi-run samples (eval latencies, costs, scores). */
export declare function renderHistogram(values: number[], opts?: {
    buckets?: number;
    width?: number;
    unit?: string;
    format?: (v: number) => string;
}): string;
