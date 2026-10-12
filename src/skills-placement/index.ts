/**
 * Harness-native skill directory resolution — the one place agent-app binds
 * to the platform's authoritative per-harness skill-dir map.
 *
 * `../skills` renders skill CONTENT (parse, tier-filter, `inline`/`mounted`
 * delivery) but deliberately stops short of naming WHICH cwd path a `mounted`
 * skill lands at on a given harness — that mapping is owned by the platform
 * materializer (`@tangle-network/agent-profile-materialize`'s
 * `skillDirForHarness`), not by app-shell. This subpath exists so no product
 * — and no other agent-app module — ever writes a skill path literal
 * (`~/.claude/skills/...`, `.opencode/skills`, ...) of its own; it bridges
 * agent-app's `Harness` taxonomy onto the platform's `HarnessId` and asks the
 * platform for the answer.
 *
 * Requires the OPTIONAL peer `@tangle-network/agent-profile-materialize`.
 * Products that don't install it simply don't import this subpath — every
 * other agent-app skills surface (`../skills`, `ProfileChannels.skillRefs`)
 * works without it, falling back to `inline` delivery.
 */

import {
  defineInlineResource,
  type AgentProfile,
  type AgentProfileFileMount,
} from '@tangle-network/agent-interface'
import { KNOWN_HARNESSES, type Harness } from '../harness/index'
import { skillDirForHarness, type HarnessId } from '@tangle-network/agent-profile-materialize'
import { composeSkills, renderInlineSkills, type ComposedSkills, type SkillEntry } from '../skills/index'

/** agent-app `Harness` -> platform `HarnessId`, identity-mapped for exactly
 *  the harnesses the platform map covers. Harnesses absent here (`amp`,
 *  `factory-droids`, `forge`, `acp`, `cursor`, `cli-base`) resolve to `null` —
 *  {@link composeSkillsForHarness} refuses by default rather than silently
 *  delivering `inline`; a caller that genuinely needs `inline` on one of
 *  these opts in explicitly (`onNoSkillDir: 'inline'`). `cursor`'s adapter
 *  supports `resources.skills` bespokely but isn't in the platform map yet;
 *  treating it as unbridged is the safe posture until the map covers it,
 *  rather than guessing its cwd skill dir here. */
const HARNESS_BRIDGE: Partial<Record<Harness, HarnessId>> = {
  opencode: 'opencode',
  'claude-code': 'claude-code',
  nanoclaw: 'nanoclaw',
  'kimi-code': 'kimi-code',
  codex: 'codex',
  pi: 'pi',
  prime: 'prime',
  hermes: 'hermes',
  openclaw: 'openclaw',
}

/** Resolve the cwd-relative skill dir `resources.skills` refs materialize
 *  into on `harness` — via the platform's `skillDirForHarness`. `null` when
 *  `harness` isn't bridged (see {@link HARNESS_BRIDGE}) or when the platform
 *  itself has no cwd skill primitive for it (e.g. `hermes`, user-dir-only). */
export function resolveSkillDir(harness: Harness): string | null {
  const bridged = HARNESS_BRIDGE[harness]
  if (!bridged) return null
  return skillDirForHarness(bridged)
}

/** Filter `harnesses` down to those with no mounted skill dir (deduped,
 *  first-seen order preserved) — the set that must fall back to `inline`
 *  delivery, or that a caller should warn about before offering "mounted"
 *  install UX. */
export function unsupportedSkillHarnesses(harnesses: Iterable<Harness>): Harness[] {
  const seen = new Set<Harness>()
  const out: Harness[] = []
  for (const harness of harnesses) {
    if (resolveSkillDir(harness) !== null) continue
    if (seen.has(harness)) continue
    seen.add(harness)
    out.push(harness)
  }
  return out
}

/** Inputs to {@link composeSkillsForHarness}. */
export interface ComposeSkillsForHarnessInput {
  skills: SkillEntry[]
  harness: Harness
  tier?: string
  heading?: string
  /**
   * What to do when `harness` has no native skill-mount directory (see
   * {@link resolveSkillDir}). Default `'throw'`: refuse rather than silently
   * inlining every skill BODY into the system prompt. Pass `'inline'` only as
   * a deliberate, auditable opt-in — the caller has decided every skill must
   * reach this harness even though it will be concatenated into the prompt.
   */
  onNoSkillDir?: 'throw' | 'inline'
}

/** `KNOWN_HARNESSES` filtered to those the platform materializer can mount
 *  skill files onto natively (a non-null {@link resolveSkillDir}). Computed
 *  fresh rather than cached — the platform map can grow without a release
 *  here. Used only to build the actionable error in
 *  {@link composeSkillsForHarness}; not exported because it duplicates
 *  {@link unsupportedSkillHarnesses}'s complement and callers should reach
 *  for that instead when they need the harness list at runtime. */
function nativeSkillMountHarnesses(): Harness[] {
  return KNOWN_HARNESSES.filter((harness) => resolveSkillDir(harness) !== null)
}

/**
 * Compose {@link ComposedSkills} for `harness`.
 *
 * `mounted` delivery is the standard path: whenever the platform names a cwd
 * skill dir for `harness`, skills ride the typed `resources.skills` channel
 * and the platform materializer writes each one to that directory as a real
 * file — the agent reads it on demand with its own file tools.
 *
 * `inline` delivery — every skill BODY rendered straight into the system
 * prompt — is a NARROW fallback for harnesses with no native skill dir, never
 * a co-equal mode. An `AgentProfile` is a RECIPE that materializes into a
 * sandbox, not a prompt template: skill bodies belong in a file mount, and
 * `prompt.systemPrompt` should carry only what the agent must obey without a
 * tool call (identity, tool-call contract, safety rules, output format) plus
 * a short index of what's mounted. Concatenating skill bodies into the prompt
 * degrades the model toward empty answers once it grows large enough — one
 * product reproduced a 151,882-byte prompt exactly this way, from an
 * unnoticed inline fallback.
 *
 * Because of that, `onNoSkillDir` defaults to `'throw'`: a harness with no
 * skill dir refuses instead of silently inlining. The thrown error names the
 * harness, the skill count, the byte size that would have been inlined, and
 * the harnesses that DO support native mounting. Pass `onNoSkillDir:
 * 'inline'` only as a deliberate, auditable opt-in when every skill genuinely
 * must reach this harness regardless of prompt cost.
 *
 * The one function a product calls instead of hand-checking `resolveSkillDir`
 * and branching between {@link composeSkills}'s two modes itself.
 */
export function composeSkillsForHarness(input: ComposeSkillsForHarnessInput): ComposedSkills {
  const { skills, harness, tier, heading, onNoSkillDir = 'throw' } = input
  const skillDir = resolveSkillDir(harness)
  if (skillDir) return composeSkills({ skills, mode: 'mounted', skillDir, tier, heading })
  if (onNoSkillDir === 'inline') return composeSkills({ skills, mode: 'inline', tier, heading })

  const relevant = tier ? skills.filter((s) => s.tier === tier) : skills
  const promptSection = renderInlineSkills({ skills, tier, heading })
  const bytes = new TextEncoder().encode(promptSection).byteLength
  const mountable = nativeSkillMountHarnesses()
  throw new Error(
    `composeSkillsForHarness: "${harness}" has no native skill-mount directory. ` +
      `Inlining ${relevant.length} skill(s) (${bytes} bytes) into its system prompt would silently ` +
      `convert mounted skills into prompt text — a 151,882-byte prompt shipped this way once, and ` +
      `oversized prompts degrade toward empty answers. Mount the skills instead: pick a harness with ` +
      `native skill support (${mountable.join(', ')}), or pass onNoSkillDir: 'inline' to opt in ` +
      `explicitly and accept the inlined bytes.`,
  )
}

export type { ComposedSkills, SkillEntry } from '../skills/index'

/** A file that rides BESIDE a skill entry (kit sources, references, pinned
 *  requirements — anything the SKILL.md tells the agent to read or run).
 *  `path` is skill-dir-relative (`kit/iso-kit.mjs`, `references/x.md`). */
export interface SkillSupportFile {
  path: string
  content: string
}

/** Inline file mounts placing a skill's support files beside its entry on
 *  `harness`: `<skillDir>/<skillId>/<path>`. Empty when the harness has no
 *  cwd skill dir — the same posture as `resources.skills` itself (the
 *  platform skips skills there too), so nothing orphan lands in a workspace
 *  a harness will never read.
 *
 *  This is the placement primitive for kit-carrying skills (vendored
 *  executable kits, reference trees). A growing program belongs in THESE
 *  mounts — never in an env var: runtimeSecrets values are capped (8192
 *  chars on the sandbox SDK) and a skill tree outgrew that cap in production
 *  once, taking every isolated turn down with a secret-provider refusal. */
export function skillSupportFileMounts(
  harness: Harness,
  skillId: string,
  files: readonly SkillSupportFile[],
): AgentProfileFileMount[] {
  const skillDir = resolveSkillDir(harness)
  if (!skillDir || files.length === 0) return []
  return files.map((file) => ({
    path: `${skillDir}/${skillId}/${file.path}`,
    resource: defineInlineResource(`${skillId}/${file.path}`, file.content),
  }))
}

/** Attach a skill's support files to `profile` for `harness`, idempotently.
 *
 *  Replacement is by EXACT CONTENT under the skill's own subtree (any path
 *  ending `/<skillId>/<path>` whose bytes match a support file of THIS call):
 *  re-deriving the same profile for another harness replaces this skill's
 *  own mounts wherever they previously pointed, while pack-declared files
 *  with similar paths stay untouched. With no skill dir the skill's own
 *  mounts are dropped (and nothing added) — mirroring how the platform
 *  treats the skill entry itself on that harness. */
export function withSkillSupportFiles<
  P extends { resources?: AgentProfile['resources'] },
>(profile: P, harness: Harness, skillId: string, files: readonly SkillSupportFile[]): P {
  const hasSkillDir = resolveSkillDir(harness) !== null
  const desired = skillSupportFileMounts(harness, skillId, files)
  const desiredByPath = new Map(
    desired.map((mount) => [mount.path, mount.resource] as const),
  )
  const byRelPath = new Map(files.map((file) => [file.path, file.content] as const))
  const suffix = `/${skillId}/`
  const relUnderSkill = (path: string): string | null => {
    const at = path.lastIndexOf(suffix)
    return at < 0 ? null : path.slice(at + suffix.length)
  }
  // "Ours" = a mount under THIS skill's subtree whose bytes match a support
  // file of this call. It is STALE when the harness has no skill dir (there
  // is nowhere to place it — mirroring how the platform skips the skill
  // entry itself) or when this call would place it at a different path
  // (re-derivation for another harness). Exact-content identity only: a
  // foreign mount at one of our paths keeps the location (pack-declared
  // files win at their declared paths), and a mount already identical to
  // what we would add is kept as-is, so re-deriving for the SAME harness
  // returns the profile unchanged.
  const isStaleOurs = (mount: AgentProfileFileMount): boolean => {
    if (mount.resource.kind !== 'inline') return false
    const rel = relUnderSkill(mount.path)
    if (rel === null || byRelPath.get(rel) !== mount.resource.content) return false
    const desiredHere = desiredByPath.get(mount.path)
    return (
      !hasSkillDir ||
      desiredHere === undefined ||
      desiredHere.kind !== 'inline' ||
      desiredHere.content !== mount.resource.content
    )
  }
  const existing = profile.resources?.files ?? []
  const retained = existing.filter((mount) => !isStaleOurs(mount))
  const taken = new Set(retained.map((mount) => mount.path))
  const additions = desired.filter((mount) => !taken.has(mount.path))
  if (retained.length === existing.length && additions.length === 0) return profile
  return {
    ...profile,
    resources: { ...(profile.resources ?? {}), files: [...retained, ...additions] },
  }
}
