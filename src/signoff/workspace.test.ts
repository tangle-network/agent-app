import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeCleanTree, removeCleanTree } from './workspace'

/**
 * Materialization runs against REAL git repositories, because the property
 * under test is "what git considers source", and a fake would encode this
 * module's belief about that rather than git's answer.
 *
 * The central assertion is the one the whole gate rests on: a gitignored build
 * artifact or framework cache present in the developer's checkout must NOT
 * exist in the tree the steps run in. That is the exact difference that let a
 * warm local run pass while CI failed.
 */

const created: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A repo with a tracked source file, a gitignored cache, and one commit. */
function fixtureRepo(): string {
  const repo = temp('signoff-repo-')
  git(['init', '--quiet', '--initial-branch=main'], repo)
  // A fixture repo must not inherit the developer's global hooks: this host has
  // a commit-identity hook that would refuse the fixture's test identity, and a
  // fixture whose behaviour depends on the machine is not a fixture.
  git(['config', 'core.hooksPath', '/dev/null'], repo)
  git(['config', 'user.email', 'signoff@example.invalid'], repo)
  git(['config', 'user.name', 'signoff test'], repo)
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.vite\ndist\n')
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}')
  writeFileSync(join(repo, 'source.txt'), 'committed\n')
  git(['add', '.'], repo)
  git(['commit', '--quiet', '-m', 'initial'], repo)

  // The state that masks a bug: a warm cache and a stale build output.
  mkdirSync(join(repo, '.vite'), { recursive: true })
  writeFileSync(join(repo, '.vite', 'deps.json'), '{"warm":true}')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'stale')
  mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
  return repo
}

describe('materializeCleanTree', () => {
  it('LEAVES the warm cache, stale build and node_modules behind — the property the gate rests on', () => {
    const repo = fixtureRepo()
    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'working-tree' })

    expect(existsSync(join(tree.path, 'source.txt'))).toBe(true)
    expect(existsSync(join(tree.path, '.vite'))).toBe(false)
    expect(existsSync(join(tree.path, 'dist'))).toBe(false)
    expect(existsSync(join(tree.path, 'node_modules'))).toBe(false)
    removeCleanTree(tree)
  })

  it('source: head verifies exactly the commit that would merge, ignoring uncommitted work', () => {
    const repo = fixtureRepo()
    writeFileSync(join(repo, 'source.txt'), 'uncommitted edit\n')
    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'head' })

    expect(readFileSync(join(tree.path, 'source.txt'), 'utf8')).toBe('committed\n')
    expect(tree.dirty).toBe(false)
    expect(tree.diffSha256).toBeNull()
    removeCleanTree(tree)
  })

  it('source: working-tree applies unstaged AND staged edits, and records the patch digest', () => {
    const repo = fixtureRepo()
    writeFileSync(join(repo, 'source.txt'), 'unstaged edit\n')
    writeFileSync(join(repo, 'staged.txt'), 'staged file\n')
    git(['add', 'staged.txt'], repo)

    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'working-tree' })
    expect(readFileSync(join(tree.path, 'source.txt'), 'utf8')).toBe('unstaged edit\n')
    expect(readFileSync(join(tree.path, 'staged.txt'), 'utf8')).toBe('staged file\n')
    expect(tree.dirty).toBe(true)
    expect(tree.diffSha256).toMatch(/^[0-9a-f]{64}$/)
    removeCleanTree(tree)
  })

  it('carries untracked, non-ignored files — the new module you have not committed yet', () => {
    const repo = fixtureRepo()
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'brand-new.ts'), 'export const x = 1\n')

    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'working-tree' })
    expect(readFileSync(join(tree.path, 'src', 'brand-new.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(tree.untrackedFiles).toContain('src/brand-new.ts')
    removeCleanTree(tree)
  })

  it('applies a deletion, so removing a file is verified as a removal', () => {
    const repo = fixtureRepo()
    rmSync(join(repo, 'source.txt'))
    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'working-tree' })
    expect(existsSync(join(tree.path, 'source.txt'))).toBe(false)
    removeCleanTree(tree)
  })

  it('carries a named gitignored file when the repo asks for it', () => {
    const repo = fixtureRepo()
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.vite\ndist\n.npmrc\n')
    writeFileSync(join(repo, '.npmrc'), 'registry=https://example.invalid\n')

    const tree = materializeCleanTree({
      repoDir: repo,
      dest: join(temp('signoff-dest-'), 'tree'),
      source: 'working-tree',
      carryFiles: ['.npmrc'],
    })
    expect(readFileSync(join(tree.path, '.npmrc'), 'utf8')).toContain('example.invalid')
    expect(tree.carriedFiles).toEqual(['.npmrc'])
    removeCleanTree(tree)
  })

  it('fails loud on a carryFiles entry that does not exist, rather than installing from elsewhere', () => {
    const repo = fixtureRepo()
    expect(() =>
      materializeCleanTree({
        repoDir: repo,
        dest: join(temp('signoff-dest-'), 'tree'),
        source: 'working-tree',
        carryFiles: ['.npmrc'],
      }),
    ).toThrow(/does not exist/)
  })

  it('is re-runnable after a killed run left a registered worktree behind', () => {
    const repo = fixtureRepo()
    const dest = join(temp('signoff-dest-'), 'tree')
    const first = materializeCleanTree({ repoDir: repo, dest, source: 'head' })
    // Simulate a crash: the directory is gone, git's registration is not.
    rmSync(first.path, { recursive: true, force: true })
    const second = materializeCleanTree({ repoDir: repo, dest, source: 'head' })
    expect(existsSync(join(second.path, 'source.txt'))).toBe(true)
    removeCleanTree(second)
  })

  it('records the commit and branch the proof will name', () => {
    const repo = fixtureRepo()
    const tree = materializeCleanTree({ repoDir: repo, dest: join(temp('signoff-dest-'), 'tree'), source: 'head' })
    expect(tree.head).toBe(git(['rev-parse', 'HEAD'], repo).trim())
    expect(tree.branch).toBe('main')
    removeCleanTree(tree)
  })
})
