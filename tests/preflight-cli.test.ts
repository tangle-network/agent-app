/**
 * `agent-app-preflight` — the deploy-time probe runner bin.
 *
 * The failure this guards is the one that makes a preflight worse than useless:
 * a config that resolves to nothing, runs nothing, and exits 0, reporting the
 * deploy as verified. Every miss must throw.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProbes, runPreflightCli } from '../src/preflight/cli'

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-app-preflight-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('loadProbes', () => {
  it('throws when the config file does not exist', async () => {
    await expect(loadProbes(join(scratch(), 'nope.mjs'))).rejects.toThrow(/no config at/)
  })

  it('throws when the config default-exports a non-array', async () => {
    const dir = scratch()
    const file = join(dir, 'preflight.config.mjs')
    writeFileSync(file, 'export default { probes: [] }\n')
    await expect(loadProbes(file)).rejects.toThrow(/must default-export an array/)
  })

  it('throws on an empty probe list rather than reporting a verified deploy', async () => {
    const dir = scratch()
    const file = join(dir, 'preflight.config.mjs')
    writeFileSync(file, 'export default []\n')
    await expect(loadProbes(file)).rejects.toThrow(/empty probe list/)
  })

  it('loads the probes a valid config exports', async () => {
    const dir = scratch()
    const file = join(dir, 'preflight.config.mjs')
    writeFileSync(file, "export default [{ name: 'a', critical: true, run: async () => ({ ok: true }) }]\n")
    const probes = await loadProbes(file)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.name).toBe('a')
  })
})

describe('runPreflightCli', () => {
  it('exits 0 and prints the report when every probe passes', async () => {
    const dir = scratch()
    const file = join(dir, 'ok.config.mjs')
    writeFileSync(file, "export default [{ name: 'router', critical: true, run: async () => ({ ok: true, detail: 'live' }) }]\n")
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(runPreflightCli([file])).resolves.toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('router')
  })

  it('exits 1 when a critical probe fails, so a deploy step can gate on it', async () => {
    const dir = scratch()
    const file = join(dir, 'bad.config.mjs')
    writeFileSync(
      file,
      "export default [{ name: 'router', critical: true, run: async () => ({ ok: false, detail: '401' }) }]\n",
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(runPreflightCli([file])).resolves.toBe(1)
  })
})
