/**
 * Profile composer and system-prompt renderer for agent products.
 *
 * The standard "load a deployable AgentProfile, including skills, plus the
 * skills the end user added to their own instance" entry point. A product holds
 * a canonical base `AgentProfile` (role/environment/tool-conventions rendered
 * into `prompt.systemPrompt`, baseline skills, baseline MCP). At deploy/turn
 * time it layers four file-mount channels onto `resources.files` —
 *
 *   1. skills      — the always-mounted product skill corpus
 *   2. knowledge   — a second always-mounted corpus (domain knowledge pack)
 *   3. registry    — the tier-gated installable registry (free -> boot-mounted)
 *   4. userSkills  — per-user / per-workspace skills the END USER adds to their
 *                    own instance, mounted at `~/.claude/skills/<id>/SKILL.md`
 *                    exactly like the registry's free tier
 *
 * plus an optional MCP overlay (delegation + per-turn app-tool side channel), a
 * per-turn `systemPrompt` override, and a `name` override. The canonical
 * `mergeAgentProfiles` contract makes `mcp` last-wins per key (base -> overlay),
 * concatenates `resources` arrays (base ++ overlay), and shallow-merges `prompt`
 * so an overlay carrying only `systemPrompt` overrides it while keeping base
 * instructions. The compose algebra is DATA — the product injects the base
 * profile, the channel mounts (built with the `skills` subpath primitives), the
 * delegation/app-tool MCP map, and the override strings; nothing here reaches
 * for env, a glob, or a specific product's profile.
 *
 * The system prompt itself comes from `renderAgentPrompt` (./agent-prompt):
 * identity, the shared operating contract (./operating-contract), environment,
 * tool conventions, the skill index, domain guidance ending in the evolvable
 * learned guidance, and the workspace overlay. The default quality skills
 * (./quality-skills) join the product's skills, and `captureModelInput`
 * (./model-input) stores what the model saw for the turn's receipt.
 */

import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileMcpServer,
  AgentProfileResourceRef,
} from '@tangle-network/agent-interface'
import { mergeAgentProfiles } from '@tangle-network/agent-interface'
import { profile } from '@tangle-network/agent-eval'
import {
  composeShellResources,
  registrySkills,
  skillMountPath,
  type ComposeShellResourcesInput,
  type SkillEntry,
} from '../skills/index'
import { assertSystemPromptWithinBudget, type ComposeProfileBudget } from './budget'

/** The prompt byte budget lives in `./budget` (import-free) so `/sandbox` can
 *  run the same gate without pulling agent-eval through this module. Re-exported
 *  here so the published `/profile` surface is unchanged. */
export {
  assertProfilePromptWithinBudget,
  assertSystemPromptWithinBudget,
  DEFAULT_MAX_SYSTEM_PROMPT_BYTES,
  largestPromptSections,
  type ComposeProfileBudget,
} from './budget'

/** Re-expose agent-eval's `profile` namespace for products that still render
 *  through `profile.renderProfile`; new prompts use {@link renderAgentPrompt}.
 *  Re-exporting the bare functions would leak agent-eval's un-nameable
 *  AgentProfile type into our generated d.ts. */
export { profile }

export {
  LEARNED_GUIDANCE_SECTION_ID,
  renderAgentPrompt,
  stripComments,
  type AgentPromptInput,
  type AgentPromptSection,
  type RenderedAgentPrompt,
  type RenderedAgentPromptSection,
} from './agent-prompt'
export {
  OPERATING_CONTRACT_CLAUSES,
  OPERATING_CONTRACT_VERSION,
  renderOperatingContract,
  type OperatingContractClause,
  type OperatingContractClauseId,
  type OperatingContractOptions,
  type RenderedOperatingContract,
} from './operating-contract'
export {
  defaultQualitySkills,
  HUMAN_PROSE_SKILL_ID,
  humanProseSkill,
  withDefaultQualitySkills,
  type HumanProseSkillOptions,
  type QualitySkillOptions,
} from './quality-skills'
export {
  captureModelInput,
  createMemoryModelInputStore,
  MODEL_INPUT_RECORD_SCHEMA,
  modelInputBlob,
  readModelInput,
  type CaptureModelInputInput,
  type ModelInputBlob,
  type ModelInputKind,
  type ModelInputMediaType,
  type ModelInputOutcome,
  type ModelInputRecord,
  type ModelInputRef,
  type ModelInputSectionRef,
  type ModelInputStore,
} from './model-input'

/** The file-mount channels layered onto `resources.files`. The first three
 *  mirror {@link ComposeShellResourcesInput}; `userSkills` is the per-user /
 *  per-workspace channel — skills the END USER added to their own instance,
 *  mounted at the harness skill-discovery path like the registry's free tier. */
export interface ProfileChannels {
  /** Always-mounted skill corpus (pass `corpusSkills(...)`). */
  skills?: AgentProfileFileMount[]
  /** Always-mounted knowledge corpus (pass `corpusSkills(...)` for the pack). */
  knowledge?: AgentProfileFileMount[]
  /** Single-file evolvable / learned-guidance corpora, if mounted as files. */
  evolvable?: AgentProfileFileMount[]
  /** Tier-gated installable registry (pass the registry array; free tier is
   *  mounted, paid is install-on-demand). Gated through {@link registrySkills}. */
  registry?: SkillEntry[]
  /** Per-user / per-workspace skills the end user adds to their own instance.
   *  Mounted at `~/.claude/skills/<id>/SKILL.md`, the same harness path the
   *  registry uses, so a user skill and a registry skill with the same id
   *  collide deterministically (the user skill, appended last, wins). */
  userSkills?: UserSkill[]
  /** Final skip filter applied to the composed mount list by mount `path`. */
  filesPredicate?: (mount: AgentProfileFileMount) => boolean
  /** Typed `resources.skills` channel — refs the platform materializer places
   *  at the harness-native skill dir (see {@link skillRefs} and
   *  `@tangle-network/agent-app/skills-placement`'s `composeSkillsForHarness`).
   *  The successor to path-baked mounts: `registry`/`userSkills` above mount
   *  files at the hardcoded claude-code path via {@link skillMountPath};
   *  `skillRefs` instead rides the provider-neutral `resources.skills` field
   *  the platform resolves per harness. */
  skillRefs?: AgentProfileResourceRef[]
  /** Tier passed to {@link registrySkills} for the `registry` channel.
   *  Previously hardcoded `'free'`; default unchanged. */
  registryTier?: string
}

/** A per-user / per-workspace skill: an id and an inline `SKILL.md` body. The
 *  user-facing analogue of a registry {@link SkillEntry} with no tier gate —
 *  every user skill is mounted (the user opted in by adding it). */
export interface UserSkill {
  id: string
  /** Inline `SKILL.md` body mounted at {@link skillMountPath}. */
  skillMd: string
}

/** Overlay overrides applied on top of the channel mounts. */
export interface ProfileOverlay {
  /** Extra MCP servers merged into the profile `mcp` map (last-wins per key over
   *  the base servers). The product builds this from its delegation MCP entry
   *  and any per-turn app-tool side-channel servers. An absent/`undefined` entry
   *  is dropped — pass only the servers that resolved (fail-closed at the seam,
   *  not here). */
  mcp?: Record<string, AgentProfileMcpServer>
  /** Per-turn system-prompt override. When set, replaces the base
   *  `prompt.systemPrompt` while keeping base `prompt.instructions`. When unset,
   *  the base prompt passes through unchanged. */
  systemPrompt?: string
  /** Extra instruction lines merged onto the active prompt (e.g. a per-turn
   *  domain/integration directive). Appended to base `prompt.instructions` by
   *  the SDK merge. */
  instructions?: string[]
  /** Profile `name` override. When unset, the base name is kept. */
  name?: string
}

/** Project per-user skills onto SDK file mounts at the harness skill-discovery
 *  path. No tier gate — a user skill is mounted because the user added it.
 *  Sorted by path for determinism (matches {@link registrySkills}). */
export function userSkillMounts(userSkills: UserSkill[]): AgentProfileFileMount[] {
  return userSkills
    .map(
      (s) =>
        ({
          path: skillMountPath(s.id),
          resource: { kind: 'inline', name: s.id, content: s.skillMd },
        }) satisfies AgentProfileFileMount,
    )
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Compose a deployable `AgentProfile` from a canonical base plus the four
 * file-mount channels and the overlay overrides.
 *
 * Files: base `resources.files` come first; the four channels follow in
 * `skills -> knowledge -> evolvable -> registry -> userSkills` order (so a
 * userSkill that mounts at the same path as a registry skill is the last write
 * and wins). MCP: base servers first, the overlay `mcp` last (last-wins per
 * key). Prompt: the overlay `systemPrompt`, when set, replaces the base one;
 * base instructions are preserved. Name: the overlay `name`, when set, wins.
 *
 * The merge delegates to the SDK `mergeAgentProfiles` (overlay-wins on records,
 * arrays concatenated) — the deterministic algebra is the overlay we hand it,
 * not a hand-rolled spread. `mergeAgentProfiles(base, overlay)` returns
 * `undefined` only when BOTH are `undefined`; `base` is always defined here, so
 * the result is non-`undefined` by construction and we assert that to the caller.
 *
 * The composed `prompt.systemPrompt` is byte-budgeted here — the single point
 * where the FINAL prompt exists ({@link assertSystemPromptWithinBudget};
 * default {@link DEFAULT_MAX_SYSTEM_PROMPT_BYTES}, `warnOnly` escape hatch).
 */
export function composeAgentProfile(
  base: AgentProfile,
  channels: ProfileChannels = {},
  overlay: ProfileOverlay = {},
  budget: ComposeProfileBudget = {},
): AgentProfile {
  const shellInput: ComposeShellResourcesInput = {
    skills: channels.skills,
    knowledge: channels.knowledge,
    evolvable: channels.evolvable,
    registry: channels.registry
      ? registrySkills(channels.registry, channels.registryTier ?? 'free')
      : undefined,
    predicate: channels.filesPredicate,
  }
  const channelFiles = composeShellResources(shellInput)
  const userFiles = channels.userSkills ? userSkillMounts(channels.userSkills) : []
  const overlayFiles = channels.filesPredicate
    ? userFiles.filter(channels.filesPredicate)
    : userFiles
  const files = [...channelFiles, ...overlayFiles]

  const promptOverlay: { systemPrompt?: string; instructions?: string[] } = {}
  if (overlay.systemPrompt) promptOverlay.systemPrompt = overlay.systemPrompt
  if (overlay.instructions && overlay.instructions.length > 0) promptOverlay.instructions = overlay.instructions

  const overlayProfile: AgentProfile = {
    ...(overlay.name ? { name: overlay.name } : {}),
    ...(Object.keys(promptOverlay).length > 0 ? { prompt: promptOverlay } : {}),
    ...(overlay.mcp ? { mcp: overlay.mcp } : {}),
    resources: {
      files,
      ...(channels.skillRefs && channels.skillRefs.length > 0 ? { skills: channels.skillRefs } : {}),
    },
  }

  const merged = mergeAgentProfiles(base, overlayProfile)
  if (!merged)
    throw new Error('composeAgentProfile: mergeAgentProfiles returned undefined for a defined base')
  // Byte-budget gate on the FINAL composed systemPrompt — this is the single
  // point where every channel and overlay has been merged in.
  const systemPrompt = merged.prompt?.systemPrompt
  if (typeof systemPrompt === 'string') assertSystemPromptWithinBudget(systemPrompt, budget)
  return pruneEmptyResourceChannels(merged)
}

/** Drop absent and empty resource channels the canonical merge normalizes in,
 *  so the composed profile's wire payload carries
 *  only the channels that actually have content — one canonical shape every app
 *  emits, instead of a sidecar payload full of empty arrays. */
function pruneEmptyResourceChannels(profile: AgentProfile): AgentProfile {
  if (!profile.resources) return profile
  const kept = Object.fromEntries(
    Object.entries(profile.resources).filter(([, value]) =>
      value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  ) as AgentProfile['resources']
  const out: AgentProfile = { ...profile, resources: kept }
  if (kept && Object.keys(kept).length === 0) delete out.resources
  return out
}

export {
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
  skillRefs,
} from '../skills/index'
export type {
  ComposedSkills,
  ComposeShellResourcesInput,
  CorpusEntry,
  CorpusLoadResult,
  GlobModules,
  LoadCorpusOptions,
  ParsedSkill,
  SkillDeliveryMode,
  SkillEntry,
  SkillFrontmatter,
} from '../skills/index'
export {
  diffProfileFingerprints,
  fingerprintAgentProfile,
  formatProfileDrift,
} from './fingerprint'
export type {
  ProfileDrift,
  ProfileDriftEntry,
  ProfileFingerprint,
  ProfileFingerprintContext,
} from './fingerprint'

export { DEFAULT_HOME_LIMITS, defaultHomeFiles, withDefaultAgentHome } from './home'
