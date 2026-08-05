import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCommand } from './exec'

/**
 * Two properties of the subprocess primitive that nothing else asserts, both of
 * which fail silently if they regress.
 */

const created: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-exec-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runCommand', () => {
  it('reports a non-zero exit as data rather than throwing — a failing step is not an exception', async () => {
    const result = await runCommand({ command: 'exit 3', cwd: temp() })
    expect(result.exitCode).toBe(3)
  })

  it('interleaves stdout and stderr, because a failure log is both', async () => {
    const result = await runCommand({ command: 'echo out; echo err 1>&2', cwd: temp() })
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  it('keeps BOTH ends of a long log and states the elision — never a silent truncation', async () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'noisy.mjs'),
      "process.stdout.write('FIRST-LINE\\n')\n" +
        "for (let i = 0; i < 20000; i++) process.stdout.write('x'.repeat(200) + '\\n')\n" +
        "process.stdout.write('LAST-LINE\\n')\n",
    )
    const result = await runCommand({ command: 'node noisy.mjs', cwd: dir, maxOutputBytes: 50_000 })

    expect(result.truncated).toBe(true)
    // The head carries the first error, the tail carries the summary; a gate
    // that keeps only one of them hides half of every long failure.
    expect(result.output).toContain('FIRST-LINE')
    expect(result.output).toContain('LAST-LINE')
    expect(result.output).toMatch(/\[signoff\] \d+ bytes elided/)
    expect(result.output.length).toBeLessThan(120_000)
  })

  it('does not elide, or claim to, when the output fits', async () => {
    const result = await runCommand({ command: 'echo small', cwd: temp() })
    expect(result.truncated).toBe(false)
    expect(result.output).not.toContain('elided')
  })

  it('kills the whole process GROUP — a bare shell kill orphans vitest forks and the dts worker', async () => {
    const dir = temp()
    // Grandchild: `sh -c` spawns node, node spawns a detached-looking sleeper
    // that keeps writing. If only the shell is signalled, this keeps running.
    writeFileSync(
      join(dir, 'parent.mjs'),
      "import { spawn } from 'node:child_process'\n" +
        "spawn(process.execPath, ['child.mjs'], { stdio: 'inherit' })\n" +
        'setInterval(() => {}, 1000)\n',
    )
    writeFileSync(
      join(dir, 'child.mjs'),
      "import { appendFileSync } from 'node:fs'\n" +
        "setInterval(() => appendFileSync('alive.txt', 'tick\\n'), 30)\n",
    )
    writeFileSync(join(dir, 'alive.txt'), '')

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const result = await runCommand({ command: 'node parent.mjs', cwd: dir, signal: controller.signal, killGraceMs: 300 })
    expect(result.signal).not.toBeNull()

    const afterKill = readFileSync(join(dir, 'alive.txt'), 'utf8').length
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(readFileSync(join(dir, 'alive.txt'), 'utf8').length).toBe(afterKill)
  })

  it('throws only when the process could not start at all', async () => {
    await expect(runCommand({ command: 'true', cwd: join(temp(), 'does-not-exist') })).rejects.toThrow(
      /could not start/,
    )
  })
})
