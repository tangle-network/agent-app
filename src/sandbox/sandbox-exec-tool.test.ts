import { describe, expect, it, vi } from 'vitest'
import { createSandboxExecTool } from './sandbox-exec-tool'
import { SandboxRunError } from './sandbox-run-tool'

function fakeBox(exec: (command: string, options?: Record<string, unknown>) => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  return { id: 'box-1', exec: vi.fn(exec) } as never as { id: string; exec: ReturnType<typeof vi.fn> }
}

describe('createSandboxExecTool', () => {
  it('prepares the box once, runs each command and returns its exit code, output and files', async () => {
    const box = fakeBox(async command => command.includes('fail')
      ? { exitCode: 2, stdout: '', stderr: 'no such form' }
      : { exitCode: 0, stdout: 'filled 1040', stderr: '' })
    const prepare = vi.fn(async () => {})
    const tool = createSandboxExecTool({ box: async () => box as never, prepare, cwd: '/home/agent',
      listFiles: async () => ['/home/agent/output/1040.pdf'] })
    expect(tool.name).toBe('sandbox_exec')
    await expect(tool.run({ command: 'tax-python fill_form.py --form 1040' })).resolves.toMatchObject({
      exitCode: 0, stdout: 'filled 1040', files: ['/home/agent/output/1040.pdf'] })
    // A non-zero exit is a result the model reads, not a failure.
    await expect(tool.run({ command: 'tax-python fail.py' })).resolves.toMatchObject({ exitCode: 2, stderr: 'no such form' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(box.exec).toHaveBeenCalledWith('tax-python fill_form.py --form 1040', expect.objectContaining({ cwd: '/home/agent' }))
  })

  it('types a box that cannot start or be prepared, and retries the start on the next call', async () => {
    let attempts = 0
    const onFailure = vi.fn()
    const tool = createSandboxExecTool({ onFailure, box: async () => {
      attempts++
      if (attempts === 1) throw new Error('capacity')
      return fakeBox(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })) as never
    } })
    await expect(tool.run({ command: 'ls' })).rejects.toMatchObject({ code: 'sandbox_unavailable' })
    expect(onFailure).toHaveBeenCalledWith(expect.any(SandboxRunError))
    await expect(tool.run({ command: 'ls' })).resolves.toMatchObject({ exitCode: 0 })

    const unprepared = createSandboxExecTool({ box: async () => fakeBox(async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never,
      prepare: async () => { throw new Error('pip failed') } })
    await expect(unprepared.run({ command: 'ls' })).rejects.toMatchObject({ code: 'sandbox_unavailable',
      message: expect.stringContaining('could not be prepared') })
  })

  it('caps a hung command, keeps the tail of long output, and applies the product policy', async () => {
    const hung = createSandboxExecTool({ timeoutMs: 20, box: async () => fakeBox(() => new Promise(() => {})) as never })
    await expect(hung.run({ command: 'sleep 999' })).rejects.toMatchObject({ code: 'sandbox_failed', message: expect.stringContaining('did not finish') })

    const long = createSandboxExecTool({ maxOutputChars: 5, box: async () => fakeBox(async () => ({ exitCode: 0, stdout: '0123456789', stderr: '' })) as never })
    await expect(long.run({ command: 'cat big' })).resolves.toMatchObject({ stdout: '…56789', truncated: true })

    const policed = createSandboxExecTool({ allow: command => command.startsWith('rm ') ? 'Deleting files is not allowed here.' : null,
      box: async () => fakeBox(async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never })
    await expect(policed.run({ command: 'rm -rf /home/agent' })).rejects.toMatchObject({ code: 'invalid_arguments',
      message: 'Deleting files is not allowed here.' })
  })
})
