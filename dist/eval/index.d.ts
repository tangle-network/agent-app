/**
 * Eval — the app-shell BRIDGE to `@tangle-network/agent-eval`, not a reimpl.
 *
 * The completion/scoring ENGINE lives in agent-eval (a peer dependency):
 * `verifyCompletion`, `extractProducedState`, `weightedComposite`,
 * `createLlmCorrectnessChecker`, and the `CompletionRequirement` / `TaskGold` /
 * `ProducedState` types — all re-exported here so a consumer has one import
 * root. This module adds only what agent-eval doesn't have and what is
 * app-shell-specific:
 *
 *   1. {@link producedFromToolEvents} — the bridge: turn the structured app-tool
 *      side channel's `AppToolProducedEvent`s (from a tool runtime executor's
 *      `onProduced`) into the `RuntimeEventLike`s agent-eval's
 *      `extractProducedState` consumes. This is the one piece that knows about
 *      the app-tool channel, so it belongs here, not in the engine.
 *   2. {@link createTokenRecallChecker} — a deterministic, no-LLM
 *      `CorrectnessChecker` (agent-eval ships only the LLM one). For apps/tests
 *      that gate completion without a judge call.
 *
 * Full campaigns (persona simulation, traces, scorecards, held-out gates) are
 * agent-eval's `runEvalCampaign` / `AgentDriver` / `BenchmarkRunner` — use them
 * directly; this module composes with them.
 */
import type { RuntimeEventLike, CompletionRequirement } from '@tangle-network/agent-eval';
import type { AppToolProducedEvent } from '../tools/types';
export { verifyCompletion, extractProducedState, weightedComposite, createLlmCorrectnessChecker } from '@tangle-network/agent-eval';
export { calibrateGate, assertGateDiscriminates, measureWithControl } from './calibration';
export type { CalibrationCase, CalibrationOutcome, CalibrationReport, GateFn, ProbeReport } from './calibration';
export type { CompletionRequirement, TaskGold, ProducedState, SatisfiedBy, CompletionVerdict, CorrectnessChecker, RuntimeEventLike, } from '@tangle-network/agent-eval';
/**
 * Bridge the app-tool side channel's produced events into the runtime-event
 * shape agent-eval's `extractProducedState` reads. Pipe it:
 *   `verifyCompletion(taskGold, extractProducedState(producedFromToolEvents(events)), checker)`
 */
export declare function producedFromToolEvents(events: readonly AppToolProducedEvent[]): RuntimeEventLike[];
/**
 * A deterministic `CorrectnessChecker` (agent-eval exports only
 * `createLlmCorrectnessChecker`). A produced item fulfils a requirement when
 * its content is substantive and recalls ≥ `minRecall` of the requirement
 * title's significant tokens. No network — the default gate for apps/tests
 * without an LLM judge. Pass to `verifyCompletion` as the checker.
 */
export declare function createTokenRecallChecker(opts?: {
    minRecall?: number;
    minContentLength?: number;
}): (requirement: CompletionRequirement, content: string) => Promise<{
    correct: boolean;
    reason: string;
}>;
