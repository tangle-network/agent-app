import { describe, expect, it } from 'vitest'
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
  skillRefs,
  type CorpusEntry,
  type GlobModules,
  type SkillEntry,
} from './index'

const REGISTRY: SkillEntry[] = [
  {
    id: 'human-prose',
    name: 'Write Like a Human',
    description: 'Removes the structural tells that make writing read as AI-generated.',
    category: 'content',
    tags: ['writing'],
    tier: 'free',
    skillMd: '# Write Like a Human\n\nfree body',
  },
  {
    id: 'efiling',
    name: 'E-Filing',
    description: 'Prepare and submit electronic filings.',
    category: 'operations',
    tags: ['filing'],
    tier: 'paid',
    skillMd: '# E-Filing\n\npaid body',
  },
]

/** A fake Vite glob-result map so the test never needs Vite or the fs path. */
const GLOB: GlobModules = {
  './skills/icp-definition/SKILL.md': '# ICP\n\nicp body',
  './skills/pricing-analysis/SKILL.md': '# Pricing\n\npricing body',
}

/** Index a record under `noUncheckedIndexedAccess`, failing loud if absent. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected key to be present')
  return value
}

describe('skillMountPath', () => {
  it('builds the harness skill-discovery path', () => {
    expect(skillMountPath('human-prose')).toBe('~/.claude/skills/human-prose/SKILL.md')
  })
})

describe('loadMarkdownCorpus — injected glob map', () => {
  it('returns sorted entries from the Vite glob result', () => {
    const { source, entries } = loadMarkdownCorpus({ anchor: 'skills', globModules: GLOB })
    expect(source).toBe('vite')
    expect(entries.map((e) => e.id)).toEqual(['icp-definition', 'pricing-analysis'])
    expect(must(entries[0]).content).toBe('# ICP\n\nicp body')
    expect(must(entries[0]).key).toBe('skills/icp-definition/SKILL.md')
  })

  it('applies the skip predicate by normalized key', () => {
    const { entries } = loadMarkdownCorpus({
      anchor: 'skills',
      globModules: GLOB,
      skip: (key) => key.endsWith('pricing-analysis/SKILL.md'),
    })
    expect(entries.map((e) => e.id)).toEqual(['icp-definition'])
  })

  it('reports empty when no glob result and no fs base dir', () => {
    const { source, entries } = loadMarkdownCorpus({ anchor: 'skills', globModules: {} })
    expect(source).toBe('empty')
    expect(entries).toEqual([])
  })
})

describe('corpusSkills', () => {
  it('projects corpus entries onto SDK mounts at the relative anchor path', () => {
    const { entries } = loadMarkdownCorpus({ anchor: 'skills', globModules: GLOB })
    const mounts = corpusSkills(entries, 'skills')
    expect(mounts.map((m) => m.path)).toEqual([
      'skills/icp-definition.md',
      'skills/pricing-analysis.md',
    ])
    const first = must(mounts[0]).resource
    expect(first.kind).toBe('inline')
    if (first.kind === 'inline') {
      expect(first.name).toBe('skills-icp-definition')
      expect(first.content).toBe('# ICP\n\nicp body')
    }
  })
})

describe('registrySkills', () => {
  it('tier-gates: free tier mounts at the harness path, paid is excluded', () => {
    const free = registrySkills(REGISTRY)
    expect(free.map((m) => m.path)).toEqual(['~/.claude/skills/human-prose/SKILL.md'])
    const firstResource = must(free[0]).resource
    expect(firstResource.kind).toBe('inline')
    if (firstResource.kind === 'inline') {
      expect(firstResource.name).toBe('human-prose')
      expect(firstResource.content).toBe('# Write Like a Human\n\nfree body')
    }
  })

  it('selects an explicit tier', () => {
    const paid = registrySkills(REGISTRY, 'paid')
    expect(paid.map((m) => m.path)).toEqual(['~/.claude/skills/efiling/SKILL.md'])
  })
})

describe('composeShellResources', () => {
  it('projects skills + registry onto resources.files at the right paths', () => {
    const { entries } = loadMarkdownCorpus({ anchor: 'skills', globModules: GLOB })
    const files = composeShellResources({
      skills: corpusSkills(entries, 'skills'),
      registry: registrySkills(REGISTRY),
    })
    expect(files.map((m) => m.path)).toEqual([
      'skills/icp-definition.md',
      'skills/pricing-analysis.md',
      '~/.claude/skills/human-prose/SKILL.md',
    ])
  })

  it('keeps the two skill systems on the same channel, corpus before registry', () => {
    const corpus = corpusSkills(
      loadMarkdownCorpus({ anchor: 'skills', globModules: GLOB }).entries,
      'skills',
    )
    const files = composeShellResources({ skills: corpus, registry: registrySkills(REGISTRY) })
    const lastCorpus = files.findIndex((m) => m.path === 'skills/pricing-analysis.md')
    const firstRegistry = files.findIndex((m) => m.path.startsWith('~/.claude/skills/'))
    expect(lastCorpus).toBeLessThan(firstRegistry)
  })

  it('predicate excludes filtered mounts', () => {
    const files = composeShellResources({
      registry: registrySkills(REGISTRY),
      knowledge: [
        { path: 'knowledge/index.md', resource: { kind: 'inline', name: 'idx', content: 'x' } },
        { path: 'knowledge/universal/icp.md', resource: { kind: 'inline', name: 'u', content: 'y' } },
      ],
      predicate: (m) => m.path !== 'knowledge/index.md',
    })
    expect(files.map((m) => m.path)).toEqual([
      'knowledge/universal/icp.md',
      '~/.claude/skills/human-prose/SKILL.md',
    ])
  })

  it('round-trips an empty input to an empty mount list', () => {
    expect(composeShellResources({})).toEqual([])
  })
})

// ─── Adoptable skills: frontmatter parsing + delivery modes ───────────────────

const FULL_FIELD_MD = `---
id: human-prose
name: Write Like a Human
description: "Removes the structural tells that make writing read as AI-generated."
author:
  name: Jane Doe
  url: https://example.com/jane
source: https://example.com/skills/human-prose
category: content
tags: [writing, editing]
tier: paid
---

# Write Like a Human

Body content goes here.
`

describe('parseSkillFrontmatter', () => {
  it('parses every supported field from a full fixture', () => {
    const parsed = parseSkillFrontmatter(FULL_FIELD_MD)
    expect(parsed.frontmatter).toEqual({
      id: 'human-prose',
      name: 'Write Like a Human',
      description: 'Removes the structural tells that make writing read as AI-generated.',
      author: { name: 'Jane Doe', url: 'https://example.com/jane' },
      source: 'https://example.com/skills/human-prose',
      category: 'content',
      tags: ['writing', 'editing'],
      tier: 'paid',
    })
    expect(parsed.body).toBe('# Write Like a Human\n\nBody content goes here.\n')
    expect(parsed.raw).toBe(FULL_FIELD_MD)
  })

  it('parses block-style (indented `- item`) tags', () => {
    const raw = '---\nid: x\ntags:\n  - writing\n  - editing\n---\n\nbody\n'
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter.tags).toEqual(['writing', 'editing'])
  })

  it('returns empty frontmatter with body === raw when frontmatter is absent', () => {
    const raw = '# Just a skill\n\nNo frontmatter here.\n'
    const parsed = parseSkillFrontmatter(raw)
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toBe(raw)
    expect(parsed.raw).toBe(raw)
  })

  it('ignores an unknown scalar key (forward-compat)', () => {
    const raw = '---\nid: x\nfutureField: whatever\n---\n\nbody\n'
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter).toEqual({ id: 'x' })
  })

  it('throws on an opened block with no closing "---" (truncated frontmatter)', () => {
    const raw = '---\nid: x\n\nno closing delimiter\n'
    expect(() => parseSkillFrontmatter(raw)).toThrow(/closing/)
  })

  it('throws naming the offending line for a shape it does not recognize', () => {
    const raw = '---\nid: x\ngarbage line with no colon\n---\n\nbody\n'
    expect(() => parseSkillFrontmatter(raw)).toThrow(/garbage line with no colon/)
  })
})

describe('skillEntryFromMarkdown', () => {
  it('prefers a frontmatter id over fallbackId', () => {
    const raw = '---\nid: from-frontmatter\n---\n\nbody\n'
    const entry = skillEntryFromMarkdown(raw, 'from-fallback')
    expect(entry.id).toBe('from-frontmatter')
  })

  it('falls back to fallbackId when frontmatter has no id', () => {
    const raw = '---\nname: No Id Skill\n---\n\nbody\n'
    const entry = skillEntryFromMarkdown(raw, 'fallback-id')
    expect(entry.id).toBe('fallback-id')
  })

  it('throws when neither a frontmatter id nor fallbackId is present', () => {
    const raw = '---\nname: No Id Skill\n---\n\nbody\n'
    expect(() => skillEntryFromMarkdown(raw)).toThrow(/id/)
  })

  it('defaults name to id, tier to free, description to empty, and carries skillMd verbatim', () => {
    const raw = '---\nid: bare-skill\n---\n\nbody\n'
    const entry = skillEntryFromMarkdown(raw)
    expect(entry.name).toBe('bare-skill')
    expect(entry.tier).toBe('free')
    expect(entry.description).toBe('')
    expect(entry.skillMd).toBe(raw)
  })
})

describe('parseCorpusSkills', () => {
  it('uses each corpus entry id as the fallback id', () => {
    const corpus: CorpusEntry[] = [
      {
        id: 'corpus-slug',
        key: 'skills/corpus-slug/SKILL.md',
        content: '---\nname: From Corpus\n---\n\nbody\n',
      },
    ]
    const skills = parseCorpusSkills(corpus)
    expect(skills).toHaveLength(1)
    expect(must(skills[0]).id).toBe('corpus-slug')
    expect(must(skills[0]).name).toBe('From Corpus')
  })
})

const REF_SKILLS: SkillEntry[] = [
  {
    id: 'b-skill',
    name: 'B Skill',
    description: 'b',
    tier: 'free',
    skillMd: '---\nid: b-skill\n---\n\nB body\n',
  },
  {
    id: 'a-skill',
    name: 'A Skill',
    description: 'a',
    tier: 'paid',
    skillMd: '---\nid: a-skill\n---\n\nA body\n',
  },
]

describe('skillRefs', () => {
  it('returns {kind: "inline", name: id, content: skillMd} refs sorted by id', () => {
    const refs = skillRefs(REF_SKILLS)
    expect(refs).toEqual([
      { kind: 'inline', name: 'a-skill', content: must(REF_SKILLS[1]).skillMd },
      { kind: 'inline', name: 'b-skill', content: must(REF_SKILLS[0]).skillMd },
    ])
  })

  it('filters by tier when given (same semantics as registrySkills)', () => {
    const refs = skillRefs(REF_SKILLS, { tier: 'paid' })
    expect(refs.map((r) => r.name)).toEqual(['a-skill'])
  })
})

const RENDER_SKILLS: SkillEntry[] = [
  {
    id: 'human-prose',
    name: 'Write Like a Human',
    description: 'Removes the structural tells that make writing read as AI-generated.',
    tier: 'free',
    skillMd:
      '---\nid: human-prose\n---\n\nStrip the structural tells that make writing read as AI-generated.\n',
  },
  {
    id: 'efiling',
    name: 'E-Filing',
    description: 'Prepare and submit electronic filings.',
    tier: 'paid',
    skillMd: '---\nid: efiling\n---\n\nPrepare and submit electronic filings on your behalf.\n',
  },
]

describe('renderInlineSkills', () => {
  it('renders an exact golden section: heading + each stripped body, joined by blank lines', () => {
    expect(renderInlineSkills({ skills: RENDER_SKILLS })).toBe(
      '\n\n## Skills\n\n' +
        '### Write Like a Human\n\nStrip the structural tells that make writing read as AI-generated.\n\n' +
        '### E-Filing\n\nPrepare and submit electronic filings on your behalf.',
    )
  })

  it('returns "" when the tier filter excludes every skill', () => {
    expect(renderInlineSkills({ skills: RENDER_SKILLS, tier: 'enterprise' })).toBe('')
  })

  it('returns "" for an empty skill list', () => {
    expect(renderInlineSkills({ skills: [] })).toBe('')
  })

  it('applies the tier filter', () => {
    expect(renderInlineSkills({ skills: RENDER_SKILLS, tier: 'paid' })).toBe(
      '\n\n## Skills\n\n### E-Filing\n\nPrepare and submit electronic filings on your behalf.',
    )
  })

  it('honors a custom heading', () => {
    expect(renderInlineSkills({ skills: [must(RENDER_SKILLS[0])], heading: '## Available Skills' })).toBe(
      '\n\n## Available Skills\n\n' +
        '### Write Like a Human\n\nStrip the structural tells that make writing read as AI-generated.',
    )
  })
})

describe('renderSkillIndex', () => {
  it('renders an exact golden index: one line per skill naming the skillDir', () => {
    expect(renderSkillIndex({ skills: RENDER_SKILLS, skillDir: '.opencode/skills' })).toBe(
      '\n\n## Skills\n\n' +
        '- Write Like a Human: Removes the structural tells that make writing read as AI-generated. ' +
        '(read .opencode/skills/human-prose/SKILL.md)\n' +
        '- E-Filing: Prepare and submit electronic filings. (read .opencode/skills/efiling/SKILL.md)',
    )
  })

  it('returns "" for an empty skill list', () => {
    expect(renderSkillIndex({ skills: [], skillDir: '.opencode/skills' })).toBe('')
  })

  it('applies the tier filter and a custom heading', () => {
    expect(
      renderSkillIndex({
        skills: RENDER_SKILLS,
        skillDir: '.claude/skills',
        tier: 'paid',
        heading: '## Installed Skills',
      }),
    ).toBe(
      '\n\n## Installed Skills\n\n' +
        '- E-Filing: Prepare and submit electronic filings. (read .claude/skills/efiling/SKILL.md)',
    )
  })
})

describe('composeSkills', () => {
  it('inline mode returns empty refs and the inline prompt section', () => {
    const result = composeSkills({ skills: RENDER_SKILLS, mode: 'inline' })
    expect(result.refs).toEqual([])
    expect(result.promptSection).toContain('### Write Like a Human')
    expect(result.inlineIds).toEqual(['human-prose', 'efiling'])
    expect(result.mountedIds).toEqual([])
  })

  it('mounted mode returns skillRefs plus the index section', () => {
    const result = composeSkills({ skills: RENDER_SKILLS, mode: 'mounted', skillDir: '.opencode/skills' })
    expect(result.refs.map((r) => r.name)).toEqual(['efiling', 'human-prose'])
    expect(result.promptSection).toContain('.opencode/skills/human-prose/SKILL.md')
    expect(result.inlineIds).toEqual([])
    expect(result.mountedIds).toEqual(['human-prose', 'efiling'])
  })

  it('delivered ids honor the tier filter', () => {
    const result = composeSkills({ skills: RENDER_SKILLS, mode: 'inline', tier: 'paid' })
    expect(result.inlineIds).toEqual(['efiling'])
  })

  it('mounted mode throws when skillDir is null or undefined', () => {
    expect(() =>
      composeSkills({ skills: RENDER_SKILLS, mode: 'mounted', skillDir: null }),
    ).toThrow(/cannot receive skill files/)
    expect(() => composeSkills({ skills: RENDER_SKILLS, mode: 'mounted' })).toThrow(
      /cannot receive skill files/,
    )
  })
})

describe('mergeComposedSkills', () => {
  it('concatenates refs, prompt sections, and delivered ids in batch order', () => {
    const a = composeSkills({ skills: [RENDER_SKILLS[0]!], mode: 'mounted', skillDir: '.opencode/skills' })
    const b = composeSkills({ skills: [RENDER_SKILLS[1]!], mode: 'mounted', skillDir: '.opencode/skills' })
    const merged = mergeComposedSkills([a, b])
    expect(merged.refs.map((r) => r.name)).toEqual(['human-prose', 'efiling'])
    expect(merged.promptSection).toBe(`${a.promptSection}${b.promptSection}`)
    expect(merged.mountedIds).toEqual(['human-prose', 'efiling'])
    expect(merged.inlineIds).toEqual([])
  })

  it('throws naming the id when a skill is delivered both inline and mounted', () => {
    const inline = composeSkills({ skills: [RENDER_SKILLS[0]!], mode: 'inline' })
    const mounted = composeSkills({ skills: RENDER_SKILLS, mode: 'mounted', skillDir: '.opencode/skills' })
    expect(() => mergeComposedSkills([inline, mounted])).toThrow(/human-prose/)
  })
})

describe('assertSkillDeliveryDisjoint', () => {
  it('does not throw on disjoint id sets', () => {
    expect(() => assertSkillDeliveryDisjoint(['a', 'b'], ['c', 'd'])).not.toThrow()
  })

  it('throws naming every overlapping id', () => {
    let message = ''
    try {
      assertSkillDeliveryDisjoint(['a', 'b', 'c'], ['b', 'c', 'd'])
      throw new Error('expected assertSkillDeliveryDisjoint to throw')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('b')
    expect(message).toContain('c')
  })
})
