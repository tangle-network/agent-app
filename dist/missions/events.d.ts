/**
 * Shared mission realtime contract — the single source of truth for the typed
 * events the engine BROADCASTS over a live channel and the client REDUCES into
 * live mission state. Server emit and client reduce import the same module so
 * the wire shape can never drift between the two ends.
 *
 * This module is CLIENT-SAFE: no server imports, no platform globals, no DB
 * types. It is pure data + a pure reducer. Keep it that way — a server-only
 * import here would leak into the browser bundle.
 *
 * Sink contract — best-effort UI notification, never load-bearing:
 *   - fire-and-forget: the engine never awaits `emit` and a sink failure can
 *     never fail a step (the engine wraps every emit). The durable audit-event
 *     row is the authoritative timeline; the socket is a convenience.
 *   - replay-safe: the engine re-emits on a resume/replay. The reducer below is
 *     idempotent + order-tolerant, so a re-sent or duplicated event converges.
 *     The sink itself does no dedupe.
 */
import type { StepAgentActivity } from './agent-activity';
/** Handle mission stream events by processing emitted MissionStreamEvent objects */
export interface MissionEventSink {
    emit(event: MissionStreamEvent): void;
}
/** A sink that drops every event — the engine default when no live channel is
 *  wired (and the unit-test default). */
export declare const noopEventSink: MissionEventSink;
/** Workspace-wide channel id missions broadcast on (alongside any per-thread
 *  channel the product keys). */
export declare const MISSION_CONTROL_CHANNEL_ID = "missions";
/** One plan step as it appears on the wire — only what a live UI needs
 *  (`sublabel` updates travel separately via `step.updated` so the snapshot
 *  stays small). */
export interface MissionStreamStep {
    id: string;
    intent: string;
    kind: string;
    status: MissionStreamStepStatus;
}
/** Define possible status values for a mission stream step */
export type MissionStreamStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting_approval';
/** Define possible statuses representing the current state of a mission stream */
export type MissionStreamStatus = 'scheduled' | 'running' | 'paused' | 'waiting_approval' | 'succeeded' | 'aborted' | 'cancelled' | 'failed';
/**
 * Discriminated union of every live mission event. Every member carries
 * `missionId` (one channel may multiplex several missions) and a `type` the
 * client switches on. `at` is the emitter's wall-clock ms — used only for
 * display ordering; the reducer never trusts it for causality.
 */
export type MissionStreamEvent = {
    type: 'mission.created';
    missionId: string;
    at: number;
    title: string;
    status?: MissionStreamStatus;
    steps: MissionStreamStep[];
    budgetUsd?: number | null;
} | {
    type: 'mission.started';
    missionId: string;
    at: number;
} | {
    type: 'step.started';
    missionId: string;
    at: number;
    stepId: string;
} | {
    type: 'step.updated';
    missionId: string;
    at: number;
    stepId: string;
    sublabel?: string;
    /**
     * Full CURRENT snapshot of the step's delegated runs — never a delta.
     * The reducer replaces the whole lane (latest snapshot wins by `at`), so
     * emitters re-send everything they know each time and at-least-once /
     * out-of-order delivery converges.
     */
    agentActivity?: StepAgentActivity[];
} | {
    type: 'step.completed';
    missionId: string;
    at: number;
    stepId: string;
    ok: boolean;
    reason?: string;
    durationMs?: number;
} | {
    type: 'cost.updated';
    missionId: string;
    at: number;
    spentUsd: number;
    capUsd?: number | null;
} | {
    type: 'mission.paused';
    missionId: string;
    at: number;
    reason?: string;
} | {
    type: 'mission.waiting_approval';
    missionId: string;
    at: number;
    reason?: string;
} | {
    type: 'mission.resumed';
    missionId: string;
    at: number;
} | {
    type: 'mission.plan.updated';
    missionId: string;
    at: number;
    title: string;
    steps: MissionStreamStep[];
    budgetUsd?: number | null;
} | {
    type: 'mission.completed';
    missionId: string;
    at: number;
    ok: boolean;
    status?: Extract<MissionStreamStatus, 'succeeded' | 'failed' | 'aborted' | 'cancelled'>;
    summary?: string;
};
/**
 * Reconstruct the flat MissionStreamEvent from a broadcast envelope of shape
 * `{ type, data: { ...missionFields } }` (transports may also stamp routing
 * fields like workspaceId/threadId into `data`). The envelope `type` is the
 * AUTHORITATIVE discriminant set by the server, so it is spread LAST — a
 * payload that happens to carry a top-level `type` inside `data` cannot shadow
 * it and mis-render as a mission event. Non-mission envelopes and malformed
 * payloads return null and are simply skipped, so one channel can carry both
 * streams.
 */
export declare function parseSessionStreamEnvelope(raw: unknown): MissionStreamEvent | null;
/** Narrow an arbitrary channel payload to a MissionStreamEvent. Returns null
 *  for non-mission events and anything malformed — the reducer skips those. */
export declare function asMissionStreamEvent(value: unknown): MissionStreamEvent | null;
/** Live per-step view the reducer maintains. `status` only ever moves FORWARD
 *  (see STEP_RANK) so a duplicate/out-of-order event can never regress a step
 *  from done back to running. */
export interface MissionStepState {
    id: string;
    intent: string;
    kind: string;
    status: MissionStreamStepStatus;
    sublabel?: string;
    reason?: string;
    durationMs?: number;
    /** Latest delegated-run snapshot for the step (see `step.updated`). */
    agentActivity?: StepAgentActivity[];
    /** The `at` of the snapshot currently held — an older snapshot arriving
     *  late never replaces a newer one. */
    agentActivityAt?: number;
}
/** Live per-mission view the reducer folds events into. */
export interface MissionState {
    missionId: string;
    title?: string;
    status: MissionStreamStatus;
    steps: MissionStepState[];
    spentUsd: number;
    capUsd?: number | null;
    pauseReason?: string;
    summary?: string;
    /** The largest `at` folded so far — purely for display; never gates folding. */
    lastEventAt: number;
    /** The largest pause/resume control `at` folded — lets a newer resume beat an
     *  older pause that arrives late. */
    lastControlAt?: number;
}
/**
 * Fold one event into one mission's state. PURE: returns a new state, mutates
 * nothing. Idempotent + order-tolerant — every status move is clamped through
 * the monotonic ranks above, so duplicates and out-of-order delivery converge
 * to the same terminal state regardless of arrival order.
 */
export declare function applyMissionEvent(prev: MissionState | undefined, event: MissionStreamEvent): MissionState;
/**
 * Merge a loader SEED into the live state for one mission, advancing through
 * the SAME monotonic clamps the event reducer uses. The durable mission row is
 * the authoritative converged state: while the live channel is down the row
 * advances but the frozen live state does not, and nothing re-fires the gap to
 * a reconnecting client. Folding the seed THROUGH the clamps backfills that gap
 * on reconnect while never regressing a more-advanced live value:
 *   - a stale seed for a more-advanced live mission is a no-op,
 *   - an advanced seed after an outage fills the gap (status/steps/spend move
 *     forward to the row's converged state).
 * `live === undefined` (mission unknown to the client) just adopts the seed.
 */
export declare function mergeMissionState(live: MissionState | undefined, seed: MissionState): MissionState;
/**
 * Fold a whole event sequence into a Map<missionId, MissionState>. PURE and
 * order-tolerant: feeding the same events in any order (with duplicates)
 * converges to the same map. `seed` lets a reload start from loader-rehydrated
 * state before live events arrive.
 */
export declare function reduceMissionEvents(events: MissionStreamEvent[], seed?: Map<string, MissionState>): Map<string, MissionState>;
