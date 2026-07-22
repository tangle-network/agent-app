import { describe, expect, it, vi } from 'vitest'

import {
  readSandboxBinaryBytes,
  shellQuote,
  statSandboxFileSize,
  type SandboxExecChannel,
} from '../src/sandbox/binary-read'

function execBox(
  handler: (command: string, options?: { sessionId?: string }) => unknown,
): SandboxExecChannel & { exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async (command: string, options?: { sessionId?: string }) => {
    const result = handler(command, options)
    if (result instanceof Error) throw result
    return result as { stdout: string; stderr: string; exitCode: number }
  })
  return { exec } as unknown as SandboxExecChannel & { exec: ReturnType<typeof vi.fn> }
}

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

function base64Of(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

describe('shellQuote', () => {
  it('single-quotes ordinary paths', () => {
    expect(shellQuote('/home/agent/a.png')).toBe("'/home/agent/a.png'")
  })

  it('neutralises spaces, $ and backticks — in-box filenames are arbitrary', () => {
    expect(shellQuote('/home/agent/my $file `x`.png')).toBe("'/home/agent/my $file `x`.png'")
  })

  it('closes and reopens the quote around an embedded single quote', () => {
    expect(shellQuote("it's.png")).toBe(`'it'"'"'s.png'`)
  })
})

describe('statSandboxFileSize', () => {
  it('parses `wc -c` output and quotes the path', async () => {
    const box = execBox(() => ok(' 2048\n'))

    await expect(statSandboxFileSize(box, "/home/a b/it's.png")).resolves.toEqual({
      succeeded: true,
      value: 2048,
    })
    expect(box.exec).toHaveBeenCalledWith(`wc -c < '/home/a b/it'"'"'s.png'`)
  })

  it('passes a sessionId through when given, and omits the options arg otherwise', async () => {
    const box = execBox(() => ok('1'))
    await statSandboxFileSize(box, '/f', { sessionId: 'sess-1' })
    expect(box.exec).toHaveBeenCalledWith(`wc -c < '/f'`, { sessionId: 'sess-1' })

    const plain = execBox(() => ok('1'))
    await statSandboxFileSize(plain, '/f')
    expect(plain.exec).toHaveBeenCalledWith(`wc -c < '/f'`)
  })

  it('fails with stderr on a non-zero exit', async () => {
    const box = execBox(() => ({ stdout: '', stderr: 'No such file', exitCode: 1 }))
    await expect(statSandboxFileSize(box, '/missing')).resolves.toEqual({
      succeeded: false,
      error: 'No such file',
    })
  })

  it('fails when the size is unparseable rather than reporting a silent zero', async () => {
    const box = execBox(() => ok('not-a-number'))
    const outcome = await statSandboxFileSize(box, '/f')
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error).toContain('not-a-number')
  })

  it('turns an exec throw into a typed failure', async () => {
    const box = execBox(() => new Error('runtime unreachable'))
    await expect(statSandboxFileSize(box, '/f')).resolves.toEqual({
      succeeded: false,
      error: 'runtime unreachable',
    })
  })
})

describe('readSandboxBinaryBytes', () => {
  const payload = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]

  it('decodes base64 stdout into the exact bytes', async () => {
    const box = execBox(() => ok(base64Of(payload)))

    const outcome = await readSandboxBinaryBytes(box, '/home/agent/a.png', payload.length)

    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect([...outcome.value.bytes]).toEqual(payload)
    expect(outcome.value.size).toBe(payload.length)
    expect(box.exec).toHaveBeenCalledWith(`base64 '/home/agent/a.png'`)
  })

  it('tolerates both wrapped (GNU, 76 cols) and unwrapped (BusyBox) output', async () => {
    const encoded = base64Of(payload)
    const wrapped = execBox(() => ok(`${encoded.slice(0, 4)}\n${encoded.slice(4)}\n`))

    const outcome = await readSandboxBinaryBytes(wrapped, '/a.png', payload.length)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect([...outcome.value.bytes]).toEqual(payload)
  })

  it('fails loud when the decoded length is short — a clipped exec never returns a truncated file', async () => {
    const clipped = base64Of(payload.slice(0, 3))
    const box = execBox(() => ok(clipped))

    const outcome = await readSandboxBinaryBytes(box, '/a.png', payload.length)

    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error).toContain('3 bytes')
    expect(outcome.error).toContain(`expected ${payload.length}`)
    expect(outcome.error).toContain('truncated')
  })

  it('fails when stdout is not decodable base64', async () => {
    const box = execBox(() => ok('!!! not base64 !!!'))
    const outcome = await readSandboxBinaryBytes(box, '/a.png', 4)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error).toContain('could not decode file contents')
  })

  it('fails with stderr on a non-zero exit', async () => {
    const box = execBox(() => ({ stdout: '', stderr: 'Permission denied', exitCode: 126 }))
    await expect(readSandboxBinaryBytes(box, '/a.png', 4)).resolves.toEqual({
      succeeded: false,
      error: 'Permission denied',
    })
  })

  it('turns an exec throw into a typed failure', async () => {
    const box = execBox(() => new Error('socket hang up'))
    await expect(readSandboxBinaryBytes(box, '/a.png', 4)).resolves.toEqual({
      succeeded: false,
      error: 'socket hang up',
    })
  })
})
