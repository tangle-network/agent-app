import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openSignoffCacheSession, pruneSignoffCache } from './cache'

const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'signoff-cache-cap-'))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function store(cacheDir: string, key: string, bytes: number): string {
  const path = join(cacheDir, 'stores', key)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'blob'), Buffer.alloc(bytes, 7))
  return path
}

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

describe('signoff cache retention', () => {
  it('removes idle stores past the age limit and the oldest excess bytes', async () => {
    const cacheDir = root()
    const old = store(cacheDir, 'a'.repeat(64), 1024 * 1024)
    const recent = store(cacheDir, 'b'.repeat(64), 128 * 1024)
    const now = Date.now()
    utimesSync(old, new Date(now - 4 * 24 * 60 * 60 * 1000), new Date(now - 4 * 24 * 60 * 60 * 1000))

    const result = await pruneSignoffCache(cacheDir, { nowMs: now, maxBytes: 512 * 1024 })
    expect(result.removed).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(result.afterBytes).toBeLessThan(512 * 1024)
  })

  it('counts hardlinked bytes once, then deletes both owners to reclaim them', async () => {
    const cacheDir = root()
    const first = store(cacheDir, 'a'.repeat(64), 1024 * 1024)
    const second = join(cacheDir, 'stores', 'b'.repeat(64))
    mkdirSync(second)
    linkSync(join(first, 'blob'), join(second, 'blob'))

    const result = await pruneSignoffCache(cacheDir, { maxBytes: 0 })
    expect(result.beforeBytes).toBeLessThan(1.5 * 1024 * 1024)
    expect(result.afterBytes).toBe(0)
    expect(result.removed).toHaveLength(2)
  })

  it('preserves a store leased by another live run, then evicts it after release', async () => {
    const cacheDir = root()
    const key = 'c'.repeat(64)
    const path = store(cacheDir, key, 32 * 1024)
    const session = await openSignoffCacheSession(cacheDir, join(cacheDir, 'trees', 'new-tree'))
    await session.protectStore(key)
    const during = await pruneSignoffCache(cacheDir, { maxBytes: 0 })
    expect(during.removed).toEqual([])
    expect(during.overBudgetBytes).toBeGreaterThan(0)
    expect(existsSync(path)).toBe(true)
    await session.close()
    const after = await pruneSignoffCache(cacheDir, { maxBytes: 0 })
    expect(after.removed).toEqual([path])
    expect(existsSync(path)).toBe(false)
  })

  it('retires an idle cached Git worktree through Git but never follows a symlink', async () => {
    const cacheDir = root()
    const repo = root()
    git(['init', '--quiet', '--initial-branch=main'], repo)
    git(['config', 'core.hooksPath', '/dev/null'], repo)
    git(['config', 'user.email', 'signoff@example.invalid'], repo)
    git(['config', 'user.name', 'signoff test'], repo)
    writeFileSync(join(repo, 'README.md'), 'fixture\n')
    git(['add', '.'], repo)
    git(['commit', '--quiet', '-m', 'fixture'], repo)
    const tree = join(cacheDir, 'trees', 'cached-tree')
    mkdirSync(join(cacheDir, 'trees'))
    git(['worktree', 'add', '--detach', '--quiet', tree], repo)
    const outside = root()
    writeFileSync(join(outside, 'keep'), 'not cache data')
    symlinkSync(outside, join(cacheDir, 'trees', 'outside-link'))

    const session = await openSignoffCacheSession(cacheDir, tree)
    expect((await pruneSignoffCache(cacheDir, { maxBytes: 0 })).removed).toEqual([])
    await session.close()
    expect((await pruneSignoffCache(cacheDir, { maxBytes: 0 })).removed).toEqual([tree])
    expect(existsSync(tree)).toBe(false)
    expect(existsSync(join(outside, 'keep'))).toBe(true)
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(list.stdout).not.toContain(tree)
  })
})
