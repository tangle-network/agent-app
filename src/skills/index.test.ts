import { describe, expect, it } from 'vitest'
import {
  composeShellResources,
  corpusSkills,
  loadMarkdownCorpus,
  registrySkills,
  skillMountPath,
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
