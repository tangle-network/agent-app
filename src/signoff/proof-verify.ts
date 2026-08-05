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
import type { CommitFacts, IsAncestorFn } from './proof-git'
import { gitIsAncestor, readCommitFacts } from './proof-git'
import { readFileSync } from 'node:fs'
import { resolveSignoffProof, SIGNOFF_NOTES_GIT_CONFIG } from './proof-attach'
import { canonicalizeProofBody, hashProofBody, macMatches, parseSignoffProof, SIGNOFF_PROOF_VERSION, type SignoffProof } from './proof-record'
import { createHmac } from 'node:crypto'

/**
 * The steps a repo's sign-off MUST cover, transcribed from each repo's CI job.
 * A runner is free to run more; it may never run fewer.
 *
 *   agent-app     .github/workflows/ci.yml
 *   tax-agent     .github/workflows/deploy.yml (the `ci` job)
 *   legal-agent   .github/workflows/deploy.yml (the `ci` job)
 */
export const SIGNOFF_REQUIRED_STEPS: Readonly<Record<string, readonly string[]>> = {
  'agent-app': ['install', 'typecheck', 'test:gates', 'test', 'build', 'test:generated', 'knip'],
  'tax-agent': ['install', 'peer-check', 'typecheck', 'test', 'toolkit-deps', 'toolkit-test', 'build', 'worker-startup'],
  'legal-agent': ['install', 'peer-check', 'typegen', 'typecheck', 'test', 'build:check'],
}

/** Throws for a repo with no table — an unrecognised repo has no bar, and no bar is not a pass. */
export function requiredStepsFor(repo: string): readonly string[] {
  const steps = SIGNOFF_REQUIRED_STEPS[repo]
  if (steps === undefined) {
    throw new Error(`no required-step table for repo ${JSON.stringify(repo)}; known: ${Object.keys(SIGNOFF_REQUIRED_STEPS).sort().join(', ')}`)
  }
  return steps
}

export type SignoffFailureCode =
  | 'unsupported-version'
  | 'body-tampered'
  | 'mac-missing'
  | 'mac-invalid'
  | 'unknown-repo'
  | 'repo-mismatch'
  | 'tree-mismatch'
  | 'dirty-worktree'
  | 'commit-unbound'
  | 'missing-required-step'
  | 'lowered-bar'
  | 'duplicate-step'
  | 'step-failed'
  | 'verdict-fail'
  | 'stale-proof'

export interface SignoffFailure {
  readonly code: SignoffFailureCode
  readonly detail: string
}

/** How the proof attaches to the commit that was asked about. */
export type SignoffCommitBinding =
  /** The proof names this exact commit. */
  | 'exact'
  /** A different commit id, but byte-identical content — a rebase or a squash of what was verified. */
  | 'tree-equivalent'
  /** Neither. The proof does not describe this commit. */
  | 'none'

export interface SignoffVerification {
  readonly ok: boolean
  readonly commitBinding: SignoffCommitBinding
  /** True only when a key was supplied AND the mac over the canonical body matched. */
  readonly macChecked: boolean
  readonly failures: readonly SignoffFailure[]
  readonly proof: SignoffProof
  readonly target: CommitFacts
  readonly requiredSteps: readonly string[]
}

export interface VerifySignoffProofOptions {
  /** The commit the reader is asking about, read from git — never from the proof. */
  readonly target: CommitFacts
  /**
   * Reachability in the target's history. Required, because the clock cannot
   * answer staleness on its own: git records committer time to the SECOND, so a
   * proof and the commit it is being replayed onto routinely share a timestamp.
   * Ancestry is exact and clock-free.
   */
  readonly isAncestor: IsAncestorFn
  /** Local HMAC key. Omitted, the mac is reported unchecked rather than assumed good. */
  readonly key?: Uint8Array
  /** Overrides the built-in table. Supplying `[]` is a deliberate no-bar check, and says so. */
  readonly requiredSteps?: readonly string[]
  /** Repo identity the caller expects; a mismatch against the proof is a failure, not a rename. */
  readonly expectRepo?: string
}

export function verifySignoffProof(proof: SignoffProof, options: VerifySignoffProofOptions): SignoffVerification {
  const failures: SignoffFailure[] = []
  const { body, seal } = proof
  const target = options.target

  if (body.proofVersion !== SIGNOFF_PROOF_VERSION) {
    failures.push({ code: 'unsupported-version', detail: `proof declares version ${body.proofVersion}; this verifier reads ${SIGNOFF_PROOF_VERSION}` })
  }

  const recomputed = hashProofBody(body)
  if (recomputed !== seal.bodySha256) {
    failures.push({ code: 'body-tampered', detail: `seal claims body sha256 ${seal.bodySha256}; the body hashes to ${recomputed}` })
  }

  let macChecked = false
  if (options.key !== undefined) {
    if (seal.mac === null) {
      failures.push({ code: 'mac-missing', detail: 'a key was supplied but the proof carries no mac; it was produced unsealed' })
    } else {
      const expected = createHmac('sha256', options.key).update(canonicalizeProofBody(body), 'utf8').digest('hex')
      if (macMatches(expected, seal.mac)) macChecked = true
      else failures.push({ code: 'mac-invalid', detail: `mac does not verify under the supplied key (proof keyId ${seal.keyId ?? 'none'})` })
    }
  }

  if (options.expectRepo !== undefined && options.expectRepo !== body.subject.repo) {
    failures.push({ code: 'repo-mismatch', detail: `proof is for repo ${body.subject.repo}; ${options.expectRepo} was requested` })
  }

  let requiredSteps: readonly string[] = options.requiredSteps ?? []
  if (options.requiredSteps === undefined) {
    const known = SIGNOFF_REQUIRED_STEPS[body.subject.repo]
    if (known === undefined) {
      failures.push({ code: 'unknown-repo', detail: `no required-step table for ${body.subject.repo}; a repo with no declared bar cannot be signed off` })
    } else {
      requiredSteps = known
    }
  }

  const seen = new Map<string, number>()
  for (const step of body.steps) seen.set(step.id, (seen.get(step.id) ?? 0) + 1)
  for (const [id, count] of seen) {
    if (count > 1) failures.push({ code: 'duplicate-step', detail: `step ${id} appears ${count} times; a repeated id makes coverage ambiguous` })
  }

  const missing = requiredSteps.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    failures.push({ code: 'missing-required-step', detail: `required step(s) never ran: ${missing.join(', ')}` })
  }

  const declared = new Set(body.declaredRequired)
  const understated = requiredSteps.filter((id) => !declared.has(id))
  if (understated.length > 0) {
    failures.push({ code: 'lowered-bar', detail: `proof declares a smaller required set than ${body.subject.repo}'s table; missing: ${understated.join(', ')}` })
  }

  for (const step of body.steps) {
    if (step.status !== 'passed') {
      failures.push({ code: 'step-failed', detail: `step ${step.id} is ${step.status}, not passed (exit ${step.exitCode}, ${step.command})` })
    } else if (step.exitCode !== 0) {
      // An internally inconsistent record: the runner called it passed and the
      // process disagreed. Reported rather than resolved in either direction.
      failures.push({ code: 'step-failed', detail: `step ${step.id} claims status passed but exited ${step.exitCode} (${step.command})` })
    }
  }

  if (body.verdict !== 'pass') {
    failures.push({ code: 'verdict-fail', detail: `the run recorded verdict ${body.verdict}` })
  }

  if (body.subject.tree !== body.subject.commitTree) {
    failures.push({
      code: 'dirty-worktree',
      detail: `checks ran against tree ${body.subject.tree} while the commit carries ${body.subject.commitTree}; uncommitted work was in the tree`,
    })
  }

  if (body.subject.commitTree !== target.commitTree) {
    failures.push({ code: 'tree-mismatch', detail: `proof covers tree ${body.subject.commitTree}; ${target.commit} carries ${target.commitTree}` })
  }

  const commitBinding: SignoffCommitBinding =
    body.subject.commit === target.commit ? 'exact' : body.subject.commitTree === target.commitTree ? 'tree-equivalent' : 'none'
  if (commitBinding === 'none') {
    failures.push({ code: 'commit-unbound', detail: `proof names commit ${body.subject.commit}, which is neither ${target.commit} nor its content` })
  }

  // Staleness, checked two ways because neither is sufficient alone.
  //
  // The clock catches a proof back-dated relative to the commit it names. Its
  // resolution is git's, one second, so it is deliberately not the only check.
  const signedAt = Date.parse(body.signedAt)
  if (signedAt < Date.parse(body.subject.committedAt)) {
    failures.push({ code: 'stale-proof', detail: `signed at ${body.signedAt}, before the commit it names was written at ${body.subject.committedAt}` })
  }
  // Ancestry catches the case the clock cannot: a proof accepted on CONTENT
  // grounds for a LATER commit in the same history. A rebase or a squash
  // replaces the verified commit, so it is not reachable from the result — but a
  // revert restores an old tree on top of work nobody verified, and there the
  // proof's commit IS an ancestor. Same tree, different history, unverified
  // commits in between.
  if (commitBinding === 'tree-equivalent' && options.isAncestor(body.subject.commit, target.commit)) {
    failures.push({
      code: 'stale-proof',
      detail: `${body.subject.commit} is an ancestor of ${target.commit}; the tree matches only because later work was undone, and that work was never signed off`,
    })
  }

  return { ok: failures.length === 0, commitBinding, macChecked, failures, proof, target, requiredSteps }
}

export interface VerifySignoffAtRevInput {
  readonly repoDir: string
  readonly rev: string
  readonly key?: Uint8Array
  readonly requiredSteps?: readonly string[]
  readonly expectRepo?: string
}

type SignoffLookupFailure = { readonly found: false; readonly commit: string; readonly hint: readonly string[] }
export type SignoffVerifyOutcome = ({ readonly found: true } & SignoffVerification) | SignoffLookupFailure

/** Verify by revision: find the proof attached to that SHA (or to its content), then check it. */
export function verifySignoffAtRev(input: VerifySignoffAtRevInput): SignoffVerifyOutcome {
  const lookup = resolveSignoffProof(input.repoDir, input.rev)
  const target = readCommitFacts(input.repoDir, input.rev)
  if (!lookup.found) return { found: false, commit: lookup.commit, hint: SIGNOFF_NOTES_GIT_CONFIG }
  return {
    found: true,
    ...verifySignoffProof(lookup.proof, {
      target,
      isAncestor: gitIsAncestor(input.repoDir),
      key: input.key,
      requiredSteps: input.requiredSteps,
      expectRepo: input.expectRepo,
    }),
  }
}

export interface VerifySignoffFileInput {
  readonly repoDir: string
  readonly file: string
  /**
   * The commit to check the file against. REQUIRED, and deliberately not
   * defaulted to the commit the proof names: a proof checked against its own
   * subject can never fail the commit binding, which is a check that reads as
   * strong and cannot catch anything. The reader always states what they are
   * asking about.
   */
  readonly rev: string
  readonly key?: Uint8Array
  readonly requiredSteps?: readonly string[]
  readonly expectRepo?: string
}

/** Verify a proof document on disk. The repo is still required — "matches the tree it claims" is not answerable without it. */
export function verifySignoffProofFile(input: VerifySignoffFileInput): SignoffVerification {
  const proof = parseSignoffProof(readFileSync(input.file, 'utf8'))
  const target = readCommitFacts(input.repoDir, input.rev)
  return verifySignoffProof(proof, {
    target,
    isAncestor: gitIsAncestor(input.repoDir),
    key: input.key,
    requiredSteps: input.requiredSteps,
    expectRepo: input.expectRepo,
  })
}

/** One line per failure, prefixed by its code, in the order the checks ran. */
export function formatSignoffVerification(result: SignoffVerification): string {
  const head = result.ok
    ? `VERIFIED ${result.proof.body.subject.repo}@${result.target.commit.slice(0, 9)} binding=${result.commitBinding} mac=${result.macChecked ? 'checked' : 'unchecked'}`
    : `REJECTED ${result.proof.body.subject.repo}@${result.target.commit.slice(0, 9)} binding=${result.commitBinding} (${result.failures.length} failure${result.failures.length === 1 ? '' : 's'})`
  return [head, ...result.failures.map((failure) => `  ${failure.code}: ${failure.detail}`)].join('\n')
}
