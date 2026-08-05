/**
 * Real git repositories for the proof tests.
 *
 * These are genuine `git init` trees, not a fake object database: every claim
 * the proof makes is a git claim, so a stub would test the stub. `core.hooksPath`
 * points at an empty directory so a developer's global commit hooks cannot
 * change what the fixture commits.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hashStepOutput, type SignoffProofStep } from './proof-record'

export interface TempRepo {
  readonly dir: string
  write(relativePath: string, contents: string): void
  commit(message: string): string
  git(args: readonly string[]): string
  cleanup(): void
}

export function createTempRepo(options: { readonly name?: string } = {}): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'agent-app-signoff-repo-'))
  const dir = join(root, options.name ?? 'repo')
  const hooks = join(root, 'no-hooks')
  mkdirSync(dir, { recursive: true })
  mkdirSync(hooks, { recursive: true })

  const git = (args: readonly string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).replace(/\n$/, '')

  git(['init', '-b', 'main'])
  // Identity and hook settings live in the repo's LOCAL config, not on this
  // helper's argv. The code under test spawns its own `git`, so a `-c` flag
  // here reaches the fixture's own commands and nothing else — `git notes add`
  // inside `attachSignoffProof` then runs with whatever identity the machine
  // happens to supply. A developer's global `~/.gitconfig` covers that gap and
  // a bare runner has none, which is precisely the machine-specific pass this
  // module exists to make impossible.
  git(['config', 'user.name', 'Signoff Fixture'])
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'core.hooksPath', hooks])
  const repo: TempRepo = {
    dir,
    git,
    write(relativePath, contents) {
      const full = join(dir, relativePath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents)
    },
    commit(message) {
      git(['add', '-A'])
      git(['commit', '-m', message])
      return git(['rev-parse', 'HEAD'])
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  repo.write('package.json', `${JSON.stringify({ name: 'fixture', version: '0.0.0', dependencies: { '@tangle-network/agent-app': '^0.45.0' } }, null, 2)}\n`)
  return repo
}

/** Steps that all succeeded, one per id, with plausible timings. */
export function passingSteps(ids: readonly string[]): SignoffProofStep[] {
  return ids.map((id, index) => ({
    id,
    command: `pnpm run ${id}`,
    cwd: '/repo',
    status: 'passed',
    exitCode: 0,
    durationMs: 1000 * (index + 1),
    startedAt: new Date(Date.UTC(2026, 7, 4, 1, index, 0)).toISOString(),
    outputSha256: hashStepOutput(`${id} output`),
  }))
}
