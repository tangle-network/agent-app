// src/profile/budget.ts
var DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 4e4;
function assertBudgetPolicy(budget) {
  const raisedCap = budget.maxSystemPromptBytes !== void 0 && budget.maxSystemPromptBytes > DEFAULT_MAX_SYSTEM_PROMPT_BYTES;
  if (!raisedCap && !budget.warnOnly) return;
  if ((budget.overBudgetReason ?? "").trim() !== "") return;
  const weakened = raisedCap ? `maxSystemPromptBytes ${budget.maxSystemPromptBytes} exceeds the ${DEFAULT_MAX_SYSTEM_PROMPT_BYTES}-byte default` : "warnOnly downgrades the over-budget throw to a warning";
  throw new Error(
    `${weakened} without an overBudgetReason. Oversized system prompts degrade toward empty answers, so the cap is not a formality. Before raising it: rank the prompt with largestPromptSections() \u2014 reference material (playbooks, checklists, corpora) belongs in resources.files via corpusSkills()/userSkillMounts() or composeSkills({ mode: 'mounted' }), which puts the bodies on disk in the sandbox and leaves a short index in the prompt. Only content the agent must obey without a tool call should stay inline. If the prompt is genuinely irreducible, set overBudgetReason to the sentence that says so.`
  );
}
function largestPromptSections(prompt, top = 3) {
  const encoder = new TextEncoder();
  const sections = [];
  let title = "(preamble)";
  let start = 0;
  const flush = (end) => {
    const body = prompt.slice(start, end);
    if (body.trim()) sections.push({ title, bytes: encoder.encode(body).byteLength });
  };
  const headingRe = /^#{1,6}\s+(.+)$/gm;
  for (const match of prompt.matchAll(headingRe)) {
    flush(match.index);
    title = (match[1] ?? "").trim() || "(untitled section)";
    start = match.index;
  }
  flush(prompt.length);
  return sections.sort((a, b) => b.bytes - a.bytes).slice(0, top);
}
function assertSystemPromptWithinBudget(systemPrompt, budget = {}, origin = "composed systemPrompt") {
  assertBudgetPolicy(budget);
  const max = budget.maxSystemPromptBytes ?? DEFAULT_MAX_SYSTEM_PROMPT_BYTES;
  const bytes = new TextEncoder().encode(systemPrompt).byteLength;
  if (bytes <= max) return;
  const sections = largestPromptSections(systemPrompt).map((s) => `"${s.title}" (${s.bytes}B)`).join(", ");
  const message = `${origin} is ${bytes} bytes \u2014 over the ${max}-byte budget (oversized prompts degrade to empty answers). ` + (sections ? `Largest sections: ${sections}. ` : "") + `Move reference material to resources.files (corpusSkills/userSkillMounts, or composeSkills({ mode: 'mounted' })) so the bodies land on disk in the sandbox and the prompt keeps only an index; keep inline only what the agent must obey without a tool call. Raising maxSystemPromptBytes requires an overBudgetReason.`;
  if (budget.warnOnly) {
    console.warn(`[profile] ${message}`);
    return;
  }
  throw new Error(message);
}
function assertProfilePromptWithinBudget(profile, budget = {}, origin = "profile systemPrompt", hint = "") {
  const systemPrompt = profile?.prompt?.systemPrompt;
  if (typeof systemPrompt !== "string") return;
  try {
    assertSystemPromptWithinBudget(systemPrompt, budget, origin);
  } catch (err) {
    if (!hint) throw err;
    throw new Error(`${err.message} ${hint}`, { cause: err });
  }
}

// src/profile/fingerprint.ts
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function fingerprintAgentProfile(profile, context) {
  const systemPrompt = profile.prompt?.systemPrompt ?? "";
  const promptSha = await sha256Hex(systemPrompt);
  const mcpKeys = Object.keys(profile.mcp ?? {}).sort();
  const subagentNames = Object.keys(profile.subagents ?? {}).sort();
  const fileMountPaths = (profile.resources?.files ?? []).map((mount) => mount.path).sort();
  const connectionIds = (profile.connections ?? []).map((connection) => connection.alias ? `${connection.connectionId}:${connection.alias}` : connection.connectionId).sort();
  const hash = await sha256Hex(
    JSON.stringify([
      promptSha,
      mcpKeys,
      subagentNames,
      fileMountPaths,
      connectionIds,
      context?.model ?? null,
      context?.harness ?? null
    ])
  );
  return {
    hash,
    promptSha,
    promptBytes: new TextEncoder().encode(systemPrompt).length,
    mcpKeys,
    subagentNames,
    fileMountPaths,
    connectionIds,
    model: context?.model,
    harness: context?.harness
  };
}
function channelValue(fingerprint, channel) {
  const value = fingerprint[channel];
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(",");
  return String(value ?? "(unset)");
}
var DRIFT_CHANNELS = [
  "promptSha",
  "promptBytes",
  "mcpKeys",
  "subagentNames",
  "fileMountPaths",
  "connectionIds",
  "model",
  "harness"
];
function diffProfileFingerprints(a, b) {
  const drift = [];
  for (const channel of DRIFT_CHANNELS) {
    const left = channelValue(a, channel);
    const right = channelValue(b, channel);
    if (left !== right) drift.push({ channel, a: left, b: right });
  }
  return { equal: drift.length === 0, drift };
}
function formatProfileDrift(drift) {
  if (drift.equal) return "profiles identical";
  const lines = drift.drift.map((entry) => `  ${entry.channel}: ${entry.a} != ${entry.b}`);
  return `profile drift on ${drift.drift.length} channel(s):
${lines.join("\n")}`;
}

export {
  DEFAULT_MAX_SYSTEM_PROMPT_BYTES,
  largestPromptSections,
  assertSystemPromptWithinBudget,
  assertProfilePromptWithinBudget,
  fingerprintAgentProfile,
  diffProfileFingerprints,
  formatProfileDrift
};
//# sourceMappingURL=chunk-LWSJK546.js.map