import { describe, expect, it, vi } from 'vitest'
import { createSandboxRunTool, SandboxRunError } from './sandbox-run-tool'

const box = { id: 'box-1' } as never

describe('createSandboxRunTool', () => {
  it('runs the task in the product box and returns the box agent answer, recorded on the warm lease', async () => {
    const runTask = vi.fn(async () => 'Form 8949 filled: /home/agent/output/8949.pdf')
    const turn = vi.fn(async () => ({}))
    const tool = createSandboxRunTool({ box: async () => box, runTask, warm: { leases: { turn }, key: 'ws-1' } })
    expect(tool.name).toBe('sandbox_run')
    const result = await tool.run({ task: 'Fill form 8949 from the uploaded CSV.' })
    expect(result.answer).toBe('Form 8949 filled: /home/agent/output/8949.pdf')
    expect(turn).toHaveBeenCalledWith('ws-1')
    expect(runTask).toHaveBeenCalledWith(box, 'Fill form 8949 from the uploaded CSV.',
      { signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) })
  })

  it('reports a box that cannot start as sandbox_unavailable, keeping a product refusal as it was', async () => {
    const onFailure = vi.fn()
    const runTask = vi.fn(async () => 'never')
    const down = createSandboxRunTool({ runTask, onFailure, box: async () => { throw new Error('capacity 429: org limit') } })
    const error = await down.run({ task: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxRunError)
    expect(error).toMatchObject({ code: 'sandbox_unavailable' })
    // The cause stays in the product's logs; the model reads only the typed message.
    expect((error as Error).message).not.toContain('429')
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'sandbox_unavailable', cause: expect.any(Error) }))

    const unpaid = createSandboxRunTool({ runTask, box: async () => {
      throw new SandboxRunError('sandbox_unavailable', 'Computer work needs a paid plan.')
    } })
    await expect(unpaid.run({ task: 'x' })).rejects.toMatchObject({ message: 'Computer work needs a paid plan.' })
    expect(runTask).not.toHaveBeenCalled()
  })

  it('ends a call at its cap even when the product runner ignores the signal', async () => {
    const tool = createSandboxRunTool({ box: async () => box, timeoutMs: 20, runTask: () => new Promise<string>(() => {}) })
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_failed', message: expect.stringContaining('did not finish') })
  })

  it('types a failed run and an empty answer instead of returning nothing', async () => {
    const runTask = vi.fn<(...args: unknown[]) => Promise<string>>()
    const tool = createSandboxRunTool({ box: async () => box, runTask })
    runTask.mockRejectedValueOnce(new Error('stream severed'))
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_failed' })
    runTask.mockResolvedValueOnce('   ')
    await expect(tool.run({ task: 'x' })).rejects.toMatchObject({ code: 'sandbox_empty' })
    await expect(tool.run({ task: '' })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })
})
