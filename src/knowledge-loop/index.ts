/**
 * `@tangle-network/agent-app/knowledge-loop` — wire the declarative
 * `AgentKnowledgeConfig` to a running, source-grounded, eval-gated knowledge
 * acquisition loop.
 *
 * This module does NOT implement a loop. `@tangle-network/agent-knowledge`
 * already ships `runKnowledgeResearchLoop` — the source-grounded,
 * propose-don't-apply primitive (sources become immutable records first; only
 * accepted `---FILE: knowledge/...---` write blocks are applied; lint +
 * validation + optional readiness gate every iteration). It is pluggable on two
 * seams: a `SourceAdapter[]` (how raw bytes/text become curated source records —
 * text by default, audio/video/image adapters added by the consumer) and a
 * `step` decider (the per-iteration policy: an agentic judge, a sandbox run, or
 * a deterministic gate — the loop deliberately bakes none).
 *
 * `createKnowledgeLoop(config.knowledge, deps)` is the thin mapper between the
 * two:
 *
 *  - `config.knowledge.sources` → adapter selection. The text adapter is the
 *    default; `deps.adapters` is the multimodal seam (prepend an audio/video/
 *    image `SourceAdapter` and the loop ingests that media). agent-app bakes no
 *    media handler — it's a parameter.
 *  - `config.knowledge.loop` → `runKnowledgeResearchLoop` options. `goal` maps
 *    to the loop goal, `minConfidence` to the gate threshold, `freshness` is
 *    threaded to the decider so a per-source-freshness policy can read it.
 *  - `deps.decide` → the pluggable gate. DEFAULT is a reviewer policy
 *    (agent-knowledge's propose-don't-apply posture): a candidate carrying
 *    confidence below `minConfidence` is gated OUT (its proposal text is
 *    dropped — sources are still recorded, because grounding is never the thing
 *    we gate); at/above threshold it is accepted and the loop applies the write
 *    blocks. Swap in an agentic judge or a sandbox run by passing your own
 *    `decide`.
 *  - `deps.driver` → the agent-runtime turn driver (this repo's `../runtime`
 *    `runAppToolLoop` seam, or any compatible driver) the decider invokes for
 *    the loop's agent turns. Optional; a deterministic / sandbox decider needs
 *    no model turns and omits it.
 *
 * Layering: agent-knowledge and agent-runtime are PEER dependencies, never
 * bundled. This module imports only TYPES + the loop entry from agent-knowledge
 * and stays substrate-free behind the `decide` / `driver` / `adapters` seams.
 */

import type {
  AddSourceTextInput,
  KnowledgeResearchLoopContext,
  KnowledgeResearchLoopDecision,
  KnowledgeResearchLoopResult,
  RunKnowledgeResearchLoopOptions,
  SourceAdapter,
} from '@tangle-network/agent-knowledge'
import {
  runKnowledgeResearchLoop,
  textSourceAdapter,
} from '@tangle-network/agent-knowledge'
import type { AgentKnowledgeConfig, KnowledgeSourceSpec } from '../config/index'

/**
 * A research candidate the decider evaluates before the loop applies it. This is
 * the propose-don't-apply unit: notes + the sources discovered this iteration +
 * the proposed write blocks, each carrying a confidence the gate scores against
 * the configured `minConfidence`.
 */
export interface KnowledgeCandidate {
  /** Human-readable research transcript for this iteration. */
  notes?: string
  /**
   * Textual source artifacts to register as immutable sources BEFORE any
   * proposal is applied. Recording these is grounding, not the gated step — a
   * rejected candidate still keeps its sources (so the next iteration is better
   * grounded). The decider may not strip these.
   */
  sourceTexts?: AddSourceTextInput[]
  /** Local files to register as immutable sources (same grounding posture). */
  sourcePaths?: string[]
  /**
   * Safe-write-protocol text (`---FILE: knowledge/...---` blocks). This IS the
   * gated step: the default decider drops it when `confidence < minConfidence`.
   */
  proposalText?: string
  /**
   * Aggregate confidence in this candidate's proposal, in [0, 1]. The default
   * reviewer gate compares this to `minConfidence`. A candidate with no
   * `proposalText` needs no confidence (nothing is gated).
   */
  confidence?: number
  /** The researcher's signal that the goal is met; ends the loop. */
  done?: boolean
  metadata?: Record<string, unknown>
}

/** The verdict a gate returns for one candidate. */
export interface KnowledgeGateVerdict {
  /** Whether the candidate's proposal is accepted (applied) or gated out. */
  accepted: boolean
  /** Why — surfaced in the decision metadata for audit. */
  reason: string
  /** The confidence the gate scored (echoed for telemetry). */
  confidence: number
  /** The threshold it was scored against. */
  minConfidence: number
}

/**
 * The pluggable acquisition policy. Given the loop context (current index, lint,
 * validation, freshness target, the driver), produce a candidate AND a gate
 * verdict on it. This is the seam an agentic judge or a sandbox run plugs into;
 * the default {@link createReviewerDecider} is a confidence gate.
 */
export interface KnowledgeDecider {
  (input: KnowledgeDeciderInput): Promise<KnowledgeDecision> | KnowledgeDecision
}

/** Define the input parameters required to decide knowledge proposals within an agent-knowledge loop */
export interface KnowledgeDeciderInput {
  /** The agent-knowledge loop context for this iteration. */
  context: KnowledgeResearchLoopContext
  /** The acquisition goal (from `config.loop.goal` or a deps fallback). */
  goal: string
  /** The confidence threshold a proposal must clear to be applied. */
  minConfidence: number
  /** The freshness target (`config.loop.freshness`), if set. */
  freshness?: string
  /** The configured sources, for a decider that fetches/selects among them. */
  sources: KnowledgeSourceSpec[]
  /** The agent-runtime turn driver, if one was supplied to the loop. */
  driver?: KnowledgeLoopDriver
}

/** Define a decision containing a candidate and the gate's verdict on that candidate */
export interface KnowledgeDecision {
  /** The candidate the policy produced (may be empty to end the loop). */
  candidate: KnowledgeCandidate
  /** The gate's verdict on the candidate's proposal. */
  verdict: KnowledgeGateVerdict
}

/**
 * The agent-runtime turn driver seam. This is exactly `../runtime`'s
 * `runAppToolLoop` shape (a bounded, awaitable tool-driving turn loop over a
 * model). Typed structurally so a decider can drive the loop's agent turns
 * without this module importing the runtime engine. A deterministic / sandbox
 * decider may omit it.
 */
export interface KnowledgeLoopDriver {
  (opts: {
    systemPrompt: string
    userMessage: string
  }): Promise<{ finalText: string }>
}

/** Define dependencies required to create and run a knowledge processing loop */
export interface CreateKnowledgeLoopDeps {
  /**
   * The knowledge-base root the loop reads/writes (an agent-knowledge layout).
   * Required — agent-knowledge owns disk; agent-app owns only the wiring.
   */
  root: string
  /**
   * The per-iteration policy. Defaults to {@link createReviewerDecider} keyed on
   * the config's `minConfidence`. Pass your own to use an agentic judge or a
   * sandbox run.
   */
  decide?: KnowledgeDecider
  /**
   * Extra source adapters (audio/video/image/PDF/...). The text adapter is
   * always present as the fallback; these are tried first so a multimodal
   * source is claimed by its adapter. This is the multimodal seam.
   */
  adapters?: SourceAdapter[]
  /** The agent-runtime turn driver for the loop's agent turns. */
  driver?: KnowledgeLoopDriver
  /**
   * Fallback goal when `config.loop.goal` is unset. agent-knowledge requires a
   * goal; this keeps the loop runnable for a config with only requirement specs.
   */
  defaultGoal?: string
  /** Default confidence threshold when `config.loop.minConfidence` is unset. */
  defaultMinConfidence?: number
  /** Max research iterations (forwarded to agent-knowledge). Default 3. */
  maxIterations?: number
  /** Actor stamped on the loop's knowledge events. */
  actor?: string
  /** Abort the loop. */
  signal?: AbortSignal
  /** Per-step hook (forwarded to agent-knowledge's `onStep`). */
  onStep?: RunKnowledgeResearchLoopOptions['onStep']
}

/** The handle `createKnowledgeLoop` returns. */
export interface KnowledgeLoop {
  /** Run the acquisition loop to completion and return the agent-knowledge result. */
  run(): Promise<KnowledgeResearchLoopResult>
  /** The resolved goal the loop pursues. */
  readonly goal: string
  /** The resolved confidence gate threshold. */
  readonly minConfidence: number
  /** The adapters the loop uses (consumer extras first, text last). */
  readonly adapters: SourceAdapter[]
}

const DEFAULT_MIN_CONFIDENCE = 0.7
const DEFAULT_GOAL = 'Acquire and ground the knowledge this product requires.'

/**
 * The default gate — agent-knowledge's propose-don't-apply reviewer posture as a
 * confidence threshold. A candidate's `proposalText` is applied only when its
 * `confidence` is at/above `minConfidence`; otherwise the proposal is gated out
 * (sources are still recorded). A candidate with no `proposalText` is trivially
 * accepted (nothing to gate). This is the floor policy; swap in an agentic judge
 * or a sandbox-run decider via `deps.decide` for richer review.
 */
export function reviewCandidate(
  candidate: KnowledgeCandidate,
  minConfidence: number,
): KnowledgeGateVerdict {
  if (!candidate.proposalText) {
    return {
      accepted: true,
      reason: 'no-proposal',
      confidence: candidate.confidence ?? 1,
      minConfidence,
    }
  }
  const confidence = candidate.confidence ?? 0
  if (confidence >= minConfidence) {
    return {
      accepted: true,
      reason: `confidence ${confidence.toFixed(2)} >= minConfidence ${minConfidence.toFixed(2)}`,
      confidence,
      minConfidence,
    }
  }
  return {
    accepted: false,
    reason: `confidence ${confidence.toFixed(2)} < minConfidence ${minConfidence.toFixed(2)}`,
    confidence,
    minConfidence,
  }
}

/**
 * Wrap a candidate-producing policy in the default reviewer gate. The policy
 * decides WHAT to propose (notes, sources, proposalText, confidence); the gate
 * decides whether the proposal is APPLIED. Use this when you have a proposer but
 * want the standard confidence gate; pass a full {@link KnowledgeDecider} to
 * `deps.decide` to own the gate too.
 */
export function createReviewerDecider(
  propose: (
    input: KnowledgeDeciderInput,
  ) => Promise<KnowledgeCandidate> | KnowledgeCandidate,
): KnowledgeDecider {
  return async (input) => {
    const candidate = await propose(input)
    const verdict = reviewCandidate(candidate, input.minConfidence)
    return { candidate, verdict }
  }
}

/**
 * Apply a gate verdict to a candidate, producing the agent-knowledge decision.
 * Grounding (sources) always passes through; the gated `proposalText` is dropped
 * when the verdict rejects it. The verdict is recorded in `metadata.gate` so the
 * loop's event stream carries the audit trail.
 */
function toResearchDecision(decision: KnowledgeDecision): KnowledgeResearchLoopDecision {
  const { candidate, verdict } = decision
  return {
    notes: candidate.notes,
    sourcePaths: candidate.sourcePaths,
    sourceTexts: candidate.sourceTexts,
    proposalText: verdict.accepted ? candidate.proposalText : undefined,
    done: candidate.done,
    metadata: {
      ...(candidate.metadata ?? {}),
      gate: verdict,
    },
  }
}

/**
 * The do-nothing default policy: when no `decide` is supplied, the loop runs
 * with a proposer that proposes nothing and ends immediately. A real product
 * supplies a proposer (agentic judge, sandbox run, or deterministic) via
 * `deps.decide`; this keeps `createKnowledgeLoop` total for a config that only
 * declares sources/requirements without a wired researcher yet.
 */
const noopDecider: KnowledgeDecider = (input) => ({
  candidate: { done: true, notes: 'no decider supplied; nothing proposed' },
  verdict: {
    accepted: true,
    reason: 'no-proposal',
    confidence: 1,
    minConfidence: input.minConfidence,
  },
})

/**
 * Build a runnable knowledge-acquisition loop from the product's
 * `AgentKnowledgeConfig` and a small set of seams. Maps config → agent-knowledge
 * `runKnowledgeResearchLoop` options; never reimplements the loop.
 */
export function createKnowledgeLoop(
  knowledge: AgentKnowledgeConfig,
  deps: CreateKnowledgeLoopDeps,
): KnowledgeLoop {
  const goal = knowledge.loop?.goal ?? deps.defaultGoal ?? DEFAULT_GOAL
  const minConfidence =
    knowledge.loop?.minConfidence ?? deps.defaultMinConfidence ?? DEFAULT_MIN_CONFIDENCE
  const freshness = knowledge.loop?.freshness

  // Multimodal seam: consumer adapters are tried first; the text adapter is the
  // always-present fallback (it claims text/.md/.txt/.json/.csv). A config
  // source whose media an extra adapter claims is ingested by that adapter.
  const adapters: SourceAdapter[] = [...(deps.adapters ?? []), textSourceAdapter]

  const decide = deps.decide ?? noopDecider

  const run = (): Promise<KnowledgeResearchLoopResult> =>
    runKnowledgeResearchLoop({
      root: deps.root,
      goal,
      maxIterations: deps.maxIterations,
      actor: deps.actor,
      signal: deps.signal,
      onStep: deps.onStep,
      sourceOptions: { adapters },
      async step(context) {
        const decision = await decide({
          context,
          goal,
          minConfidence,
          freshness,
          sources: knowledge.sources,
          driver: deps.driver,
        })
        return toResearchDecision(decision)
      },
    })

  return {
    run,
    goal,
    minConfidence,
    adapters,
  }
}
