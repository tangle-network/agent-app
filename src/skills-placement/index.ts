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
