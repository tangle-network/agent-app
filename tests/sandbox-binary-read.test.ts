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

  it('keeps a newline inside the quotes rather than ending the command', () => {
    // A literal newline in a filename is legal on POSIX; unquoted it would
    // split the exec into two commands.
    expect(shellQuote('a\nrm -rf /\nb.png')).toBe("'a\nrm -rf /\nb.png'")
  })

  it('neutralises every metacharacter that could break out of the command', () => {
    for (const raw of ['a;b', 'a && b', 'a | b', 'a > b', '$(id)', '`id`', 'a\\b', '*', 'a"b']) {
      const quoted = shellQuote(raw)
      // Exactly one opening and one closing quote, and no bare `'` in between:
      // everything hazardous is inert content.
      expect(quoted.startsWith("'")).toBe(true)
      expect(quoted.endsWith("'")).toBe(true)
      expect(quoted.slice(1, -1).includes("'")).toBe(false)
    }
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

  it('rejects out-of-alphabet characters instead of skipping them like Buffer would', async () => {
    // The decoder choice is load-bearing: `Buffer.from(s, 'base64')` DROPS
    // characters outside the alphabet, so this corrupted payload would decode
    // to a plausible-looking 6 bytes and sail past the length check. Pinning
    // Buffer's behaviour here means a swap back to it fails this test.
    const corrupted = `${base64Of(payload).slice(0, 4)}*!${base64Of(payload).slice(4)}`
    expect(Buffer.from(corrupted, 'base64').byteLength).toBe(payload.length)

    const outcome = await readSandboxBinaryBytes(execBox(() => ok(corrupted)), '/a.png', payload.length)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error).toContain('could not decode file contents')
  })

  it('rejects a payload that is longer than expected, not just shorter', async () => {
    const box = execBox(() => ok(base64Of([...payload, 0x01, 0x02, 0x03])))
    const outcome = await readSandboxBinaryBytes(box, '/a.png', payload.length)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error).toContain(`expected ${payload.length}`)
  })

  it('quotes the path it reads, so an arbitrary in-box filename cannot inject', async () => {
    const box = execBox(() => ok(base64Of(payload)))
    await readSandboxBinaryBytes(box, "/home/a b/it's; rm -rf /.png", payload.length)
    expect(box.exec).toHaveBeenCalledWith(`base64 '/home/a b/it'"'"'s; rm -rf /.png'`)
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
