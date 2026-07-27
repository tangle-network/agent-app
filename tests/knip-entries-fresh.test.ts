/**
 * `knip.json`'s entry list must name every `tsup.config.ts` entry.
 *
 * Why this test exists: knip treats an entry's exports as public API and only
 * reports dead code BELOW an entry. A subpath that is built and published but
 * missing from `knip.json` is therefore invisible to the dead-surface gate —
 * every module it reaches gets scanned as unreachable-or-not by accident rather
 * than by contract. That drift is what let the config sit at 41 entries against
 * 74 built ones while the gate was not in CI at all.
 *
 * `pnpm knip` is the gate; this test is the gate's own guard rail.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every source path on the right-hand side of `tsup.config.ts`'s `entry` map. */
function tsupEntries(): string[] {
  const source = readFileSync(join(repoRoot, 'tsup.config.ts'), 'utf8')
  const block = /entry:\s*\{([\s\S]*?)\n {2}\}/.exec(source)
  if (!block?.[1]) throw new Error('tsup.config.ts: could not locate the `entry` map')
  return [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1] as string)
}

function knipEntries(): string[] {
  return JSON.parse(readFileSync(join(repoRoot, 'knip.json'), 'utf8')).entry as string[]
}

describe('knip entry coverage', () => {
  it('names every built entry, so no published subpath escapes the dead-surface gate', () => {
    const built = tsupEntries()
    const declared = new Set(knipEntries())
    expect(built.length).toBeGreaterThan(50)
    expect(built.filter((entry) => !declared.has(entry))).toEqual([])
  })

  it('does not name an entry tsup no longer builds', () => {
    const built = new Set(tsupEntries())
    const stale = knipEntries().filter((entry) => !entry.includes('*') && !built.has(entry))
    expect(stale).toEqual([])
  })
})
