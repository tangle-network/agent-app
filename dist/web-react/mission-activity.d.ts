/**
 * Mission + delegation observability surfaces — different nouns, one trace
 * tree:
 *
 *  - {@link MissionActivityLane}: the collapsed sub-rows under a mission step
 *    (what the step's agent is actually doing), expanding to a compact web
 *    waterfall rendered from the `/trace` converters.
 *  - {@link AgentActivityPanel}: the standalone cross-context surface — every
 *    delegation a workspace ran, regardless of which mission (if any) spawned
 *    it — behind a `fetchActivity` data port with cursor + refresh.
 *  - {@link FlowWaterfall}: the web counterpart of `/trace`'s ASCII
 *    `renderWaterfall` (which stays CLI) — proportional bars over a FlowTrace.
 *
 * Same styling contract as the rest of `/web-react`: Tailwind classes against
 * the shared design tokens, inline SVG glyphs, no icon library. The pure
 * layout/merge/format helpers are exported for tests and reuse.
 */
import { type ReactNode } from 'react';
import type { StepAgentActivity } from '../missions/agent-activity';
import type { FlowTrace } from '../trace/index';
export type ActivityTone = 'live' | 'ok' | 'error' | 'neutral';
/** Map a delegation status (free-form string on the wire) to a render tone. */
export declare function activityTone(status: string): ActivityTone;
/** "$0.4000" under a cent shows 4 decimals; null when unknown/zero. */
export declare function formatActivityCost(costUsd?: number): string | null;
/** "8s" / "2m 05s" / "1h 12m"; null when unknown. */
export declare function formatActivityDuration(durationMs?: number): string | null;
/** A delegation record on the cross-context surface; `missionRef` links a
 *  promoted delegation back to the mission/step that spawned it. */
export interface AgentActivityRecord extends StepAgentActivity {
    missionRef?: {
        missionId: string;
        stepId?: string;
        label?: string;
    };
}
export interface AgentActivityPage {
    items: AgentActivityRecord[];
    /** Opaque continuation token; absent ⇒ no further pages. */
    nextCursor?: string;
}
/**
 * Fold a fetched page into the held rows: dedupe by `taskId` with the
 * incoming row winning (a refresh re-fetches the head page, so newer
 * snapshots of in-flight runs replace stale ones), newest `startedAt` first.
 */
export declare function mergeActivityPages(existing: AgentActivityRecord[], incoming: AgentActivityRecord[]): AgentActivityRecord[];
export interface WaterfallRow {
    name: string;
    kind: 'pipeline' | 'model' | 'tool';
    /** Bar geometry as percentages of the trace's total span. */
    offsetPct: number;
    widthPct: number;
    durationLabel: string;
    approx: boolean;
    /** False only when the span's meta carries an explicit failure. */
    ok: boolean;
}
/** Project a FlowTrace into proportional bar geometry for {@link FlowWaterfall}. */
export declare function waterfallLayout(trace: FlowTrace): WaterfallRow[];
export interface FlowWaterfallProps {
    trace: FlowTrace;
}
/** Compact proportional waterfall over a FlowTrace — span name, bar, duration
 *  per row; total + cost in the footer. */
export declare function FlowWaterfall({ trace }: FlowWaterfallProps): import("react").JSX.Element | null;
export interface MissionActivityLaneProps {
    /** The step's delegated-run snapshot (`MissionStepState.agentActivity`). */
    activity: StepAgentActivity[];
    /** Epoch ms origin for the expanded waterfall — usually the step start. */
    startedAt?: number;
    /** Wall clock for extending in-flight runs on the waterfall. */
    nowMs?: number;
}
/**
 * Collapsed sub-rows under a mission step — one row per delegated run —
 * expanding to the step's waterfall. Renders nothing for an empty lane.
 *
 * A sub-row appears because a delegated run STARTED or FINISHED, which is the
 * one kind of list change worth choreographing: it arrives, and the group
 * arrives as a sequence. Keying on `taskId` is what keeps the rest still — the
 * snapshot re-renders every poll, and a row whose status merely advanced holds
 * the DOM node it already had.
 */
export declare function MissionActivityLane({ activity, startedAt, nowMs }: MissionActivityLaneProps): import("react").JSX.Element | null;
export interface AgentActivityPanelProps {
    /** Data port — page through the product's delegation records. Called with
     *  no cursor on mount/refresh, with `nextCursor` for older pages. */
    fetchActivity: (cursor?: string) => Promise<AgentActivityPage>;
    /** Render the mission link for a promoted delegation (chip, anchor, router
     *  Link — the product's routing, not ours). */
    renderMissionRef?: (ref: NonNullable<AgentActivityRecord['missionRef']>, record: AgentActivityRecord) => ReactNode;
    title?: string;
    emptyLabel?: string;
}
export declare function AgentActivityPanel({ fetchActivity, renderMissionRef, title, emptyLabel }: AgentActivityPanelProps): import("react").JSX.Element;
