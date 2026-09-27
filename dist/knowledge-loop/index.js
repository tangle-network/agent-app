// src/knowledge-loop/index.ts
import {
  runKnowledgeResearchLoop,
  textSourceAdapter
} from "@tangle-network/agent-knowledge";
var DEFAULT_MIN_CONFIDENCE = 0.7;
var DEFAULT_GOAL = "Acquire and ground the knowledge this product requires.";
function reviewCandidate(candidate, minConfidence) {
  if (!candidate.proposalText) {
    return {
      accepted: true,
      reason: "no-proposal",
      confidence: candidate.confidence ?? 1,
      minConfidence
    };
  }
  const confidence = candidate.confidence ?? 0;
  if (confidence >= minConfidence) {
    return {
      accepted: true,
      reason: `confidence ${confidence.toFixed(2)} >= minConfidence ${minConfidence.toFixed(2)}`,
      confidence,
      minConfidence
    };
  }
  return {
    accepted: false,
    reason: `confidence ${confidence.toFixed(2)} < minConfidence ${minConfidence.toFixed(2)}`,
    confidence,
    minConfidence
  };
}
function createReviewerDecider(propose) {
  return async (input) => {
    const candidate = await propose(input);
    const verdict = reviewCandidate(candidate, input.minConfidence);
    return { candidate, verdict };
  };
}
function toResearchDecision(decision) {
  const { candidate, verdict } = decision;
  return {
    notes: candidate.notes,
    sourcePaths: candidate.sourcePaths,
    sourceTexts: candidate.sourceTexts,
    proposalText: verdict.accepted ? candidate.proposalText : void 0,
    done: candidate.done,
    metadata: {
      ...candidate.metadata ?? {},
      gate: verdict
    }
  };
}
var noopDecider = (input) => ({
  candidate: { done: true, notes: "no decider supplied; nothing proposed" },
  verdict: {
    accepted: true,
    reason: "no-proposal",
    confidence: 1,
    minConfidence: input.minConfidence
  }
});
function createKnowledgeLoop(knowledge, deps) {
  const goal = knowledge.loop?.goal ?? deps.defaultGoal ?? DEFAULT_GOAL;
  const minConfidence = knowledge.loop?.minConfidence ?? deps.defaultMinConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const freshness = knowledge.loop?.freshness;
  const adapters = [...deps.adapters ?? [], textSourceAdapter];
  const decide = deps.decide ?? noopDecider;
  const run = () => runKnowledgeResearchLoop({
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
        driver: deps.driver
      });
      return toResearchDecision(decision);
    }
  });
  return {
    run,
    goal,
    minConfidence,
    adapters
  };
}
export {
  createKnowledgeLoop,
  createReviewerDecider,
  reviewCandidate
};
//# sourceMappingURL=index.js.map