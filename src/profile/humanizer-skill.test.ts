import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { HUMANIZER_LICENSE, HUMANIZER_SKILL_ID, HUMANIZER_SOURCE, humanizerSkill } from './humanizer-skill'
import { HUMANIZER_SKILL_MD } from './humanizer-skill.vendored'
import { humanProseSkill } from './quality-skills'

describe('humanizer skill', () => {
  it('ships the pinned upstream bytes unedited, with the MIT license', () => {
    expect(createHash('sha256').update(HUMANIZER_SKILL_MD, 'utf8').digest('hex')).toBe(HUMANIZER_SOURCE.sha256)
    expect(HUMANIZER_LICENSE).toContain('MIT License')
  })

  it('mounts as a skill entry that human-prose can name as its review step', () => {
    const skill = humanizerSkill()
    expect(skill).toMatchObject({ id: HUMANIZER_SKILL_ID, name: 'humanizer', source: HUMANIZER_SOURCE.repository })
    expect(skill.description).toMatch(/^Rewrite AI-sounding text/)
    expect(skill.skillMd).toBe(HUMANIZER_SKILL_MD)
    expect(humanProseSkill({ reviewSkillId: skill.id }).skillMd).toContain('using the `humanizer` skill')
  })
})
