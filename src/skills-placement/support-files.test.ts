import { describe, expect, it } from 'vitest'
import {
  resolveSkillDir,
  skillSupportFileMounts,
  withSkillSupportFiles,
  type SkillSupportFile,
} from './index'
import type { AgentProfile, AgentProfileFileMount } from '@tangle-network/agent-interface'

const kit: SkillSupportFile[] = [
  { path: 'kit/iso-kit.mjs', content: 'export {}' },
  { path: 'kit/iso.css', content: 'body { margin: 0 }' },
]

function inlineMount(path: string, content: string): AgentProfileFileMount {
  return { path, resource: { kind: 'inline', name: path.replaceAll('/', '_'), content } }
}

describe('skillSupportFileMounts', () => {
  it('places files beside the skill entry in each harness native tree', () => {
    expect(skillSupportFileMounts('opencode', 'anatomy', kit).map((m) => m.path)).toEqual([
      '.opencode/skills/anatomy/kit/iso-kit.mjs',
      '.opencode/skills/anatomy/kit/iso.css',
    ])
    expect(skillSupportFileMounts('pi', 'anatomy', kit).map((m) => m.path)).toEqual([
      '.pi/skills/anatomy/kit/iso-kit.mjs',
      '.pi/skills/anatomy/kit/iso.css',
    ])
  })

  it('mounts nothing for a harness without a cwd skill dir', () => {
    expect(skillSupportFileMounts('hermes', 'anatomy', kit)).toEqual([])
    expect(resolveSkillDir('hermes')).toBeNull()
  })

  it('is empty for an empty kit', () => {
    expect(skillSupportFileMounts('opencode', 'anatomy', [])).toEqual([])
  })
})

describe('withSkillSupportFiles', () => {
  it('attaches the mounts and is a no-op when already attached', () => {
    const once = withSkillSupportFiles({} as AgentProfile, 'opencode', 'anatomy', kit)
    const twice = withSkillSupportFiles(once, 'opencode', 'anatomy', kit)
    expect(once.resources?.files).toHaveLength(2)
    expect(twice).toBe(once)
  })

  it('re-deriving for another harness replaces its own mounts wherever they pointed', () => {
    const onOpenCode = withSkillSupportFiles({} as AgentProfile, 'opencode', 'anatomy', kit)
    const onPi = withSkillSupportFiles(onOpenCode, 'pi', 'anatomy', kit)
    const paths = onPi.resources?.files?.map((m) => m.path) ?? []
    expect(paths).toContain('.pi/skills/anatomy/kit/iso-kit.mjs')
    expect(paths.some((p) => p.startsWith('.opencode/'))).toBe(false)
  })

  it('drops its own mounts for a harness with no skill dir', () => {
    const mounted = withSkillSupportFiles({} as AgentProfile, 'opencode', 'anatomy', kit)
    const onHermes = withSkillSupportFiles(mounted, 'hermes', 'anatomy', kit)
    expect(onHermes.resources?.files ?? []).toEqual([])
  })

  it('a pack-declared mount at one of our paths keeps the location (exact-bytes replacement only)', () => {
    const foreign = inlineMount('.opencode/skills/anatomy/kit/iso-kit.mjs', 'DIFFERENT bytes')
    const base = { resources: { files: [foreign] } } as unknown as AgentProfile
    const out = withSkillSupportFiles(base, 'opencode', 'anatomy', kit)
    const byPath = new Map((out.resources?.files ?? []).map((m) => [m.path, m]))
    expect(byPath.get('.opencode/skills/anatomy/kit/iso-kit.mjs')?.resource).toEqual({
      kind: 'inline',
      name: foreign.resource.name,
      content: 'DIFFERENT bytes',
    })
    // The kit still lands its OTHER file; nothing was duplicated.
    expect((out.resources?.files ?? []).length).toBe(2)
  })

  it('does not reclaim a different skill subtree with matching bytes', () => {
    const otherSkill = inlineMount('.opencode/skills/cad/kit/iso-kit.mjs', 'export {}')
    const base = { resources: { files: [otherSkill] } } as unknown as AgentProfile
    const out = withSkillSupportFiles(base, 'opencode', 'anatomy', kit)
    const paths = (out.resources?.files ?? []).map((m) => m.path)
    expect(paths).toContain('.opencode/skills/cad/kit/iso-kit.mjs')
    expect(paths).toContain('.opencode/skills/anatomy/kit/iso-kit.mjs')
  })
})
