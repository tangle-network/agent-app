/**
 * `verify-proof` — the half a reader runs, on a machine that did not produce
 * the proof, to decide whether a commit was really signed off.
 *
 * The verifier never believes the document. Every claim it can re-derive, it
 * re-derives from git and compares; every claim it cannot re-derive is reported
 * as recorded, not as checked. The one field the proof is deliberately not
 * allowed to own is **which steps were required**: a run that declares its own
 * bar can declare an empty one, so the authoritative table lives here and a
 * proof declaring fewer requirements than its repo's table fails as
 * `lowered-bar`.
 */
import type { CommitFacts, IsAncestorFn } from './proof-git';
import { type SignoffProof } from './proof-record';
/**
 * The steps a repo's sign-off MUST cover, transcribed from each repo's CI job.
 * A runner is free to run more; it may never run fewer.
 *
 *   agent-app     .github/workflows/publish.yml (source checks)
 *   tax-agent     .github/workflows/deploy.yml (the `ci` job)
 *   legal-agent   .github/workflows/deploy.yml (the `ci` job)
 */
export declare const SIGNOFF_REQUIRED_STEPS: Readonly<Record<string, readonly string[]>>;
/** Throws for a repo with no table — an unrecognised repo has no bar, and no bar is not a pass. */
export declare function requiredStepsFor(repo: string): readonly string[];
export type SignoffFailureCode = 'unsupported-version' | 'body-tampered' | 'mac-missing' | 'mac-invalid' | 'unknown-repo' | 'repo-mismatch' | 'tree-mismatch' | 'dirty-worktree' | 'commit-unbound' | 'missing-required-step' | 'lowered-bar' | 'duplicate-step' | 'step-failed' | 'verdict-fail' | 'stale-proof';
export interface SignoffFailure {
    readonly code: SignoffFailureCode;
    readonly detail: string;
}
/** How the proof attaches to the commit that was asked about. */
export type SignoffCommitBinding = 
/** The proof names this exact commit. */
'exact'
/** A different commit id, but byte-identical content — a rebase or a squash of what was verified. */
 | 'tree-equivalent'
/** Neither. The proof does not describe this commit. */
 | 'none';
export interface SignoffVerification {
    readonly ok: boolean;
    readonly commitBinding: SignoffCommitBinding;
    /** True only when a key was supplied AND the mac over the canonical body matched. */
    readonly macChecked: boolean;
    readonly failures: readonly SignoffFailure[];
    readonly proof: SignoffProof;
    readonly target: CommitFacts;
    readonly requiredSteps: readonly string[];
}
export interface VerifySignoffProofOptions {
    /** The commit the reader is asking about, read from git — never from the proof. */
    readonly target: CommitFacts;
    /**
     * Reachability in the target's history. Required, because the clock cannot
     * answer staleness on its own: git records committer time to the SECOND, so a
     * proof and the commit it is being replayed onto routinely share a timestamp.
     * Ancestry is exact and clock-free.
     */
    readonly isAncestor: IsAncestorFn;
    /** Local HMAC key. Omitted, the mac is reported unchecked rather than assumed good. */
    readonly key?: Uint8Array;
    /** Overrides the built-in table. Supplying `[]` is a deliberate no-bar check, and says so. */
    readonly requiredSteps?: readonly string[];
    /** Repo identity the caller expects; a mismatch against the proof is a failure, not a rename. */
    readonly expectRepo?: string;
}
export declare function verifySignoffProof(proof: SignoffProof, options: VerifySignoffProofOptions): SignoffVerification;
export interface VerifySignoffAtRevInput {
    readonly repoDir: string;
    readonly rev: string;
    readonly key?: Uint8Array;
    readonly requiredSteps?: readonly string[];
    readonly expectRepo?: string;
}
type SignoffLookupFailure = {
    readonly found: false;
    readonly commit: string;
    readonly hint: readonly string[];
};
export type SignoffVerifyOutcome = ({
    readonly found: true;
} & SignoffVerification) | SignoffLookupFailure;
/** Verify by revision: find the proof attached to that SHA (or to its content), then check it. */
export declare function verifySignoffAtRev(input: VerifySignoffAtRevInput): SignoffVerifyOutcome;
export interface VerifySignoffFileInput {
    readonly repoDir: string;
    readonly file: string;
    /**
     * The commit to check the file against. REQUIRED, and deliberately not
     * defaulted to the commit the proof names: a proof checked against its own
     * subject can never fail the commit binding, which is a check that reads as
     * strong and cannot catch anything. The reader always states what they are
     * asking about.
     */
    readonly rev: string;
    readonly key?: Uint8Array;
    readonly requiredSteps?: readonly string[];
    readonly expectRepo?: string;
}
/** Verify a proof document on disk. The repo is still required — "matches the tree it claims" is not answerable without it. */
export declare function verifySignoffProofFile(input: VerifySignoffFileInput): SignoffVerification;
/** One line per failure, prefixed by its code, in the order the checks ran. */
export declare function formatSignoffVerification(result: SignoffVerification): string;
export {};
