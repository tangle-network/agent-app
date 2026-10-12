import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compare, minVersion } from 'semver'
import { describe, expect, it } from 'vitest'

/**
 * The agent-runtime peer range must not admit a version that lacks a subpath
 * this package imports. 0.60.120 admitted 0.313.x while `./runtime/router-turn`
 * imported `@tangle-network/agent-runtime/placement` (first exported in 0.315.0),
 * so an app on 0.313 installed cleanly and then failed at import with
 * ERR_PACKAGE_PATH_NOT_EXPORTED (hardware-agent, 2026-10-11).
 *
 * Importing a new subpath means adding the first agent-runtime version that
 * exports it here (`git -C agent-runtime show v<x>:package.json`), which in turn
 * may raise the floor below.
 */
const FIRST_EXPORTED: Record<string, string> = {
  'candidate-execution': '0.280.0',
  durable: '0.280.0',
  intelligence: '0.280.0',
  placement: '0.315.0',
  'tool-loop': '0.280.0',
  'workspace-store': '0.316.0',
}

const ROOT = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('agent-runtime peer floor', () => {
  const imported = new Set<string>()
  for (const file of sources(join(ROOT, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"]@tangle-network\/agent-runtime\/([a-z0-9-]+)['"]/g)) {
      imported.add(match[1]!)
    }
  }

  it('names the first exporting version of every imported subpath', () => {
    expect([...imported].filter((subpath) => !FIRST_EXPORTED[subpath]).sort()).toEqual([])
  })

  it('admits no agent-runtime version older than the newest subpath it imports', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
    const floor = minVersion(pkg.peerDependencies['@tangle-network/agent-runtime']!)!.version
    const needed = [...imported].map((subpath) => FIRST_EXPORTED[subpath]!).sort(compare).at(-1)!
    expect(compare(floor, needed), `peer floor ${floor} admits versions before ${needed}`).toBeGreaterThanOrEqual(0)
  })
})
