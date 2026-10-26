import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_ALLOW_TEST_IDENTITY: '1',
      GIT_AUTHOR_NAME: 'Signoff fixture',
      GIT_AUTHOR_EMAIL: 'signoff-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Signoff fixture',
      GIT_COMMITTER_EMAIL: 'signoff-fixture@example.invalid',
    },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

function worktree(cacheDir: string, name: string): { repo: string; tree: string } {
  const repo = root()
  git(['init', '--quiet', '--initial-branch=main'], repo)
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git(['add', '.'], repo)
  git(['commit', '--quiet', '-m', 'fixture'], repo)
  const tree = join(cacheDir, 'trees', name)
  mkdirSync(join(cacheDir, 'trees'))
  git(['worktree', 'add', '--detach', '--quiet', tree], repo)
  return { repo, tree }
}

describe('signoff cache retention', () => {
  it('removes idle stores past the age limit and the oldest excess bytes', async () => {
    const cacheDir = root()
    const old = store(cacheDir, 'a'.repeat(64), 1024 * 1024)
    const recent = store(cacheDir, 'b'.repeat(64), 128 * 1024)
    const now = Date.now()
    utimesSync(old, new Date(now - 4 * 24 * 60 * 60 * 1000), new Date(now - 4 * 24 * 60 * 60 * 1000))

    const result = await pruneSignoffCache(cacheDir, { nowMs: now, maxBytes: 512 * 1024 })
    expect(result.removed).toEqual([join(realpathSync(cacheDir), 'stores', 'a'.repeat(64))])
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
    expect(after.removed).toEqual([join(realpathSync(cacheDir), 'stores', key)])
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a detached check and its store after the coordinator exits', async () => {
    const cacheDir = root()
    const { tree } = worktree(cacheDir, 'detached-check')
    const key = 'd'.repeat(64)
    const path = store(cacheDir, key, 32 * 1024)
    const coordinator = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process'
      import { openSignoffCacheSession } from ${JSON.stringify(new URL('./cache.ts', import.meta.url).href)}
      const session = await openSignoffCacheSession(${JSON.stringify(cacheDir)}, ${JSON.stringify(tree)})
      await session.protectStore(${JSON.stringify(key)})
      const check = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: ${JSON.stringify(tree)}, env: { ...process.env, SIGNOFF_TREE: ${JSON.stringify(tree)} },
        detached: true, stdio: 'ignore',
      })
      // A numeric console.log is ANSI-colored under FORCE_COLOR, corrupting the
      // machine-readable PID and skipping the detached child's cleanup.
      process.stdout.write(String(check.pid))
      check.unref()
    `], { encoding: 'utf8' })
    expect(coordinator.status, coordinator.stderr).toBe(0)
    const pid = Number(coordinator.stdout.trim())
    expect(pid).toBeGreaterThan(0)
    try {
      expect((await pruneSignoffCache(cacheDir, { maxBytes: 0 })).removed).toEqual([])
      expect(existsSync(tree)).toBe(true)
      expect(existsSync(path)).toBe(true)
    } finally {
      process.kill(pid, 'SIGTERM')
    }
  })

  it('retires an idle cached Git worktree through Git but never follows a symlink', async () => {
    const cacheDir = root()
    const { repo, tree } = worktree(cacheDir, 'cached-tree')
    const outside = root()
    writeFileSync(join(outside, 'keep'), 'not cache data')
    symlinkSync(outside, join(cacheDir, 'trees', 'outside-link'))

    const alias = join(root(), 'cache-link')
    symlinkSync(cacheDir, alias)
    const session = await openSignoffCacheSession(alias, join(alias, 'trees', 'cached-tree'))
    expect((await pruneSignoffCache(cacheDir, { maxBytes: 0 })).removed).toEqual([])
    await session.close()
    expect((await pruneSignoffCache(cacheDir, { maxBytes: 0 })).removed).toEqual([join(realpathSync(cacheDir), 'trees', 'cached-tree')])
    expect(existsSync(tree)).toBe(false)
    expect(existsSync(join(outside, 'keep'))).toBe(true)
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(list.stdout).not.toContain(tree)
    const otherCache = root()
    const outsideStore = store(otherCache, 'a'.repeat(64), 1024)
    const linkedCache = root()
    symlinkSync(join(otherCache, 'stores'), join(linkedCache, 'stores'))
    expect((await pruneSignoffCache(linkedCache, { maxBytes: 0 })).removed).toEqual([])
    expect(existsSync(outsideStore)).toBe(true)
  })

  it.each(['000000000001', '999999999999'])('retires a completed modern worktree with numeric UUID tail %s', async tail => {
    const cacheDir = root()
    const { repo, tree } = worktree(cacheDir, `fixture-${process.pid}-00000000-0000-4000-8000-${tail}`)
    const key = 'c'.repeat(64)
    const path = store(cacheDir, key, 32 * 1024)
    const session = await openSignoffCacheSession(cacheDir, tree)
    await session.protectStore(key)
    await session.close()

    const result = await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })
    expect(result.removed).toEqual(expect.arrayContaining([tree, path]))
    expect(result.afterBytes).toBe(0)
    expect(result.overBudgetBytes).toBe(0)
    expect(existsSync(tree)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(cacheDir, 'active'))).toEqual([])
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout).not.toContain(tree)
  })

  it('protects a live legacy PID worktree and its unrecorded store without a lease', async () => {
    const cacheDir = root()
    const { tree } = worktree(cacheDir, `fixture-${process.pid}`)
    const path = store(cacheDir, 'd'.repeat(64), 32 * 1024)

    const result = await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })
    expect(result.removed).toEqual([])
    expect(existsSync(tree)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(cacheDir, 'active'))).toBe(false)
    expect(result.overBudgetBytes).toBeGreaterThan(0)
  })

  it.each(['private', 'common'])('preserves content and allocated bytes when linked %s Git metadata disappears', async missing => {
    const cacheDir = root()
    const { repo, tree } = worktree(cacheDir, 'orphaned-tree')
    const content = Buffer.alloc(32 * 1024, 19)
    writeFileSync(join(tree, 'only-copy'), content)
    const privateGit = readFileSync(join(tree, '.git'), 'utf8').trim().slice('gitdir: '.length)
    if (missing === 'private') {
      renameSync(privateGit, join(root(), 'retained-metadata'))
    } else {
      // Keep the real private Git directory intact while its explicit common target vanishes.
      const retained = join(root(), 'private-metadata')
      renameSync(privateGit, retained)
      writeFileSync(join(tree, '.git'), `gitdir: ${retained}\n`)
      writeFileSync(join(retained, 'commondir'), `${join(repo, '.git')}\n`)
      git(['rev-parse', '--is-inside-work-tree'], tree)
      renameSync(join(repo, '.git'), join(root(), 'retained-common-metadata'))
    }
    const idleStore = store(cacheDir, 'e'.repeat(64), 32 * 1024)

    const result = await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })
    expect(readFileSync(join(tree, 'only-copy'))).toEqual(content)
    expect(result.removed).toEqual([idleStore])
    expect(result.orphaned).toEqual([tree])
    expect(result.orphanedBytes).toBeGreaterThanOrEqual(content.length)
    expect(result.afterBytes).toBe(result.orphanedBytes)
    expect(result.overBudgetBytes).toBe(result.afterBytes)
    // A later startup still preserves it rather than silently treating it as retired.
    const again = await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })
    expect(again.removed).toEqual([])
    expect(again.afterBytes).toBe(result.afterBytes)
  })

  it('keeps unknown leases and their actual stores even beside an orphaned tree', async () => {
    const cacheDir = root()
    const tree = join(cacheDir, 'trees', 'orphaned-tree')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, '.git'), `gitdir: ${join(root(), 'worktrees', 'orphaned-tree')}\n`)
    writeFileSync(join(tree, 'only-copy'), 'retained orphan content\n')
    const idleStore = store(cacheDir, 'f'.repeat(64), 32 * 1024)
    mkdirSync(join(cacheDir, 'active'))
    writeFileSync(join(cacheDir, 'active', 'unknown.json'), 'not a valid lease')
    const result = await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })
    expect(result.removed).toEqual([])
    expect(existsSync(idleStore)).toBe(true)
    expect(readFileSync(join(tree, 'only-copy'), 'utf8')).toBe('retained orphan content\n')
    expect(result.afterBytes).toBe(result.beforeBytes)
    expect(result.orphaned).toEqual([tree])
  })

  it('refuses a real Git retirement failure while its metadata remains intact', async () => {
    const cacheDir = root()
    const { repo, tree } = worktree(cacheDir, 'locked-tree')
    git(['worktree', 'lock', tree], repo)
    await expect(pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })).rejects.toThrow('cannot retire cached worktree')
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('fixture\n')
    git(['worktree', 'unlock', tree], repo)
    expect((await pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })).removed).toEqual([tree])
  })

  it('keeps a valid separate Git directory failure distinct from an orphaned linked tree', async () => {
    const cacheDir = root()
    const tree = join(cacheDir, 'trees', 'separate-main')
    mkdirSync(join(cacheDir, 'trees'))
    git(['init', '--quiet', '--initial-branch=main', '--separate-git-dir', join(root(), 'git-dir'), tree], cacheDir)
    writeFileSync(join(tree, 'README.md'), 'separate Git repository\n')
    git(['add', '.'], tree)
    git(['commit', '--quiet', '-m', 'fixture'], tree)
    git(['rev-parse', '--is-inside-work-tree'], tree)
    await expect(pruneSignoffCache(cacheDir, { maxAgeMs: 0, maxBytes: 0 })).rejects.toThrow('cannot retire cached worktree')
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('separate Git repository\n')
  })
})
