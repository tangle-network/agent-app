/**
 * Profile composer + evolvable-section seam for agent products.
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
 * per-turn `systemPrompt` override, and a `name` override. The merge is the SDK
 * `mergeAgentProfiles`: `mcp` is last-wins per key (base -> overlay), `resources`
 * arrays are concatenated (base ++ overlay), `prompt` is shallow-merged so an
 * overlay carrying only `systemPrompt` overrides it while keeping base
 * instructions. The compose algebra is DATA — the product injects the base
 * profile, the channel mounts (built with the `skills` subpath primitives), the
 * delegation/app-tool MCP map, and the override strings; nothing here reaches
 * for env, a glob, or a specific product's profile.
 *
 * The evolvable-section seam is the loader closure. A product's single
 * self-improvable domain section (the one `applyDomainPatch` targets) loads its
 * body from a deployed markdown override, falling back to an in-tree baseline.
 * The `import.meta.glob('<lit>', ...)` literal must stay at the CONSUMER call
 * site (Vite static-analyzes it), so `makeEvolvableSection` takes the loader as
 * a closure and a REQUIRED `baseline` — it never constructs a glob and never
 * defaults the baseline, so a product can't render an empty learned-guidance
 * section. `stripComments` is the shared "is this addendum really empty?" test.
 */

import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileMcpServer,
  AgentProfileResourceRef,
} from '@tangle-network/sandbox'
import { mergeAgentProfiles } from '@tangle-network/sandbox'
import { profile } from '@tangle-network/agent-eval'
import {
  composeShellResources,
  registrySkills,
  skillMountPath,
  type ComposeShellResourcesInput,
  type SkillEntry,
} from '../skills/index'

/** Re-expose the agent-eval section/render substrate so a product wires the
 *  evolvable surface through ONE subpath: `makeEvolvableSection` builds the
 *  section, `profile.renderProfile` renders it, `profile.applyDomainPatch` lets
 *  the loop patch it by id. The rendering/patching engine stays in agent-eval;
 *  reach it through this namespace (re-exporting the bare fns would leak
 *  agent-eval's un-nameable AgentProfile type into our generated d.ts). */
export { profile }

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

/** Byte budget on the FINAL composed `prompt.systemPrompt`. Past this the
 *  model degrades sharply (a 122,659-byte prompt shipped once and the model
 *  returned empty answers), so the default gate throws well before that. */
export const DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 40_000

/** Budget config for the composed system prompt. */
export interface ComposeProfileBudget {
  /** Byte cap on the composed `prompt.systemPrompt`.
   *  Default {@link DEFAULT_MAX_SYSTEM_PROMPT_BYTES}. */
  maxSystemPromptBytes?: number
  /** Downgrade the over-budget throw to a `console.warn` — the escape hatch
   *  for a product with a known-big prompt that must still ship (it yells on
   *  every compose instead of blocking). */
  warnOnly?: boolean
}

/** Largest markdown-heading-delimited sections of a prompt, by UTF-8 bytes.
 *  Cheap heuristic: split on `#`-heading lines; the preamble before the first
 *  heading reports as "(preamble)". */
export function largestPromptSections(
  prompt: string,
  top = 3,
): Array<{ title: string; bytes: number }> {
  const encoder = new TextEncoder()
  const sections: Array<{ title: string; bytes: number }> = []
  let title = '(preamble)'
  let start = 0
  const flush = (end: number) => {
    const body = prompt.slice(start, end)
    if (body.trim()) sections.push({ title, bytes: encoder.encode(body).byteLength })
  }
  const headingRe = /^#{1,6}\s+(.+)$/gm
  for (const match of prompt.matchAll(headingRe)) {
    flush(match.index)
    title = (match[1] ?? '').trim() || '(untitled section)'
    start = match.index
  }
  flush(prompt.length)
  return sections.sort((a, b) => b.bytes - a.bytes).slice(0, top)
}

/** Enforce {@link ComposeProfileBudget} on a composed system prompt: over
 *  budget throws (or warns with `warnOnly`) with the actual size and the
 *  top-3 largest sections. Exported so a product assembling its prompt
 *  outside {@link composeAgentProfile} (e.g. via the `/prompt` assembler) can
 *  run the same gate at its own final-composition point. */
export function assertSystemPromptWithinBudget(
  systemPrompt: string,
  budget: ComposeProfileBudget = {},
): void {
  const max = budget.maxSystemPromptBytes ?? DEFAULT_MAX_SYSTEM_PROMPT_BYTES
  const bytes = new TextEncoder().encode(systemPrompt).byteLength
  if (bytes <= max) return
  const sections = largestPromptSections(systemPrompt)
    .map((s) => `"${s.title}" (${s.bytes}B)`)
    .join(', ')
  const message =
    `composed systemPrompt is ${bytes} bytes — over the ${max}-byte budget ` +
    `(oversized prompts degrade to empty answers). ` +
    (sections ? `Largest sections: ${sections}. ` : '') +
    `Trim the prompt, move content to skills/knowledge mounts, or raise maxSystemPromptBytes deliberately.`
  if (budget.warnOnly) {
    console.warn(`[profile] ${message}`)
    return
  }
  throw new Error(message)
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

/** Drop empty resource channels the SDK merge normalizes in (`tools`/`skills`/
 *  `agents`/`commands`: `[]`), so the composed profile's wire payload carries
 *  only the channels that actually have content — one canonical shape every app
 *  emits, instead of a sidecar payload full of empty arrays. */
function pruneEmptyResourceChannels(profile: AgentProfile): AgentProfile {
  if (!profile.resources) return profile
  const kept = Object.fromEntries(
    Object.entries(profile.resources).filter(([, value]) => !(Array.isArray(value) && value.length === 0)),
  ) as AgentProfile['resources']
  const out: AgentProfile = { ...profile, resources: kept }
  if (kept && Object.keys(kept).length === 0) delete out.resources
  return out
}

/** True body of an addendum file with HTML comments stripped — an all-comment
 *  placeholder counts as empty, so the loader falls back to the baseline. */
export function stripComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/** Inputs to {@link makeEvolvableSection}. */
export interface EvolvableSectionInput {
  /** Section id the self-improvement loop targets with `applyDomainPatch`. */
  id: string
  /** Section title rendered as `### <title>`. */
  title: string
  /**
   * Load the deployed section body. The CONSUMER supplies this closure and runs
   * its own `import.meta.glob('<lit>', { eager: true, query: '?raw', import:
   * 'default' })` inside it — the literal must stay at the call site so Vite can
   * static-analyze it; a glob constructed here would not resolve the product's
   * files. Return the raw markdown (comments and all); `makeEvolvableSection`
   * applies {@link stripComments} to decide whether it is really populated.
   */
  load: () => string
  /**
   * The in-tree fallback body, used when `load()` returns an
   * all-comments/empty placeholder. REQUIRED — no internal default — so a
   * product can never accidentally render an empty evolvable section.
   */
  baseline: string
}

/**
 * Build the one evolvable (`evolvable: true`) domain section whose body comes
 * from the product's loader, falling back to the required baseline when the
 * loaded body is empty after stripping comments. Returns the agent-eval
 * `AgentProfileSection` shape — drop it straight into `prodProfile`'s shipped
 * sections. The loader is the only seam; the empty-vs-populated rule and the
 * baseline fallback are the lifted algebra.
 */
export function makeEvolvableSection(input: EvolvableSectionInput): profile.AgentProfileSection {
  const loaded = input.load()
  const body = stripComments(loaded) ? loaded.trim() : input.baseline
  return { id: input.id, title: input.title, body, evolvable: true }
}

export {
  assertSkillDeliveryDisjoint,
  composeShellResources,
  composeSkills,
  corpusSkills,
  loadMarkdownCorpus,
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
