// src/eval/index.ts
import { verifyCompletion, extractProducedState, weightedComposite, createLlmCorrectnessChecker } from "@tangle-network/agent-eval";

// src/eval/calibration.ts
async function calibrateGate(gate, cases) {
  const outcomes = [];
  for (const c of cases) {
    let actual;
    let threw;
    try {
      actual = await gate(c.input) ? "accept" : "reject";
    } catch (err) {
      actual = "reject";
      threw = err instanceof Error ? err.message : String(err);
    }
    outcomes.push({ label: c.label, expected: c.expect, actual, ok: actual === c.expect, ...threw ? { threw } : {} });
  }
  const failures = outcomes.filter((o) => !o.ok);
  const hasNegative = cases.some((c) => c.expect === "reject");
  const hasPositive = cases.some((c) => c.expect === "accept");
  const reason = !hasNegative ? "no negative control: every case expects acceptance, so a gate that never refuses would score perfectly" : !hasPositive ? "no positive control: every case expects rejection, so a gate that refuses everything would score perfectly" : failures.length > 0 ? `${failures.length}/${outcomes.length} cases disagreed: ${failures.map((f) => `${f.label} expected ${f.expected}, got ${f.actual}`).join("; ")}` : void 0;
  return { discriminates: reason === void 0, outcomes, failures, ...reason ? { reason } : {} };
}
async function assertGateDiscriminates(name, gate, cases) {
  const report = await calibrateGate(gate, cases);
  if (!report.discriminates) throw new Error(`gate "${name}" is not evidence \u2014 ${report.reason}`);
  return report;
}
async function measureWithControl(opts) {
  const value = await opts.measure();
  const controlValue = await opts.control();
  const measured = opts.count(value);
  const control = opts.count(controlValue);
  return control > 0 ? { canSee: true, measured, control, value } : {
    canSee: false,
    measured,
    control,
    value,
    reason: `probe is blind: the positive control (${opts.controlLabel}) counted 0, so the measured ${measured} carries no information`
  };
}

// src/eval/index.ts
function producedFromToolEvents(events) {
  return events.map(
    (e) => e.type === "proposal_created" ? { type: "proposal_created", proposalId: e.proposalId, title: e.title, status: e.status, content: e.content } : { type: "artifact", artifactId: `vault:${e.path}`, name: e.path, uri: `vault://${e.path}`, mimeType: "text/markdown", content: e.content }
  );
}
var STOPWORDS = /* @__PURE__ */ new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "review", "update", "new", "proposed"]);
function createTokenRecallChecker(opts = {}) {
  const minRecall = opts.minRecall ?? 0.5;
  const minLen = opts.minContentLength ?? 120;
  return async (requirement, content) => {
    const body = content.trim();
    if (body.length < minLen) return { correct: false, reason: `content too thin (${body.length} chars) to be the deliverable` };
    const tokens = requirement.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
    if (tokens.length === 0) return { correct: true, reason: "requirement title has no significant tokens \u2014 structural match accepted" };
    const lower = body.toLowerCase();
    const hits = tokens.filter((t) => lower.includes(t)).length;
    const recall = hits / tokens.length;
    return recall >= minRecall ? { correct: true, reason: `content recalls ${hits}/${tokens.length} requirement tokens` } : { correct: false, reason: `content recalls only ${hits}/${tokens.length} requirement tokens` };
  };
}
export {
  assertGateDiscriminates,
  calibrateGate,
  createLlmCorrectnessChecker,
  createTokenRecallChecker,
  extractProducedState,
  measureWithControl,
  producedFromToolEvents,
  verifyCompletion,
  weightedComposite
};
//# sourceMappingURL=index.js.map