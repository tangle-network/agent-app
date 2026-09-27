/** A git invocation that exited non-zero, carrying stderr so the caller can act. */
export declare class SignoffGitError extends Error {
    readonly args: readonly string[];
    readonly status: number | null;
    readonly stderr: string;
    constructor(args: readonly string[], status: number | null, stderr: string);
}
export interface GitResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
/**
 * Run git and hand back the raw result. `GIT_OPTIONAL_LOCKS=0` keeps a read
 * from touching the index while another agent works the same worktree — this
 * repo is shared by concurrent sessions.
 */
export declare function runGit(repoDir: string, args: readonly string[], options?: {
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
}): GitResult;
/** Run git, or throw. Trailing newline is stripped — every caller wants the value, not the line. */
export declare function gitText(repoDir: string, args: readonly string[], options?: {
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
}): string;
/**
 * Is `ancestor` reachable from `descendant`? A port rather than a direct call so
 * the verifier stays a pure function over facts a caller supplies.
 */
export type IsAncestorFn = (ancestor: string, descendant: string) => boolean;
export declare function gitIsAncestor(repoDir: string): IsAncestorFn;
export interface CommitFacts {
    /** 40-hex commit id. */
    readonly commit: string;
    /** 40-hex id of the tree the COMMIT points at. */
    readonly commitTree: string;
    readonly parents: readonly string[];
    /** Committer date, UTC ISO-8601 with a `Z` suffix. */
    readonly committedAt: string;
}
/** Resolve a revision to the commit it names, failing loud on an unknown rev. */
export declare function resolveCommit(repoDir: string, rev: string): string;
export declare function readCommitFacts(repoDir: string, rev: string): CommitFacts;
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
export declare function computeWorktreeTree(repoDir: string): string;
