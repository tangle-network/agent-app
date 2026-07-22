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

import type { Harness } from '../harness/index'
import { skillDirForHarness, type HarnessId } from '@tangle-network/agent-profile-materialize'
import { composeSkills, type ComposedSkills, type SkillEntry } from '../skills/index'

/** agent-app `Harness` -> platform `HarnessId`, identity-mapped for exactly
 *  the harnesses the platform map covers. Harnesses absent here (`amp`,
 *  `factory-droids`, `forge`, `acp`, `cursor`, `cli-base`) resolve to `null` —
 *  callers fall back to `inline` delivery. `cursor`'s adapter supports
 *  `resources.skills` bespokely but isn't in the platform map yet; treating it
 *  as unbridged (inline fallback) is the safe posture until the map covers
 *  it, rather than guessing its cwd skill dir here. */
const HARNESS_BRIDGE: Partial<Record<Harness, HarnessId>> = {
  opencode: 'opencode',
  'claude-code': 'claude-code',
  'kimi-code': 'kimi-code',
  codex: 'codex',
  pi: 'pi',
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
}

/**
 * Compose {@link ComposedSkills} for `harness`: `mounted` delivery when the
 * platform names a cwd skill dir for it, `inline` delivery (the automatic
 * fallback that keeps every skill available on every harness) otherwise. The
 * one function a product calls instead of hand-checking `resolveSkillDir`
 * and branching between {@link composeSkills}'s two modes itself.
 */
export function composeSkillsForHarness(input: ComposeSkillsForHarnessInput): ComposedSkills {
  const { skills, harness, tier, heading } = input
  const skillDir = resolveSkillDir(harness)
  if (skillDir) return composeSkills({ skills, mode: 'mounted', skillDir, tier, heading })
  return composeSkills({ skills, mode: 'inline', tier, heading })
}

export type { ComposedSkills, SkillEntry } from '../skills/index'
