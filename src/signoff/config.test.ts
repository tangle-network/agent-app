import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveSignoffConfig, loadSignoffConfig, parseSignoffConfig } from './config'

/**
 * The step list is the repo's, not this module's. These pin the three sources
 * and the derivation's dependency claims — an omitted edge would be a
 * correctness bug (a step reading an artifact that is not built yet), and a
 * spurious one would silently give back the serial CI job this replaces.
 */

const created: string[] = []
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-config-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('deriveSignoffConfig', () => {
  it("derives agent-app's CI list from its own scripts", () => {
    const { config, used } = deriveSignoffConfig({
      build: 'tsup',
      test: 'vitest run',
      'test:gates': 'vitest run src/sandbox/index.test.ts',
      'test:generated': 'node .github/scripts/test-generated-projects.mjs',
      typecheck: 'tsc --noEmit',
      knip: 'knip',
      dev: 'tsup --watch',
    })
    expect(config.steps.map((step) => step.name)).toEqual([
      'typecheck',
      'incident-class gates',
      'unit tests',
      'build',
      'generated projects',
      'dead-surface (knip)',
    ])
    expect(used).not.toContain('dev')
  })

  it('makes only the artifact consumer wait: generated projects needs build, nothing else does', () => {
    const { config } = deriveSignoffConfig({ build: 'tsup', typecheck: 'tsc', test: 'vitest', 'test:generated': 'node x' })
    const byName = new Map(config.steps.map((step) => [step.name, step]))
    expect(byName.get('generated projects')?.needs).toEqual(['build'])
    expect(byName.get('typecheck')?.needs).toBeUndefined()
    expect(byName.get('unit tests')?.needs).toBeUndefined()
    expect(byName.get('build')?.needs).toBeUndefined()
  })

  it("derives legal-agent's list, and drops `build` because build:check already runs it", () => {
    const { config } = deriveSignoffConfig({
      build: 'react-router build',
      'build:check': 'pnpm build && bash scripts/check-bundle-size.sh',
      'peer-check': 'agent-app-peer-check',
      test: 'vitest --run',
      typecheck: 'react-router typegen && tsc --noEmit',
    })
    const names = config.steps.map((step) => step.name)
    expect(names).toContain('build + worker checks')
    expect(names).not.toContain('build')
  })

  it('marks the suite for shuffling and nothing else', () => {
    const { config } = deriveSignoffConfig({ test: 'vitest', typecheck: 'tsc', build: 'tsup' })
    expect(config.steps.filter((step) => step.shuffle === true).map((step) => step.name)).toEqual(['unit tests'])
  })

  it('refuses to invent a gate when there is nothing to run', () => {
    expect(() => deriveSignoffConfig({ dev: 'vite', deploy: 'wrangler deploy' })).toThrow(
      /no config and no recognizable scripts/,
    )
  })
})

describe('parseSignoffConfig', () => {
  it('names the offending path when a step is malformed', () => {
    expect(() => parseSignoffConfig({ steps: [{ name: 'x' }] }, 'test')).toThrow(/steps\.0\.run/)
  })

  it('rejects an empty step list rather than passing a run that verified nothing', () => {
    expect(() => parseSignoffConfig({ steps: [] }, 'test')).toThrow(/steps/)
  })

  it('accepts the full surface a real workflow needs — python step, filtered install, per-step env', () => {
    const config = parseSignoffConfig(
      {
        install: { run: 'pnpm install --frozen-lockfile --filter web...', storeEnv: 'NPM_CONFIG_STORE_DIR' },
        steps: [
          { name: 'peer floors', run: 'pnpm --filter web peer-check' },
          { name: 'tax toolkit', run: "python3 -m unittest discover -s packages/tax-toolkit -p 'test_*.py'" },
          { name: 'build', run: 'pnpm --filter web build', env: { NODE_OPTIONS: '--max-old-space-size=12288' } },
          { name: 'unit tests', run: 'pnpm --filter web test', shuffle: { runs: 3 } },
        ],
        maxParallel: 4,
      },
      'test',
    )
    expect(config.steps).toHaveLength(4)
    expect(config.install?.run).toContain('--filter web...')
  })
})

describe('loadSignoffConfig', () => {
  it('prefers signoff.config.mjs over the package.json key and over derivation', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, signoff: { steps: [{ name: 'from-pkg', run: 'true' }] } }))
    writeFileSync(join(repo, 'signoff.config.mjs'), 'export default { steps: [{ name: "from-file", run: "true" }] }\n')
    const loaded = await loadSignoffConfig({ repoRoot: repo })
    expect(loaded.config.steps[0]?.name).toBe('from-file')
    expect(loaded.origin.kind).toBe('file')
  })

  it('falls to the package.json key when there is no config file', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ signoff: { steps: [{ name: 'from-pkg', run: 'true' }] } }))
    const loaded = await loadSignoffConfig({ repoRoot: repo })
    expect(loaded.config.steps[0]?.name).toBe('from-pkg')
    expect(loaded.origin.kind).toBe('package-json')
  })

  it('stamps a derived origin with the scripts it used, so a weaker claim reads as one', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest' } }))
    const loaded = await loadSignoffConfig({ repoRoot: repo })
    expect(loaded.origin).toEqual({ kind: 'derived', path: join(repo, 'package.json'), scripts: ['typecheck', 'test'] })
  })

  it('fails loud on an explicit config path that does not exist', async () => {
    const repo = tempRepo()
    mkdirSync(join(repo, 'ops'), { recursive: true })
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    await expect(loadSignoffConfig({ repoRoot: repo, configPath: 'ops/nope.mjs' })).rejects.toThrow(/no config at/)
  })

  it('fails loud on a config module with no default export', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({}))
    writeFileSync(join(repo, 'signoff.config.mjs'), 'export const steps = []\n')
    await expect(loadSignoffConfig({ repoRoot: repo })).rejects.toThrow(/must have a default export/)
  })
})
