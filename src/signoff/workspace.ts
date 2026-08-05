import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SignoffRepoFacts, SignoffSource } from './types'

/**
 * Materialize the pristine checkout every step runs against.
 *
 * **The decision, and the measurement behind it: a `git worktree` of HEAD, not
 * a filtered copy.** Both were timed on two real repos on this host:
 *
 * | repo | `git worktree add --detach` | `rsync -a --exclude node_modules --exclude .git` |
 * |---|---|---|
 * | agent-app (931 tracked files) | **0.04 s / 11 MB** | 0.12 s / 25 MB |
 * | legal-agent (753 tracked files) | **0.06 s / 24 MB** | **3.97 s / 2.7 GB** |
 *
 * The 2.7 GB is the argument. The copy carried `build/`, `.react-router/` and
 * `.wrangler/` — generated output and framework caches — because an exclude
 * list is a hand-maintained enumeration of things to leave behind, and it is
 * never complete. A warm Vite cache is precisely what made the `node:sqlite`
 * bundling failure invisible locally while CI saw it, so a materializer that
 * can leak one has defeated its own purpose. `git` already knows what is source
 * and what is generated, and `.gitignore` is that list, maintained by the repo.
 *
 * The overlay on top is what keeps the gate usable before you commit:
 * `source: 'working-tree'` applies `git diff HEAD` (staged and unstaged) as a
 * patch and copies untracked, non-ignored files in. `source: 'head'` verifies
 * exactly the commit that would merge.
 */

export interface MaterializeOptions {
  readonly repoDir: string
  readonly dest: string
  readonly source: SignoffSource
  /** Gitignored files the run genuinely needs. Missing ones abort. */
  readonly carryFiles?: readonly string[]
}

export interface CleanTree extends SignoffRepoFacts {
  /** Absolute path of the materialized checkout. */
  readonly path: string
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new Error(`signoff: git ${args.join(' ')} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`signoff: git ${args.join(' ')} exited ${result.status}\n${result.stderr.trim()}`)
  }
  return result.stdout
}

/** Split a `-z` separated git list into entries. */
function zsplit(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0)
}

export function repoRootOf(dir: string): string {
  return git(['rev-parse', '--show-toplevel'], dir).trim()
}

export function materializeCleanTree(options: MaterializeOptions): CleanTree {
  const { repoDir, dest, source, carryFiles = [] } = options
  const root = repoRootOf(repoDir)
  const head = git(['rev-parse', 'HEAD'], root).trim()
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()

  // A crashed earlier run leaves a registered worktree whose directory is gone;
  // `add` then refuses on a name collision. Pruning first is what makes the gate
  // re-runnable after a kill.
  git(['worktree', 'prune'], root)
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  git(['worktree', 'add', '--detach', '--quiet', dest, head], root)

  let diffSha256: string | null = null
  let untrackedFiles: string[] = []

  if (source === 'working-tree') {
    // `git diff HEAD` covers staged and unstaged changes to tracked files in one
    // patch, including deletions and renames. `--binary` keeps a changed image
    // or lockfile-adjacent binary from silently dropping out of the patch.
    const patch = git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], root)
    if (patch.length > 0) {
      diffSha256 = createHash('sha256').update(patch).digest('hex')
      const patchFile = join(dirname(dest), `${dest.split('/').pop() ?? 'tree'}.patch`)
      writeFileSync(patchFile, patch)
      // Fail loud: a patch that does not apply means the tree we would verify is
      // not the tree the developer has, and verifying the wrong bytes is worse
      // than not verifying.
      git(['apply', '--binary', '--whitespace=nowarn', patchFile], dest)
      rmSync(patchFile, { force: true })
    }

    untrackedFiles = zsplit(git(['ls-files', '--others', '--exclude-standard', '-z'], root))
    for (const rel of untrackedFiles) {
      const target = join(dest, rel)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(root, rel), target)
    }
  }

  const carried: string[] = []
  for (const rel of carryFiles) {
    if (isAbsolute(rel)) throw new Error(`signoff: carryFiles must be repo-relative; got "${rel}"`)
    const from = resolve(root, rel)
    if (!existsSync(from)) {
      throw new Error(
        `signoff: carryFiles names "${rel}", which does not exist at ${from}. ` +
          'Remove it from the config or create the file — installing without it would resolve ' +
          'against a different registry than the one you think you are verifying.',
      )
    }
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(from, target)
    carried.push(rel)
  }

  return {
    path: dest,
    root,
    head,
    branch,
    source,
    dirty: diffSha256 !== null || untrackedFiles.length > 0,
    diffSha256,
    untrackedFiles,
    carriedFiles: carried,
  }
}

/** Unregister and delete a materialized tree. */
export function removeCleanTree(tree: CleanTree): void {
  git(['worktree', 'remove', '--force', tree.path], tree.root)
}
