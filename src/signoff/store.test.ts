import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { manifestCacheKey, manifestFiles, resolveStore } from './store'

/**
 * The cache is the only place where "make it fast" is allowed to touch "make it
 * clean", so its invalidation is the load-bearing property: any manifest byte
 * that could change what gets installed must change the key.
 */

const created: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const tree = tempDir('signoff-tree-')
  writeFileSync(join(tree, 'package.json'), '{"name":"root"}')
  writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(tree, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  mkdirSync(join(tree, 'apps', 'web'), { recursive: true })
  writeFileSync(join(tree, 'apps', 'web', 'package.json'), '{"name":"web"}')
  return tree
}

describe('manifestFiles', () => {
  it('finds every manifest in the workspace, sorted', () => {
    expect(manifestFiles(workspace())).toEqual([
      'apps/web/package.json',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ])
  })

  it('never descends into node_modules or generated output — a dependency\'s manifest is not an input', () => {
    const tree = workspace()
    for (const dir of ['node_modules/left-pad', 'dist', 'build', '.wrangler', '.react-router']) {
      mkdirSync(join(tree, dir), { recursive: true })
      writeFileSync(join(tree, dir, 'package.json'), '{"name":"noise"}')
    }
    expect(manifestFiles(tree)).not.toContain('node_modules/left-pad/package.json')
    expect(manifestFiles(tree).filter((file) => file.startsWith('dist') || file.startsWith('build'))).toEqual([])
  })
})

describe('manifestCacheKey', () => {
  it('is stable across reads of unchanged bytes', () => {
    const tree = workspace()
    const files = manifestFiles(tree)
    expect(manifestCacheKey(tree, files)).toBe(manifestCacheKey(tree, files))
  })

  it('CHANGES when the lockfile changes — the whole point of the key', () => {
    const tree = workspace()
    const before = manifestCacheKey(tree, manifestFiles(tree))
    writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# a resolution moved\n')
    expect(manifestCacheKey(tree, manifestFiles(tree))).not.toBe(before)
  })

  it('changes when a nested workspace package.json changes', () => {
    const tree = workspace()
    const before = manifestCacheKey(tree, manifestFiles(tree))
    writeFileSync(join(tree, 'apps', 'web', 'package.json'), '{"name":"web","dependencies":{"zod":"^4"}}')
    expect(manifestCacheKey(tree, manifestFiles(tree))).not.toBe(before)
  })

  it('changes when an .npmrc appears — a different registry is a different install', () => {
    const tree = workspace()
    const before = manifestCacheKey(tree, manifestFiles(tree))
    writeFileSync(join(tree, '.npmrc'), 'registry=https://example.invalid\n')
    expect(manifestCacheKey(tree, manifestFiles(tree))).not.toBe(before)
  })

  it('does NOT change when source changes — source is not an install input', () => {
    const tree = workspace()
    const before = manifestCacheKey(tree, manifestFiles(tree))
    mkdirSync(join(tree, 'src'), { recursive: true })
    writeFileSync(join(tree, 'src', 'index.ts'), 'export const x = 1\n')
    expect(manifestCacheKey(tree, manifestFiles(tree))).toBe(before)
  })
})

describe('resolveStore', () => {
  it('reports a miss first, then a hit once the store has content', () => {
    const tree = workspace()
    const cacheDir = tempDir('signoff-cache-')
    const first = resolveStore({ treePath: tree, cacheDir })
    expect(first.hit).toBe(false)

    // What a real install leaves behind.
    writeFileSync(join(first.storeDir, 'files'), 'content-addressed blob')
    expect(resolveStore({ treePath: tree, cacheDir }).hit).toBe(true)
  })

  it('a changed lockfile lands on a different store, so nothing stale can be reused', () => {
    const tree = workspace()
    const cacheDir = tempDir('signoff-cache-')
    const before = resolveStore({ treePath: tree, cacheDir })
    writeFileSync(join(before.storeDir, 'files'), 'blob')

    writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# bumped\n')
    const after = resolveStore({ treePath: tree, cacheDir })
    expect(after.storeDir).not.toBe(before.storeDir)
    expect(after.hit).toBe(false)
  })

  it('names the files the key was computed from, so a cold install is explainable', () => {
    const cacheDir = tempDir('signoff-cache-')
    expect(resolveStore({ treePath: workspace(), cacheDir }).keyedOn).toContain('pnpm-lock.yaml')
  })

  it('keeps N generations and evicts the least recently used, so branch hopping stays warm', () => {
    const cacheDir = tempDir('signoff-cache-')
    const trees = [workspace(), workspace(), workspace()]
    trees.forEach((tree, index) => writeFileSync(join(tree, 'pnpm-lock.yaml'), `lockfileVersion: 9.0\n# ${index}\n`))

    const dirs = trees.map((tree, index) => {
      const resolved = resolveStore({ treePath: tree, cacheDir, generations: 3 })
      writeFileSync(join(resolved.storeDir, 'files'), 'blob')
      // Age each one distinctly; recency is what decides eviction.
      const used = new Date(Date.now() - (trees.length - index) * 60_000)
      utimesSync(resolved.storeDir, used, used)
      return resolved.storeDir
    })

    // Using the newest again keeps it and its neighbour; the oldest is evicted.
    const final = resolveStore({ treePath: trees[2] as string, cacheDir, generations: 2 })
    expect(final.pruned).toEqual([dirs[0]])
    expect(() => statSync(dirs[2] as string)).not.toThrow()
    expect(() => statSync(dirs[0] as string)).toThrow()
  })

  it('refuses a tree with no manifest instead of installing nothing and reporting success', () => {
    expect(() => resolveStore({ treePath: tempDir('signoff-empty-'), cacheDir: tempDir('signoff-cache-') })).toThrow(
      /no package manifest/,
    )
  })
})
