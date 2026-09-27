import {
  assertSkillDeliveryDisjoint,
  composeShellResources,
  composeSkills,
  corpusSkills,
  loadMarkdownCorpus,
  mergeComposedSkills,
  parseCorpusSkills,
  parseSkillFrontmatter,
  registrySkills,
  renderInlineSkills,
  renderSkillIndex,
  skillEntryFromMarkdown,
  skillMountPath,
  skillRefs
} from "../chunk-M3UFMQ7D.js";
import {
  DEFAULT_MAX_SYSTEM_PROMPT_BYTES,
  assertProfilePromptWithinBudget,
  assertSystemPromptWithinBudget,
  diffProfileFingerprints,
  fingerprintAgentProfile,
  formatProfileDrift,
  largestPromptSections
} from "../chunk-LWSJK546.js";

// src/profile/index.ts
import { mergeAgentProfiles } from "@tangle-network/agent-interface";
import { profile } from "@tangle-network/agent-eval";
function userSkillMounts(userSkills) {
  return userSkills.map(
    (s) => ({
      path: skillMountPath(s.id),
      resource: { kind: "inline", name: s.id, content: s.skillMd }
    })
  ).sort((a, b) => a.path.localeCompare(b.path));
}
function composeAgentProfile(base, channels = {}, overlay = {}, budget = {}) {
  const shellInput = {
    skills: channels.skills,
    knowledge: channels.knowledge,
    evolvable: channels.evolvable,
    registry: channels.registry ? registrySkills(channels.registry, channels.registryTier ?? "free") : void 0,
    predicate: channels.filesPredicate
  };
  const channelFiles = composeShellResources(shellInput);
  const userFiles = channels.userSkills ? userSkillMounts(channels.userSkills) : [];
  const overlayFiles = channels.filesPredicate ? userFiles.filter(channels.filesPredicate) : userFiles;
  const files = [...channelFiles, ...overlayFiles];
  const promptOverlay = {};
  if (overlay.systemPrompt) promptOverlay.systemPrompt = overlay.systemPrompt;
  if (overlay.instructions && overlay.instructions.length > 0) promptOverlay.instructions = overlay.instructions;
  const overlayProfile = {
    ...overlay.name ? { name: overlay.name } : {},
    ...Object.keys(promptOverlay).length > 0 ? { prompt: promptOverlay } : {},
    ...overlay.mcp ? { mcp: overlay.mcp } : {},
    resources: {
      files,
      ...channels.skillRefs && channels.skillRefs.length > 0 ? { skills: channels.skillRefs } : {}
    }
  };
  const merged = mergeAgentProfiles(base, overlayProfile);
  if (!merged)
    throw new Error("composeAgentProfile: mergeAgentProfiles returned undefined for a defined base");
  const systemPrompt = merged.prompt?.systemPrompt;
  if (typeof systemPrompt === "string") assertSystemPromptWithinBudget(systemPrompt, budget);
  return pruneEmptyResourceChannels(merged);
}
function pruneEmptyResourceChannels(profile2) {
  if (!profile2.resources) return profile2;
  const kept = Object.fromEntries(
    Object.entries(profile2.resources).filter(
      ([, value]) => value !== void 0 && !(Array.isArray(value) && value.length === 0)
    )
  );
  const out = { ...profile2, resources: kept };
  if (kept && Object.keys(kept).length === 0) delete out.resources;
  return out;
}
function stripComments(raw) {
  return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
}
function makeEvolvableSection(input) {
  const loaded = input.load();
  const body = stripComments(loaded) ? loaded.trim() : input.baseline;
  return { id: input.id, title: input.title, body, evolvable: true };
}
export {
  DEFAULT_MAX_SYSTEM_PROMPT_BYTES,
  assertProfilePromptWithinBudget,
  assertSkillDeliveryDisjoint,
  assertSystemPromptWithinBudget,
  composeAgentProfile,
  composeShellResources,
  composeSkills,
  corpusSkills,
  diffProfileFingerprints,
  fingerprintAgentProfile,
  formatProfileDrift,
  largestPromptSections,
  loadMarkdownCorpus,
  makeEvolvableSection,
  mergeComposedSkills,
  parseCorpusSkills,
  parseSkillFrontmatter,
  profile,
  registrySkills,
  renderInlineSkills,
  renderSkillIndex,
  skillEntryFromMarkdown,
  skillMountPath,
  skillRefs,
  stripComments,
  userSkillMounts
};
//# sourceMappingURL=index.js.map