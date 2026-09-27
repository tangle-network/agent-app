/**
 * Mission execution engine — drives one mission's plan to completion under a
 * SINGLE serialized owner (a Cloudflare Workflow, a Durable Object alarm, a
 * queue consumer — one per mission). The owner wraps each `runStep` call in its
 * durable-step primitive (e.g. Workflows `step.do(step.id, …)`) so a completed
 * step's result is persisted and replayed instead of re-run after a mid-run
 * restart. This module holds the logic that must be correct independent of any
 * runtime, so it is injectable and unit-testable with the dispatch mocked.
 *
 * Idempotency is layered, belt-and-suspenders:
 *   1. The owner's durable-step cache replays a completed step's result.
 *   2. `runStep` re-reads the mission first; a step already `done` (with a
 *      resultRef) returns the cached pointer WITHOUT re-dispatching — this
 *      closes the at-least-once window where a callback re-runs after the
 *      side effect committed but before the owner durably recorded it.
 *   3. The cursor advances only after a step is `done`, so a fresh run resumes
 *      from `mission.cursor` and never re-touches earlier steps.
 *
 * Seams (the product supplies domain; the engine owns mechanism):
 *   - {@link SandboxDispatch} — how a step actually executes.
 *   - {@link MissionEngineOptions.estimateStepCostUsd} — per-step USD estimate.
 *   - {@link MissionGateOptions.classifyStep} — which steps need approval.
 *   - {@link MissionApprovalsPort} — where gate proposals live and how they
 *     resolve.
 */
import type { MissionCostLedger, MissionOutcome, MissionRecord, MissionService, MissionStatus, MissionStep } from './service';
import { type MissionEventSink } from './events';
/**
 * A side-effecting unit of per-step work. The owner supplies the real
 * implementation (e.g. a detached sandbox-session dispatcher); tests supply a
 * mock. MUST return a SMALL pointer — large output is written to the product's
 * storage and only the resultRef is returned.
 */
export type SandboxDispatch = (input: SandboxDispatchInput) => Promise<SandboxDispatchResult>;
/** Define input parameters for dispatching a mission step in the sandbox environment */
export interface SandboxDispatchInput {
    mission: MissionRecord;
    step: MissionStep;
    stepIndex: number;
}
/** Define the result of a completed sandbox dispatch including artifact reference and optional cost details */
export interface SandboxDispatchDoneResult {
    kind?: 'done';
    /** Small pointer at the produced artifact/output (vault path, asset id, exec
     *  digest). Stored on the step as `resultRef`; never the full payload. */
    resultRef: string;
    /** Optional one-line status surfaced on the step row. */
    sublabel?: string;
    /** Optional marginal spend for this step. `ledgerDelta` carries platform-
     *  reported truth (real token counts, wall time); `deltaUsd` is set ONLY when
     *  a provider-authored price is known. Omit fields rather than synthesizing
     *  zeros — the engine substitutes its injected per-step estimate for a
     *  missing deltaUsd and records that estimate in the ledger. */
    cost?: {
        deltaUsd?: number;
        ledgerDelta?: Partial<MissionCostLedger>;
    };
}
/** The dispatched step's detached session is still executing on the platform.
 *  The owner sleeps `pollAfterMs` and re-invokes the step; the dispatch is
 *  idempotent on the session ref, so the re-invocation settles the same session
 *  rather than starting a second run. */
export interface SandboxDispatchInProgressResult {
    kind: 'in_progress';
    sessionRef: string;
    pollAfterMs: number;
    sublabel?: string;
}
/** Resolve the result of a sandbox dispatch as done or in progress */
export type SandboxDispatchResult = SandboxDispatchDoneResult | SandboxDispatchInProgressResult;
/** Outcome of running a single step. `cached` distinguishes a replay/skip
 *  (step was already done) from a fresh execution so the engine and its tests
 *  can assert the dispatch was NOT re-invoked. */
export type StepOutcome = {
    kind: 'done';
    resultRef: string;
    cached: boolean;
} | {
    kind: 'in_progress';
    sessionRef: string;
    pollAfterMs: number;
    sublabel?: string;
} | {
    kind: 'skipped-cursor';
    reason: string;
} | {
    kind: 'failed';
    error: string;
    fatal: boolean;
};
/** Outcome of running the whole plan from the cursor to the end. */
export type PlanOutcome = {
    kind: 'completed';
    summary: string;
} | {
    kind: 'in_progress';
    stepId: string;
    sessionRef: string;
    pollAfterMs: number;
    sublabel?: string;
} | {
    kind: 'failed';
    failedStepId: string;
    error: string;
} | {
    kind: 'halted';
    status: MissionStatus;
    reason?: string | null;
} | {
    kind: 'terminal';
    status: MissionStatus;
} | {
    kind: 'not-found';
};
/** Define options to control mission plan execution with optional pre-step veto logic */
export interface MissionPlanRunOptions {
    /** Pre-step veto (kill switch, schedule window). A non-null return pauses the
     *  mission with that reason before the step's side effect starts. */
    beforeStep?: (mission: MissionRecord, step: MissionStep) => Promise<string | null>;
}
/** Thrown to make the owner's durable-step wrapper retry. The single-owner
 *  invariant makes a genuine concurrent change rare (it means another writer
 *  touched the row), so retrying — rather than corrupting state by forcing a
 *  stale write — is the correct response. Distinct from a task failure, which
 *  is recorded on the step. */
export declare class MissionConcurrencyError extends Error {
    constructor(message: string);
}
/** Thrown by a {@link SandboxDispatch} for a TRANSIENT failure (platform blip,
 *  exec-time network fault) that should be re-attempted. `runStep` RE-THROWS it
 *  so the owner engages its bounded retry+backoff; the step is left `running`
 *  and the re-dispatch is made idempotent by the cached-done guard. A
 *  deterministic failure must be a plain Error instead — that is recorded as a
 *  fatal `failed` step and is never retried (no money-burning loop on a
 *  deterministic error). */
export declare class RetryableStepError extends Error {
    constructor(message: string);
}
/** Resolution states a gate proposal can be in. `approved`/`executed` unblock
 *  the gated step; everything else keeps the mission parked. */
export type MissionProposalResolution = 'pending' | 'approved' | 'rejected' | 'executed' | 'ignored';
/** Define mission gate categories as step, budget, or volume */
export type MissionGateKind = 'step' | 'budget' | 'volume';
/** Product classification of one step. Returned by
 *  {@link MissionGateOptions.classifyStep}; the matching rules (regexes, intent
 *  vocabularies, path allowlists) are product domain and never live here. */
export interface StepGateClassification {
    /** Product approval-type label persisted on the proposal ('generate',
     *  'integration_invoke', …). */
    type: string;
    /** Counted against the per-mission external-action volume cap. */
    externalAction?: boolean;
    estCostUsd?: number | null;
}
/** A gate proposal the engine asks the product to persist. The id is
 *  deterministic per (gate, mission, step) — see the `*ProposalId` helpers —
 *  so a replay re-finds the same proposal instead of duplicating it. The
 *  product composes its own title/description from the structured fields. */
export interface MissionGateProposal {
    id: string;
    missionId: string;
    stepId: string;
    gate: MissionGateKind;
    mission: MissionRecord;
    step: MissionStep;
    /** Present for `gate: 'step'` — the classification that triggered the gate. */
    classification?: StepGateClassification;
    /** Present for `gate: 'budget'`. */
    budget?: {
        spentUsd: number;
        budgetUsd: number;
        estimatedCostUsd: number;
    };
    /** Present for `gate: 'volume'`. */
    volume?: {
        externalActionCount: number;
        cap: number;
    };
}
/** Approval persistence seam — the product implements this over its own
 *  proposal table and resolution flow. */
export interface MissionApprovalsPort {
    /** Resolution of the proposal with this id, or null when none exists. */
    findResolution(proposalId: string): Promise<MissionProposalResolution | null>;
    /** Persist a new gate proposal (id is deterministic; called at most once per
     *  (gate, mission, step) absent a resolution). */
    createProposal(proposal: MissionGateProposal): Promise<void>;
    /** Count of this mission's `gate: 'step'` proposals whose classification was
     *  `externalAction: true` — the denominator of the volume cap. */
    countExternalActionProposals(missionId: string): Promise<number>;
}
/** Define configuration options for mission gating including approvals, step classification, and action limits */
export interface MissionGateOptions {
    approvals: MissionApprovalsPort;
    /** Which steps need human approval, and as what. Return null for an ungated
     *  step. The rules are product domain (intent regexes, kind tables). */
    classifyStep: (step: MissionStep) => StepGateClassification | null;
    /** Max external-action approvals per mission before an approved override is
     *  required to request another. Default 5. */
    externalActionCap?: number;
}
/** Define configuration options for initializing and controlling the mission engine behavior */
export interface MissionEngineOptions {
    service: MissionService;
    /** Per-step USD estimate. Load-bearing twice: the budget gate parks on it
     *  BEFORE a step runs, and the engine records it as the step's spend when the
     *  dispatch reports no provider-authored price — using one estimator keeps
     *  spend and gate consistent. */
    estimateStepCostUsd: (step: MissionStep) => number;
    /** Best-effort live notifier. Fired AFTER each guarded write commits, so a
     *  broadcast always reflects persisted state; re-fired on idempotent replays
     *  so a reconnecting client converges. Never awaited; a throwing sink can
     *  never fail a step. Default: drop everything. */
    sink?: MissionEventSink;
    /** Approval gating. Omitted → no classification/volume gates, and a budget
     *  overrun pauses the mission (fail closed) instead of parking it
     *  waiting_approval behind an override proposal. */
    gates?: MissionGateOptions;
    /** Step kinds whose failure does NOT abort the whole mission — enrichment
     *  steps the plan can complete without. Every other kind is fatal-on-failure.
     *  Default `['optional', 'best-effort']`. */
    nonFatalStepKinds?: readonly string[];
}
/** Resolve mission plan steps with concurrency control and durable state management */
export interface MissionEngine {
    /** Run exactly one plan step. Idempotent: re-invoking for a step already
     *  `done` returns the cached pointer without re-dispatching. A lost guarded
     *  race throws {@link MissionConcurrencyError} so the owner's durable-step
     *  wrapper retries instead of writing a stale value. */
    runStep(missionId: string, stepId: string, dispatch: SandboxDispatch): Promise<StepOutcome>;
    /** Walk the plan from the durable cursor to the end, re-reading the mission
     *  between steps so a pause/stop control that lands while a step is running
     *  is honored before the next side effect. `runStep` is the owner's boundary:
     *  in production `(step) => durableStep.do(step.id, () => engine.runStep(…))`;
     *  in tests `engine.runStep` directly. */
    runPlan(missionId: string, runStep: (step: MissionStep, stepIndex: number) => Promise<StepOutcome>, options?: MissionPlanRunOptions): Promise<PlanOutcome>;
    /** Record spend durable-first, live second: the guarded ledger write commits,
     *  then the sink sees the new total. A guarded failure returns unchanged. */
    recordCost(missionId: string, deltaUsd: number, ledgerDelta?: Partial<MissionCostLedger>): Promise<MissionOutcome<MissionRecord>>;
    /** Pause durable-first, live second (the paused event fires only on a real
     *  edge, not an idempotent re-pause). */
    pauseMission(missionId: string, reason: string): Promise<MissionOutcome<MissionRecord>>;
}
/** Deterministic proposal id for a step-classification gate. */
export declare function stepGateProposalId(missionId: string, stepId: string): string;
/** Deterministic proposal id for a budget-overrun override. */
export declare function budgetGateProposalId(missionId: string, stepId: string): string;
/** Deterministic proposal id for an external-action volume-cap override. */
export declare function volumeGateProposalId(missionId: string, stepId: string): string;
/** Create a mission engine configured with options to manage mission execution and error handling */
export declare function createMissionEngine(options: MissionEngineOptions): MissionEngine;
