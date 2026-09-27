import {
  emptyPayload,
  markComplete,
  payloadComplete,
  payloadIsStale,
  withAnswer
} from "../chunk-YZ6KQULN.js";
import {
  getQuestion,
  hasAnswer,
  intakeProgress,
  isComplete,
  nextQuestion,
  reachableQuestions,
  validateAnswer
} from "../chunk-JDEGS53O.js";

// src/intakes/context-sufficiency.ts
function presentValue(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function computeContextSufficiency(spec, signals) {
  const facts = spec.facts ?? [];
  const resolvedFacts = signals.facts ?? {};
  const substrate = signals.substrate ?? {};
  const knownFacts = [];
  const missingFacts = [];
  let hasScope = true;
  for (const fact of facts) {
    const value = presentValue(resolvedFacts[fact.key]);
    if (value !== void 0) {
      knownFacts.push({ key: fact.key, label: fact.label, value });
    } else if (fact.required) {
      hasScope = false;
      missingFacts.push({ key: fact.key, label: fact.label, gatherHint: fact.gatherHint });
    }
  }
  const hasSubstrate = Object.values(substrate).some(Boolean);
  return {
    ready: hasScope && hasSubstrate,
    hasScope,
    hasSubstrate,
    knownFacts,
    missingFacts,
    substrate
  };
}
var GATHER_DIRECTIVE = "Do not run an interview. Act on the message first, then fold AT MOST one or two pointed questions into the same turn to close the highest-leverage gap. Never present a form.";
var SUBSTRATE_DIRECTIVE = "You have the scope but no durable substrate to act on yet. As you work, persist what you learn \u2014 that is what makes this context-ready.";
function buildContextGatherPrompt(spec, sufficiency) {
  const lines = [];
  if (sufficiency.knownFacts.length > 0) {
    lines.push("### Context you already have");
    lines.push(sufficiency.knownFacts.map((f) => `- ${f.label}: ${f.value}`).join("\n"));
  }
  if (sufficiency.missingFacts.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("### Context still missing \u2014 gather it while you work, not as a form");
    const gaps = sufficiency.missingFacts.map((f) => f.gatherHint ? `- ${f.label} \u2014 ${f.gatherHint}` : `- ${f.label}`).join("\n");
    lines.push(`You do NOT have:
${gaps}`);
    lines.push(GATHER_DIRECTIVE);
    for (const hint of spec.toolHints ?? []) {
      const trimmed = hint.trim();
      if (trimmed) lines.push(trimmed);
    }
  } else if (!sufficiency.ready) {
    if (lines.length > 0) lines.push("");
    lines.push(SUBSTRATE_DIRECTIVE);
    for (const hint of spec.toolHints ?? []) {
      const trimmed = hint.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  if (lines.length === 0) return "";
  return `## Project Context & Sufficiency
${lines.join("\n")}`;
}
export {
  buildContextGatherPrompt,
  computeContextSufficiency,
  emptyPayload,
  getQuestion,
  hasAnswer,
  intakeProgress,
  isComplete,
  markComplete,
  nextQuestion,
  payloadComplete,
  payloadIsStale,
  reachableQuestions,
  validateAnswer,
  withAnswer
};
//# sourceMappingURL=index.js.map