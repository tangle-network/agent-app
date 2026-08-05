/**
 * Argv and config loading are split out of `cli.ts` precisely so they can be
 * exercised without a `main()` that calls `process.exit`. The load path matters
 * more than it looks: a config that silently produced empty options would make
 * the whole gate pass on nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SpendUsageError, USAGE, loadSpendConfig, parseSpendArgs } from './cli-args'

describe('parseSpendArgs', () => {
  it('defaults to the conventional config file and a table report', () => {
    expect(parseSpendArgs([])).toEqual({
      configFile: 'spend.config.mjs',
      json: false,
      asOf: undefined,
      skip: [],
    })
  })

  it('reads every flag', () => {
    const args = parseSpendArgs([
      '--config', 'custom.mjs',
      '--json',
      '--as-of', '2026-08-05T04:00:00.000Z',
      '--skip', 'velocity, negative-balance',
    ])
    expect(args.configFile).toBe('custom.mjs')
    expect(args.json).toBe(true)
    expect(args.asOf).toBe(Date.parse('2026-08-05T04:00:00.000Z'))
    expect(args.skip).toEqual(['velocity', 'negative-balance'])
  })

  it('rejects a flag with a missing or unusable value rather than guessing', () => {
    expect(() => parseSpendArgs(['--config'])).toThrow(SpendUsageError)
    expect(() => parseSpendArgs(['--as-of'])).toThrow(SpendUsageError)
    expect(() => parseSpendArgs(['--as-of', 'yesterday'])).toThrow(/not a date/)
    expect(() => parseSpendArgs(['--skip'])).toThrow(SpendUsageError)
    expect(() => parseSpendArgs(['--wat'])).toThrow(/unrecognized argument/)
  })

  it('documents every flag it accepts', () => {
    for (const flag of ['--config', '--json', '--as-of', '--skip']) {
      expect(USAGE).toContain(flag)
    }
  })
})

describe('loadSpendConfig', () => {
  function withConfig(source: string, run: (file: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-app-spend-'))
    const file = join(dir, 'spend.config.mjs')
    writeFileSync(file, source)
    return run(file).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('loads a default-exported options object', async () => {
    await withConfig('export default { rows: [], store: { load: 1 } }', async (file) => {
      const config = await loadSpendConfig(file)
      expect(config.rows).toEqual([])
    })
  })

  it('awaits a function export, so a config can open its own connections', async () => {
    await withConfig(
      'export default async () => ({ rows: [{ id: "a" }], store: {} })',
      async (file) => {
        const config = await loadSpendConfig(file)
        expect(config.rows).toHaveLength(1)
      },
    )
  })

  it('accepts a `config` named export as well as `default`', async () => {
    await withConfig('export const config = { rows: [], store: {} }', async (file) => {
      await expect(loadSpendConfig(file)).resolves.toBeDefined()
    })
  })

  it('refuses a config missing the two things this package cannot supply', async () => {
    await withConfig('export default { store: {} }', async (file) => {
      await expect(loadSpendConfig(file)).rejects.toThrow(/must supply `rows`/)
    })
    await withConfig('export default { rows: [] }', async (file) => {
      await expect(loadSpendConfig(file)).rejects.toThrow(/must supply `store`/)
    })
    await withConfig('export default 42', async (file) => {
      await expect(loadSpendConfig(file)).rejects.toThrow(/must export reconcile options/)
    })
  })

  it('reports a missing config as a usage error, not a crash', async () => {
    await expect(loadSpendConfig('/nonexistent/spend.config.mjs')).rejects.toThrow(SpendUsageError)
  })
})
