/**
 * `humanizer`: a shared review-and-rewrite skill for prose, vendored from
 * blader/humanizer (MIT) and pinned to one revision.
 *
 * It complements `human-prose`. That skill is the short rule set an agent
 * loads before writing; this one is the full pass for a long draft, with the
 * strong-versus-weak weighting the copy-quality scanner also uses. Products
 * mount it and name it as the review step:
 * `humanProseSkill({ reviewSkillId: HUMANIZER_SKILL_ID })`.
 */

import { skillEntryFromMarkdown, type SkillEntry } from '../skills/index'
import { HUMANIZER_LICENSE, HUMANIZER_SKILL_MD } from './humanizer-skill.vendored'

export const HUMANIZER_SKILL_ID = 'humanizer'

export const HUMANIZER_SOURCE = {
  repository: 'https://github.com/blader/humanizer',
  revision: '225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8',
  path: 'SKILL.md',
  license: 'MIT',
  sha256: '0612f1dfb1672b0ea9b97e139bf1f06cabe98d8b27424fe8ff01e1fb4cc99cad',
} as const

const DESCRIPTION =
  'Rewrite AI-sounding text so it reads like the writer without changing what it says. Load for a full review pass on a long draft: staged contrasts, one-line closers, forced triads, dashes, inflated claims, chat leftovers.'

/** The vendored skill as a mountable entry, with the upstream license beside it. */
export function humanizerSkill(): SkillEntry {
  const entry = skillEntryFromMarkdown(HUMANIZER_SKILL_MD, HUMANIZER_SKILL_ID)
  return { ...entry, id: HUMANIZER_SKILL_ID, description: DESCRIPTION, source: HUMANIZER_SOURCE.repository }
}

export { HUMANIZER_LICENSE }
