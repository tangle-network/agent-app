import { describe, expect, it } from 'vitest'
import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileMcpServer,
} from '@tangle-network/sandbox'
import {
  composeAgentProfile,
  makeEvolvableSection,
  stripComments,
  userSkillMounts,
  type ProfileChannels,
  type SkillEntry,
  type UserSkill,
} from './index'

/** Index a record under `noUncheckedIndexedAccess`, failing loud if absent. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value to be present')
  return value
}

const stdio = (command: string): AgentProfileMcpServer => ({ transport: 'stdio', command })

/** A canonical base profile with one baseline file, one baseline MCP server,
 *  and a base system prompt — the shape a product's `gtmAgentProfile` carries. */
const BASE: AgentProfile = {
  name: 'base-agent',
  prompt: { systemPrompt: 'base prompt', instructions: ['keep this'] },
  mcp: { delegation: stdio('delegation') },
  resources: {
    files: [{ path: 'doctrine/SOUL.md', resource: { kind: 'inline', name: 'soul', content: 'soul' } }],
  },
}

const CORPUS: AgentProfileFileMount[] = [
  { path: 'skills/icp.md', resource: { kind: 'inline', name: 'skills-icp', content: 'icp' } },
]

const REGISTRY: SkillEntry[] = [
  { id: 'human-prose', name: 'Human Prose', description: 'free', tier: 'free', skillMd: 'free body' },
  { id: 'efiling', name: 'E-Filing', description: 'paid', tier: 'paid', skillMd: 'paid body' },
]

const USER_SKILLS: UserSkill[] = [{ id: 'my-niche', skillMd: '# My Niche\n\nuser body' }]

describe('userSkillMounts', () => {
  it('mounts user skills at the harness path, sorted', () => {
    const mounts = userSkillMounts([
      { id: 'zeta', skillMd: 'z' },
      { id: 'alpha', skillMd: 'a' },
    ])
    expect(mounts.map((m) => m.path)).toEqual([
      '~/.claude/skills/alpha/SKILL.md',
      '~/.claude/skills/zeta/SKILL.md',
    ])
    const first = must(mounts[0]).resource
    expect(first.kind).toBe('inline')
    if (first.kind === 'inline') expect(first.content).toBe('a')
  })
})

describe('composeAgentProfile — file channels', () => {
  it('concatenates base files first, then skills -> registry(free) -> userSkills', () => {
    const channels: ProfileChannels = {
      skills: CORPUS,
      registry: REGISTRY,
      userSkills: USER_SKILLS,
    }
    const out = composeAgentProfile(BASE, channels)
    expect(must(out.resources).files?.map((m) => m.path)).toEqual([
      'doctrine/SOUL.md',
      'skills/icp.md',
      '~/.claude/skills/human-prose/SKILL.md',
      '~/.claude/skills/my-niche/SKILL.md',
    ])
  })

  it('tier-gates the registry: the paid entry is never mounted', () => {
    const out = composeAgentProfile(BASE, { registry: REGISTRY })
    const paths = must(out.resources).files?.map((m) => m.path) ?? []
    expect(paths).not.toContain('~/.claude/skills/efiling/SKILL.md')
    expect(paths).toContain('~/.claude/skills/human-prose/SKILL.md')
  })

  it('a user skill colliding with a registry skill is appended last (last-wins)', () => {
    const out = composeAgentProfile(BASE, {
      registry: REGISTRY,
      userSkills: [{ id: 'human-prose', skillMd: 'user override body' }],
    })
    const files = must(out.resources).files ?? []
    const collisionPath = '~/.claude/skills/human-prose/SKILL.md'
    const hits = files.filter((m) => m.path === collisionPath)
    expect(hits.length).toBe(2)
    const last = must(hits[hits.length - 1]).resource
    if (last.kind === 'inline') expect(last.content).toBe('user override body')
  })

  it('mounts the userSkills channel even when no registry is present', () => {
    const out = composeAgentProfile(BASE, { userSkills: USER_SKILLS })
    expect(must(out.resources).files?.map((m) => m.path)).toEqual([
      'doctrine/SOUL.md',
      '~/.claude/skills/my-niche/SKILL.md',
    ])
  })

  it('filesPredicate drops mounts across every channel including userSkills', () => {
    const out = composeAgentProfile(BASE, {
      skills: CORPUS,
      userSkills: USER_SKILLS,
      filesPredicate: (m) => !m.path.startsWith('~/.claude/skills/'),
    })
    const paths = must(out.resources).files?.map((m) => m.path) ?? []
    expect(paths).toEqual(['doctrine/SOUL.md', 'skills/icp.md'])
  })
})

describe('composeAgentProfile — overlay (mcp / prompt / name)', () => {
  it('merges extra MCP last-wins per key over the base servers', () => {
    const out = composeAgentProfile(
      BASE,
      {},
      { mcp: { appTools: stdio('app-tools'), delegation: stdio('delegation-override') } },
    )
    const mcp = must(out.mcp)
    expect(Object.keys(mcp).sort()).toEqual(['appTools', 'delegation'])
    expect(must(mcp.delegation).command).toBe('delegation-override')
    expect(must(mcp.appTools).command).toBe('app-tools')
  })

  it('keeps the base MCP map intact when no overlay mcp is given', () => {
    const out = composeAgentProfile(BASE, {})
    expect(Object.keys(must(out.mcp))).toEqual(['delegation'])
  })

  it('overrides systemPrompt while preserving base instructions', () => {
    const out = composeAgentProfile(BASE, {}, { systemPrompt: 'per-turn prompt' })
    expect(must(out.prompt).systemPrompt).toBe('per-turn prompt')
    expect(must(out.prompt).instructions).toEqual(['keep this'])
  })

  it('passes the base prompt through unchanged when no override is given', () => {
    const out = composeAgentProfile(BASE, {})
    expect(must(out.prompt).systemPrompt).toBe('base prompt')
  })

  it('overrides name when set, keeps base name otherwise', () => {
    expect(composeAgentProfile(BASE, {}, { name: 'workspace-42' }).name).toBe('workspace-42')
    expect(composeAgentProfile(BASE, {}).name).toBe('base-agent')
  })

  it('does not mutate the base profile', () => {
    const baseFiles = must(BASE.resources).files?.length
    composeAgentProfile(BASE, { skills: CORPUS, userSkills: USER_SKILLS }, { name: 'x' })
    expect(must(BASE.resources).files?.length).toBe(baseFiles)
    expect(BASE.name).toBe('base-agent')
  })
})

describe('stripComments', () => {
  it('strips HTML comments and trims', () => {
    expect(stripComments('<!-- placeholder -->\n  ')).toBe('')
    expect(stripComments('<!-- note -->real body')).toBe('real body')
  })
})

describe('makeEvolvableSection', () => {
  it('uses the loaded body when populated, trimmed', () => {
    const section = makeEvolvableSection({
      id: 'learned-guidance',
      title: 'Learned guidance',
      load: () => '  evolved body  ',
      baseline: 'BASELINE',
    })
    expect(section).toEqual({
      id: 'learned-guidance',
      title: 'Learned guidance',
      body: 'evolved body',
      evolvable: true,
    })
  })

  it('falls back to the baseline when the loaded body is all comments', () => {
    const section = makeEvolvableSection({
      id: 'learned-guidance',
      title: 'Learned guidance',
      load: () => '<!-- no gated promotion yet -->',
      baseline: 'BASELINE BODY',
    })
    expect(section.body).toBe('BASELINE BODY')
  })

  it('falls back to the baseline when the loader returns empty', () => {
    const section = makeEvolvableSection({
      id: 'learned-guidance',
      title: 'Learned guidance',
      load: () => '',
      baseline: 'BASELINE BODY',
    })
    expect(section.body).toBe('BASELINE BODY')
    expect(section.evolvable).toBe(true)
  })
})

describe('composeAgentProfile — canonical wire shape', () => {
  it('prunes empty resource channels the SDK merge normalizes in', () => {
    const out = composeAgentProfile(BASE, {})
    const res = (out.resources ?? {}) as Record<string, unknown>
    // No empty tools/skills/agents/commands arrays leak to the wire payload.
    for (const k of ['tools', 'skills', 'agents', 'commands']) {
      expect(Array.isArray(res[k]) && (res[k] as unknown[]).length === 0).toBe(false)
    }
  })

  it('merges an instructions overlay onto the prompt', () => {
    const out = composeAgentProfile(BASE, {}, { instructions: ['per-turn directive'] })
    expect(out.prompt?.instructions).toContain('per-turn directive')
  })
})
