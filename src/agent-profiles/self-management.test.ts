import { describe, expect, it } from 'vitest'
import {
  PERMITTED_SELF_MOUNT_DIMENSIONS,
  createInMemorySelfMountStorage,
  createMountProfileChangeTool,
} from './self-management'
import { ToolInputError } from '../tools/errors'
import type { AppToolContext } from '../tools/types'

const CATALOG = [
  { id: 'cad', description: 'parametric CAD' },
  { id: 'pcb-layout', description: 'tscircuit to KiCad' },
  { id: 'spice', description: 'SPICE simulation' },
  { id: 'jlcpcb', description: 'JLCPCB orders' },
]

const ctx: AppToolContext = { userId: 'u1', workspaceId: 'w1', threadId: 't1' }

function makeTool(storage = createInMemorySelfMountStorage()) {
  return {
    tool: createMountProfileChangeTool({
      skills: CATALOG,
      storage,
      scopeKey: (c) => c.threadId ?? c.userId,
      baseline: 'cad',
    }),
    storage,
  }
}

const call = (tool: ReturnType<typeof makeTool>['tool'], changes: unknown) => tool.execute({ changes }, ctx)

describe('createMountProfileChangeTool', () => {
  it('permits only the skills dimension', async () => {
    const { tool } = makeTool()
    await expect(call(tool, { model: 'gpt-9' })).rejects.toThrow(/not agent-changeable/)
    await expect(call(tool, { skills: { add: ['spice'] }, permissions: {} })).rejects.toThrow(
      /not agent-changeable.*skills/s,
    )
    expect(PERMITTED_SELF_MOUNT_DIMENSIONS).toEqual(['skills'])
  })

  it('refuses unknown ids with the catalog', async () => {
    const { tool } = makeTool()
    await expect(call(tool, { skills: { add: ['nope'] } })).rejects.toThrow(/unknown skill ids.*cad/s)
  })

  it('protects the baseline', async () => {
    const { tool } = makeTool()
    await expect(call(tool, { skills: { remove: ['cad'] } })).rejects.toThrow(/baseline/)
  })

  it('applies, persists, and is idempotent', async () => {
    const { tool, storage } = makeTool()
    const first = (await call(tool, { skills: { add: ['pcb-layout', 'jlcpcb'] } })) as {
      mounted: string[]
      effective: string[]
    }
    expect(first.mounted).toEqual(['jlcpcb', 'pcb-layout'])
    expect(await storage.get('t1')).toEqual(['cad', 'jlcpcb', 'pcb-layout'])

    const again = (await call(tool, { skills: { add: ['pcb-layout', 'jlcpcb'] } })) as {
      mounted: string[]
      note: string
    }
    expect(again.mounted).toEqual([])
    expect(again.note).toMatch(/idempotent no-op/)

    const partial = (await call(tool, { skills: { remove: ['jlcpcb'], add: ['spice'] } })) as { effective: string[] }
    expect(partial.effective).toEqual(['cad', 'pcb-layout', 'spice'])
  })

  it('scopes storage by the product key', async () => {
    const { tool, storage } = makeTool()
    await call(tool, { skills: { add: ['spice'] } })
    expect(await storage.get('t1')).toContain('spice')
    expect(await storage.get('other-thread')).toEqual([])
  })

  it('enforces the mount cap', async () => {
    const tool = createMountProfileChangeTool({
      skills: CATALOG,
      storage: createInMemorySelfMountStorage(),
      scopeKey: () => 's',
      baseline: 'cad',
      maxMounted: 2,
    })
    await call(tool, { skills: { add: ['pcb-layout'] } })
    await expect(call(tool, { skills: { add: ['spice'] } })).rejects.toThrow(/mount limit/)
  })

  it('lists the catalog in the description and refusals carry the code', async () => {
    const { tool } = makeTool()
    expect(tool.description).toMatch(/pcb-layout \(tscircuit to KiCad\)/)
    try {
      await call(tool, { skills: { add: ['nope'] } })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ToolInputError)
      expect((e as ToolInputError).code).toBe('mount_profile_change')
    }
  })
})
