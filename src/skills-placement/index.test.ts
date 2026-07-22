import { describe, expect, it } from 'vitest'
import { KNOWN_HARNESSES, type Harness } from '../harness/index'
import type { SkillEntry } from '../skills/index'

// This suite imports the real linked `@tangle-network/agent-profile-materialize`
// peer (an optional dependency of `skills-placement`) — fine in a repo that
// has it linked locally, but CI running without the peer installed must SKIP
// rather than fail. Probe availability once, at module load (vitest supports
// top-level await): `./index` statically imports the peer, so it can only be
// imported here once we know the probe succeeded — importing it unconditionally
// would throw at module-eval time on a CI machine without the peer.
const available = await import('@tangle-network/agent-profile-materialize').then(
  () => true,
  () => false,
)
const mod = available ? await import('./index') : null

const EXPECTED_SKILL_DIR: Record<Harness, string | null> = {
  opencode: '.opencode/skills',
  'claude-code': '.claude/skills',
  'kimi-code': '.kimi/skills',
  codex: '.codex/skills',
  amp: null,
  'factory-droids': null,
  pi: '.pi/skills',
  hermes: null,
  forge: null,
  openclaw: 'skills',
  acp: null,
  cursor: null,
  'cli-base': null,
}

describe.skipIf(!available)('resolveSkillDir', () => {
  it.each(KNOWN_HARNESSES.map((harness) => [harness, EXPECTED_SKILL_DIR[harness]] as const))(
    '%s -> %s',
    (harness, expected) => {
      expect(mod!.resolveSkillDir(harness)).toBe(expected)
    },
  )
})

describe.skipIf(!available)('unsupportedSkillHarnesses', () => {
  it('keeps only the unbridged/null-dir harnesses, deduped, order preserved', () => {
    expect(
      mod!.unsupportedSkillHarnesses(['opencode', 'hermes', 'amp', 'claude-code', 'hermes', 'amp']),
    ).toEqual(['hermes', 'amp'])
  })
})

describe.skipIf(!available)('composeSkillsForHarness', () => {
  const skills: SkillEntry[] = [
    {
      id: 'human-prose',
      name: 'Write Like a Human',
      description: 'Removes the structural tells that make writing read as AI-generated.',
      tier: 'free',
      skillMd: '---\nid: human-prose\n---\n\nStrip the tells.\n',
    },
  ]

  it('opencode -> mounted: refs populated, index section names .opencode/skills', () => {
    const result = mod!.composeSkillsForHarness({ skills, harness: 'opencode' })
    expect(result.refs.map((r) => r.name)).toEqual(['human-prose'])
    expect(result.promptSection).toContain('.opencode/skills/human-prose/SKILL.md')
    expect(result.promptSection).not.toContain('Strip the tells.')
  })

  it('hermes -> inline: no refs, bodies rendered into the section', () => {
    const result = mod!.composeSkillsForHarness({ skills, harness: 'hermes' })
    expect(result.refs).toEqual([])
    expect(result.promptSection).toContain('Strip the tells.')
  })

  it('amp -> inline: no refs, bodies rendered into the section', () => {
    const result = mod!.composeSkillsForHarness({ skills, harness: 'amp' })
    expect(result.refs).toEqual([])
    expect(result.promptSection).toContain('Strip the tells.')
  })
})
