import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./index')>()),
  runSandboxPrompt: vi.fn(),
}))

import { runSandboxPrompt, type SandboxRuntimeConfig } from './index'
import { createSandboxRunTool, SandboxRunError } from './sandbox-run-tool'

const shell = {} as SandboxRuntimeConfig
const box = { id: 'box-1' } as never
const runPrompt = vi.mocked(runSandboxPrompt)

describe('createSandboxRunTool', () => {
  beforeEach(() => runPrompt.mockReset())

  it('runs the task in the product box and returns the box agent answer, recorded on the warm lease', async () => {
    runPrompt.mockResolvedValue('Form 8949 filled: /home/agent/output/8949.pdf')
    const turn = vi.fn(async () => ({}))
    const tool = createSandboxRunTool({ shell, box: async () => box, prompt: { sessionId: 's-1', model: 'm' },
      warm: { leases: { turn }, key: 'ws-1' } })
    expect(tool.name).toBe('sandbox_run')
    const result = await tool.run({ task: 'Fill form 8949 from the uploaded CSV.' })
    expect(result.answer).toBe('Form 8949 filled: /home/agent/output/8949.pdf')
    expect(turn).toHaveBeenCalledWith('ws-1')
    expect(runPrompt).toHaveBeenCalledWith(shell, box, 'Fill form 8949 from the uploaded CSV.',
      expect.objectContaining({ sessionId: 's-1', model: 'm', disallowQuestions: true, signal: expect.any(AbortSignal) }))
  })

  it('reports a box that cannot start as sandbox_unavailable, keeping a product refusal as it was', async () => {
    const onFailure = vi.fn()
    const down = createSandboxRunTool({ shell, onFailure, box: async () => { throw new Error('capacity 429: org limit') } })
    const error = await down.run({ task: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxRunError)
    expect(error).toMatchObject({ code: 'sandbox_unavailable' })
    // The cause stays in the product's logs; the model reads only the typed message.
    expect((error as Error).message).not.toContain('429')
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'sandbox_unavailable', cause: expect.any(Error) }))

    const unpaid = createSandboxRunTool({ shell, box: async () => {
      throw new SandboxRunError('sandbox_unavailable', 'Computer work needs a paid plan.')
    } })
    await expect(unpaid.run({ task: 'x' })).rejects.toMatchObject({ message: 'Computer work needs a paid plan.' })
    expect(runPrompt).not.toHaveBeenCalled()
  })

  it('uses the product runner when it brings one', async () => {
    const runTask = vi.fn(async () => 'done in the GTM box')
    const tool = createSandboxRunTool({ box: async () => box, runTask })
    await expect(tool.run({ task: 'Export the leads sheet.' })).resolves.toMatchObject({ answer: 'done in the GTM box' })
    expect(runTask).toHaveBeenCalledWith(box, 'Export the leads sheet.', { signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) })
    expect(runPrompt).not.toHaveBeenCalled()
    expect(() => createSandboxRunTool({ box: async () => box })).toThrow(/shell or a runTask/)
  })

  it('ends a call at its cap even when the product runner ignores the signal', async () => {
    const tool = createSandboxRunTool({ box: async () => box, timeoutMs: 20, runTask: () => new Promise<string>(() => {}) })
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_failed', message: expect.stringContaining('did not finish') })
  })

  it('types a failed run and an empty answer instead of returning nothing', async () => {
    const tool = createSandboxRunTool({ shell, box: async () => box })
    runPrompt.mockRejectedValueOnce(new Error('stream severed'))
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_failed' })
    runPrompt.mockResolvedValueOnce('   ')
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_empty' })
    await expect(tool.run({ task: '' })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })
})
