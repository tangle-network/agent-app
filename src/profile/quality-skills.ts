/**
 * Default quality skills every product agent mounts.
 *
 * `human-prose` was copied into three products byte-for-byte (GTM's catalog,
 * tax, creative), each with its own frontmatter. This module is now its one
 * source; a product adds its own vocabulary through options instead of editing
 * a copy. Banned-word detection belongs to the copy checks that scan outgoing
 * text; pass their word list as `bannedWords` so the skill and the check
 * enforce the same list.
 */

import { skillEntryFromMarkdown, type SkillEntry } from '../skills/index'

export const HUMAN_PROSE_SKILL_ID = 'human-prose'

/** Product additions to the shared writing skill. */
export interface HumanProseSkillOptions {
  /** Words the agent must not use in audience-facing prose. */
  bannedWords?: readonly string[]
  /** Product terms, keyed by the wording to avoid. */
  preferredTerms?: Readonly<Record<string, string>>
  /** Id of a mounted skill for a full review-and-rewrite pass, named as the
   *  next step for long drafts. Leave unset unless that skill is mounted. */
  reviewSkillId?: string
}

export interface QualitySkillOptions {
  writing?: HumanProseSkillOptions
}

const HUMAN_PROSE_DESCRIPTION =
  'Remove the structural tells that make prose read as machine-written. Load before writing anything for an audience: briefs, emails, posts, captions, ad copy, client replies.'

const HUMAN_PROSE_BODY = `# Write Like a Human

Load before writing anything for an audience: briefs, emails, posts, captions, ad copy, chat replies. This skill kills the *structural* tells, the sentence-level patterns that read as machine-written even when every word is allowed.

## The patterns to cut

**Throat-clearing openers.** Drop "Here's the thing", "The truth is", "It turns out", "Let me be clear", "The real X is", "I'll be honest". Open on the actual claim.

**Emphasis crutches.** No "Let that sink in", "Make no mistake", "This matters because", "Full stop". The point carries its own weight.

**Rhetorical setups and meta-commentary.** No "What if...?", "Think about it:", "Here's what I mean". No narrating your own writing: "Let me walk you through", "In this section", "As we'll see", "Plot twist:", "Spoiler:". Deliver the point; let the reader conclude.

**Telegraphed contrasts.** No "It's not X, it's Y" and no negative listings ("Not a tool. Not a framework. A..."). State what it is. The reader does not need the runway.

**Manufactured fragmentation.** No fragments for drama ("Revenue. That's it." / "Fast. Cheap. Done."). Use complete sentences and vary their length naturally instead of a staccato beat.

**Passive voice and false agency.** Every sentence has someone doing something. "A packet was sent" becomes "the SDR sent the packet". Do not anthropomorphize objects ("a complaint becomes a fix" becomes "the team fixed it that week"). Do not narrate from a distance; put the reader in the scene.

**Vague declaratives.** "The implications are significant", "the stakes are high", "the reasons are structural" say nothing. Name the specific implication, stake, or reason.

**Filler adverbs.** Delete "really, just, literally, actually, simply, honestly, genuinely, truly, fundamentally, importantly, crucially". The sentence is stronger without them.

**Punctuation.** Prefer commas and periods over em-dashes. Overusing the em-dash is itself a machine tell.

## Self-check before sending

Score the draft on five dimensions, 1-10 each:
- Directness: a statement, not an announcement?
- Rhythm: sentence length varied, not metronomic?
- Trust: respects the reader's intelligence, no over-explaining?
- Authenticity: sounds like a sharp person wrote it?
- Density: anything cuttable?

Below 35/50, cut and rewrite. Do not ship slop.`

const HUMAN_PROSE_ATTRIBUTION = 'Adapted from the stop-slop ruleset (github.com/hardikpandya/stop-slop).'

function vocabularySection(options: HumanProseSkillOptions): string {
  const banned = [...new Set((options.bannedWords ?? []).map((word) => word.trim()).filter(Boolean))]
  const preferred = Object.entries(options.preferredTerms ?? {})
    .map(([avoid, use]) => [avoid.trim(), use.trim()] as const)
    .filter(([avoid, use]) => avoid && use)
  if (banned.length === 0 && preferred.length === 0) return ''
  const parts = ['## Product vocabulary']
  if (banned.length > 0) parts.push(`Do not use these in audience-facing prose: ${banned.join(', ')}.`)
  if (preferred.length > 0) {
    parts.push(['Use the product term:', ...preferred.map(([avoid, use]) => `- "${use}", not "${avoid}"`)].join('\n'))
  }
  return parts.join('\n\n')
}

/** The shared writing skill as a mountable {@link SkillEntry}. */
export function humanProseSkill(options: HumanProseSkillOptions = {}): SkillEntry {
  const review = options.reviewSkillId?.trim()
  const sections = [
    HUMAN_PROSE_BODY,
    vocabularySection(options),
    review ? `For a long draft, finish with a full review pass using the \`${review}\` skill.` : '',
    HUMAN_PROSE_ATTRIBUTION,
  ].filter(Boolean)
  const skillMd = [
    '---',
    `name: ${HUMAN_PROSE_SKILL_ID}`,
    `description: ${JSON.stringify(HUMAN_PROSE_DESCRIPTION)}`,
    'user-invocable: false',
    '---',
    '',
    `${sections.join('\n\n')}\n`,
  ].join('\n')
  return skillEntryFromMarkdown(skillMd, HUMAN_PROSE_SKILL_ID)
}

/** The quality skills mounted by default. */
export function defaultQualitySkills(options: QualitySkillOptions = {}): SkillEntry[] {
  return [humanProseSkill(options.writing)]
}

/** Append the default quality skills to a product's skills. Throws when the
 *  product still carries its own copy of a default skill: delete the copy and
 *  move its additions into the options. */
export function withDefaultQualitySkills(
  productSkills: readonly SkillEntry[],
  options: QualitySkillOptions = {},
): SkillEntry[] {
  const defaults = defaultQualitySkills(options)
  const defaultIds = new Set(defaults.map((skill) => skill.id))
  const copies = productSkills.filter((skill) => defaultIds.has(skill.id)).map((skill) => skill.id)
  if (copies.length > 0) {
    throw new Error(
      `withDefaultQualitySkills: product skill(s) ${copies.join(', ')} duplicate a default quality skill; delete the product copy and pass its additions as options`,
    )
  }
  return [...productSkills, ...defaults]
}
