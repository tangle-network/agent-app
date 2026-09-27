/**
 * Delegation → FlowSpan converters — render what a mission's delegated agent
 * runs actually did as ONE FlowTrace, drawable by the existing
 * `renderWaterfall` (or any viewer that consumes FlowSpans).
 *
 * Two fidelities, one tree:
 *  - COARSE: `delegationActivityToFlowSpans` draws one 'tool' span per
 *    delegation from the StepAgentActivity snapshot (startedAt/durationMs) —
 *    available live, from the step's journaled lane.
 *  - FINE: `loopTraceEventsToFlowSpans` reconstructs agent-runtime's
 *    loop → round → iteration hierarchy from the LoopTraceEvent journal a
 *    delegation persists. FlowSpans carry no parent ids, so nesting rides the
 *    span NAME (`loop ▸ round 0 ▸ iter 1 (coder)`), matching how the ASCII
 *    waterfall reads.
 *
 * `composeMissionFlowTrace` lays a whole mission out: one 'pipeline' span per
 * step, each step's delegations beneath it. Pure data transforms — the
 * structural `LoopTraceEventLike` keeps this module free of the optional
 * agent-runtime peer.
 */
import type { StepAgentActivity } from '../missions/agent-activity';
import type { FlowSpan, FlowTrace } from './flow-types';
/** Structural mirror of agent-runtime's `LoopTraceEvent` — same fields, no
 *  import, so journals parsed from JSON feed straight in. */
export interface LoopTraceEventLike {
    kind: string;
    runId: string;
    /** Epoch ms. */
    timestamp: number;
    payload: object;
}
/**
 * One 'tool' FlowSpan per delegation, positioned relative to `turnStartMs`
 * (the epoch-ms origin of the trace — usually the step or mission start).
 * A row whose `startedAt` does not parse cannot be placed on a timeline and
 * is omitted from the WATERFALL (it stays in the lane itself). A run without
 * `durationMs` is still in flight: its span extends to `opts.nowMs` when
 * given, else renders as a point — `approx` flags both.
 */
export declare function delegationActivityToFlowSpans(activity: StepAgentActivity[], turnStartMs: number, opts?: {
    nowMs?: number;
}): FlowSpan[];
/**
 * Reconstruct one delegation's loop → round → iteration tree from its
 * journaled LoopTraceEvents, as FlowSpans relative to `loop.started` (or the
 * first event). Mirrors agent-runtime's `buildLoopOtelSpans` topology:
 * rounds open on `loop.plan` and flush on the next plan / `loop.decision` /
 * `loop.ended`; iterations span `loop.iteration.started` → `.ended`.
 */
export declare function loopTraceEventsToFlowSpans(events: LoopTraceEventLike[]): FlowSpan[];
/**
 * A single step's activity lane as its own FlowTrace — what a per-step
 * drill-in renders. Origin defaults to the earliest delegation start so the
 * waterfall begins at the lane's first run.
 */
export declare function stepActivityFlowTrace(activity: StepAgentActivity[], opts?: {
    startedAt?: number;
    nowMs?: number;
}): FlowTrace;
/** Define a step in a mission flow with id, intent, optional status, start time, and duration */
export interface MissionFlowStep {
    id: string;
    intent: string;
    status?: string;
    /** Epoch ms the step attempt started. Absent → laid out sequentially after
     *  the previous step (missions run steps in order), `approx` flagged. */
    startedAt?: number;
    durationMs?: number;
}
/**
 * Compose a mission-wide FlowTrace: one 'pipeline' span per step, the step's
 * delegated runs ('tool' spans, from `activity[stepId]`) beneath it. A step
 * span always covers its delegations' extent. Cost is the sum of delegation
 * `costUsd`; token counts are not knowable from the activity lane and stay 0.
 */
export declare function composeMissionFlowTrace(input: {
    steps: MissionFlowStep[];
    /** Delegated-run snapshots keyed by step id (the step's `agentActivity`). */
    activity?: Record<string, StepAgentActivity[]>;
    /** Epoch-ms origin. Default: the earliest known step/delegation start. */
    startedAt?: number;
}): FlowTrace;
