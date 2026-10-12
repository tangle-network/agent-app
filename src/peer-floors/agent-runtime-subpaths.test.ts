import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { satisfiesRange } from './check'

/**
 * The first agent-runtime release that exports each subpath this package imports at runtime. A peer range
 * that admits an older release lets a consumer install cleanly and then fail at module load with
 * `"./placement" is not exported` (creative-agent SSR build, 2026-10-12, on a range that still admitted
 * 0.313.1). Read from the agent-runtime release tags; add a row when src imports a new subpath.
 */
const FIRST_RELEASE: Record<string, string> = {
  '.': '0.0.0',
  './candidate-execution': '0.93.0',
  './durable': '0.108.0',
  './intelligence': '0.51.0',
  './placement': '0.315.0',
  './tool-loop': '0.109.1',
  './workspace-store': '0.316.0',
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'fixtures' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!
  return false
}

describe('agent-runtime peer range', () => {
  it('admits no release that lacks a subpath src imports', () => {
    const imported = new Set<string>()
    for (const file of sources(join(root, 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '@tangle-network\/agent-runtime(\/[a-z-]+)?'/g)) {
        imported.add(match[1] ? `.${match[1]}` : '.')
      }
    }
    const unknown = [...imported].filter(subpath => !(subpath in FIRST_RELEASE))
    expect(unknown, 'record the first agent-runtime release that exports each new subpath').toEqual([])
    const floor = [...imported].map(subpath => FIRST_RELEASE[subpath]!).reduce((a, b) => (newer(b, a) ? b : a))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const range = manifest.peerDependencies['@tangle-network/agent-runtime'] as string
    const lowest = [...range.matchAll(/>=\s*(\d+\.\d+\.\d+)/g)].map(m => m[1]!)
    expect(lowest.filter(version => newer(floor, version)), `every band starts at or above ${floor}`).toEqual([])
    // Behavioral contracts may require a newer floor than the first available export.
    // The version actually used to verify this package must still be admitted.
    expect(satisfiesRange(manifest.devDependencies['@tangle-network/agent-runtime'], range)).toBe(true)
  })
})
