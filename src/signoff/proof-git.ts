/**
 * The git facts a sign-off proof is bound to, read straight from the object
 * database rather than reported by the process that ran the checks.
 *
 * Everything here is re-derivable by anyone holding the repository, which is
 * what makes the proof checkable: a verifier never trusts a field in the JSON,
 * it recomputes the same value with the same commands and compares.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A git invocation that exited non-zero, carrying stderr so the caller can act. */
export class SignoffGitError extends Error {
  readonly args: readonly string[]
  readonly status: number | null
  readonly stderr: string

  constructor(args: readonly string[], status: number | null, stderr: string) {
    super(`git ${args.join(' ')} exited ${status ?? 'null'}: ${stderr.trim()}`)
    this.name = 'SignoffGitError'
    this.args = args
    this.status = status
    this.stderr = stderr
  }
}

export interface GitResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run git and hand back the raw result. `GIT_OPTIONAL_LOCKS=0` keeps a read
 * from touching the index while another agent works the same worktree — this
 * repo is shared by concurrent sessions.
 */
export function runGit(repoDir: string, args: readonly string[], options: { readonly input?: string; readonly env?: Readonly<Record<string, string>> } = {}): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: repoDir,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env },
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error) throw new Error(`git ${args.join(' ')} could not run: ${result.error.message}`)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Run git, or throw. Trailing newline is stripped — every caller wants the value, not the line. */
export function gitText(repoDir: string, args: readonly string[], options: { readonly input?: string; readonly env?: Readonly<Record<string, string>> } = {}): string {
  const result = runGit(repoDir, args, options)
  if (result.status !== 0) throw new SignoffGitError(args, result.status, result.stderr)
  return result.stdout.replace(/\n$/, '')
}

/**
 * Is `ancestor` reachable from `descendant`? A port rather than a direct call so
 * the verifier stays a pure function over facts a caller supplies.
 */
export type IsAncestorFn = (ancestor: string, descendant: string) => boolean

export function gitIsAncestor(repoDir: string): IsAncestorFn {
  return (ancestor, descendant) => {
    const result = runGit(repoDir, ['merge-base', '--is-ancestor', ancestor, descendant])
    if (result.status === 0) return true
    if (result.status === 1) return false
    throw new SignoffGitError(['merge-base', '--is-ancestor', ancestor, descendant], result.status, result.stderr)
  }
}

export interface CommitFacts {
  /** 40-hex commit id. */
  readonly commit: string
  /** 40-hex id of the tree the COMMIT points at. */
  readonly commitTree: string
  readonly parents: readonly string[]
  /** Committer date, UTC ISO-8601 with a `Z` suffix. */
  readonly committedAt: string
}

/** Resolve a revision to the commit it names, failing loud on an unknown rev. */
export function resolveCommit(repoDir: string, rev: string): string {
  return gitText(repoDir, ['rev-parse', '--verify', `${rev}^{commit}`])
}

export function readCommitFacts(repoDir: string, rev: string): CommitFacts {
  const commit = resolveCommit(repoDir, rev)
  const record = gitText(repoDir, ['show', '--no-patch', '--format=%T%n%P%n%cI', commit])
  const [tree, parents, committedAt] = record.split('\n')
  if (tree === undefined || parents === undefined || committedAt === undefined) {
    throw new Error(`git show returned an unreadable record for ${commit}: ${JSON.stringify(record)}`)
  }
  return {
    commit,
    commitTree: tree,
    parents: parents.length === 0 ? [] : parents.split(' '),
    committedAt: new Date(committedAt).toISOString(),
  }
}

/**
 * Hash the tree the checks actually ran against, including uncommitted and
 * untracked (non-ignored) files.
 *
 * This is the field that makes drift detectable. A sign-off that ran over an
 * edited worktree produces a tree id no commit carries, so it cannot verify
 * against the commit it claims — which is the intended outcome, not a bug.
 *
 * Written through a throwaway index (`GIT_INDEX_FILE`) so a concurrent agent's
 * staged work in the real index is neither read nor disturbed. `git add -A`
 * honours `.gitignore`, so `node_modules` / `dist` stay out.
 */
export function computeWorktreeTree(repoDir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-app-signoff-index-'))
  const indexFile = join(scratch, 'index')
  try {
    const env = { GIT_INDEX_FILE: indexFile }
    gitText(repoDir, ['add', '-A', '--'], { env })
    return gitText(repoDir, ['write-tree'], { env })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
