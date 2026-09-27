import type { SignoffRepoFacts, SignoffSource } from './types';
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
    readonly repoDir: string;
    readonly dest: string;
    readonly source: SignoffSource;
    /** Gitignored files the run genuinely needs. Missing ones abort. */
    readonly carryFiles?: readonly string[];
}
export interface CleanTree extends SignoffRepoFacts {
    /** Absolute path of the materialized checkout. */
    readonly path: string;
}
export declare function repoRootOf(dir: string): string;
export declare function materializeCleanTree(options: MaterializeOptions): CleanTree;
/** Unregister and delete a materialized tree. */
export declare function removeCleanTree(tree: CleanTree): void;
