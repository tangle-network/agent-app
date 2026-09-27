import {
  composeSkills,
  renderInlineSkills
} from "../chunk-M3UFMQ7D.js";
import {
  KNOWN_HARNESSES
} from "../chunk-MCYJON3F.js";

// src/skills-placement/index.ts
import { skillDirForHarness } from "@tangle-network/agent-profile-materialize";
var HARNESS_BRIDGE = {
  opencode: "opencode",
  "claude-code": "claude-code",
  nanoclaw: "nanoclaw",
  "kimi-code": "kimi-code",
  codex: "codex",
  pi: "pi",
  prime: "prime",
  hermes: "hermes",
  openclaw: "openclaw"
};
function resolveSkillDir(harness) {
  const bridged = HARNESS_BRIDGE[harness];
  if (!bridged) return null;
  return skillDirForHarness(bridged);
}
function unsupportedSkillHarnesses(harnesses) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const harness of harnesses) {
    if (resolveSkillDir(harness) !== null) continue;
    if (seen.has(harness)) continue;
    seen.add(harness);
    out.push(harness);
  }
  return out;
}
function nativeSkillMountHarnesses() {
  return KNOWN_HARNESSES.filter((harness) => resolveSkillDir(harness) !== null);
}
function composeSkillsForHarness(input) {
  const { skills, harness, tier, heading, onNoSkillDir = "throw" } = input;
  const skillDir = resolveSkillDir(harness);
  if (skillDir) return composeSkills({ skills, mode: "mounted", skillDir, tier, heading });
  if (onNoSkillDir === "inline") return composeSkills({ skills, mode: "inline", tier, heading });
  const relevant = tier ? skills.filter((s) => s.tier === tier) : skills;
  const promptSection = renderInlineSkills({ skills, tier, heading });
  const bytes = new TextEncoder().encode(promptSection).byteLength;
  const mountable = nativeSkillMountHarnesses();
  throw new Error(
    `composeSkillsForHarness: "${harness}" has no native skill-mount directory. Inlining ${relevant.length} skill(s) (${bytes} bytes) into its system prompt would silently convert mounted skills into prompt text \u2014 a 151,882-byte prompt shipped this way once, and oversized prompts degrade toward empty answers. Mount the skills instead: pick a harness with native skill support (${mountable.join(", ")}), or pass onNoSkillDir: 'inline' to opt in explicitly and accept the inlined bytes.`
  );
}
export {
  composeSkillsForHarness,
  resolveSkillDir,
  unsupportedSkillHarnesses
};
//# sourceMappingURL=index.js.map