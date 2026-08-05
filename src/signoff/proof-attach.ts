/**
 * Attaching a proof to the commit it verified.
 *
 * ## Why `git notes`, and what the two rejected carriers cost
 *
 * **A commit-message trailer** cannot work for the field that matters. The
 * trailer is part of the commit object, so writing it changes the SHA the proof
 * claims to cover — the proof would have to be produced before the commit it
 * names exists. Amending re-writes the SHA again, and GitHub's squash-merge
 * rebuilds the message from the PR body, so the trailer does not survive the one
 * transition it would need to.
 *
 * **A committed artifact directory** (`.signoff/<sha>.json`) changes the tree,
 * so the tree hash inside the proof can never cover the file carrying it. It
 * also lands in every diff, and it is exactly the "file someone can forget"
 * shape the requirement rules out — deleting it is a normal-looking change.
 *
 * **`git notes` wins because it is the only carrier that is addressed BY the
 * SHA without being part of it.** The note is written after the commit exists,
 * it changes neither the SHA nor the tree, and `git notes show <sha>` is a
 * definite yes/no for any commit anyone can name.
 *
 * ## The tradeoff `git notes` really carries, and how this module answers it
 *
 * Notes are attached to a commit id, and a rebase or a squash-merge produces a
 * NEW commit id, so the note does not follow by itself. Two mechanisms close
 * that gap, and both are needed:
 *
 *  1. `notes.rewriteRef` (see `SIGNOFF_NOTES_GIT_CONFIG`) makes local rebase and
 *     amend copy the note forward automatically.
 *  2. `resolveSignoffProof` falls back to a **tree scan**: it reads every proof
 *     under the notes ref and matches on the TREE the commit carries. A rebase
 *     or a squash of one branch onto an unchanged base preserves the tree, so
 *     the content that was verified is still provably the content that merged,
 *     even though the SHA changed. The verifier reports which binding it used —
 *     `exact` or `tree-equivalent` — and never conflates them.
 *
 * Notes are neither pushed nor fetched by default; `SIGNOFF_NOTES_GIT_CONFIG`
 * carries the refspecs that fix that, and a missing note is reported as
 * `not-found`, never as a pass.
 */
import { parseSignoffProof, type SignoffProof } from './proof-record'
import { gitText, readCommitFacts, resolveCommit, runGit, SignoffGitError } from './proof-git'

export const SIGNOFF_NOTES_REF = 'refs/notes/signoff'

/**
 * The git configuration a repo needs for notes to travel. Emitted by the CLI
 * when a proof cannot be found, because the usual cause is an unconfigured repo
 * rather than an unsigned commit.
 */
export const SIGNOFF_NOTES_GIT_CONFIG: readonly string[] = [
  `git config --add remote.origin.fetch '+${SIGNOFF_NOTES_REF}:${SIGNOFF_NOTES_REF}'`,
  `git config --add remote.origin.push '${SIGNOFF_NOTES_REF}'`,
  `git config notes.rewriteRef '${SIGNOFF_NOTES_REF}'`,
  'git config notes.rewrite.amend true',
  'git config notes.rewrite.rebase true',
]

export interface AttachSignoffProofInput {
  readonly repoDir: string
  readonly proof: SignoffProof
  /** Revision to annotate; defaults to the commit the proof names. */
  readonly rev?: string
  /** Replace an existing note. Off by default so a second sign-off cannot quietly overwrite the first. */
  readonly overwrite?: boolean
}

export interface AttachedSignoffProof {
  readonly commit: string
  readonly ref: string
}

export function attachSignoffProof(input: AttachSignoffProofInput): AttachedSignoffProof {
  const commit = resolveCommit(input.repoDir, input.rev ?? input.proof.body.subject.commit)
  const args = ['notes', `--ref=${SIGNOFF_NOTES_REF}`, 'add']
  if (input.overwrite === true) args.push('-f')
  args.push('-F', '-', commit)
  const result = runGit(input.repoDir, args, { input: `${JSON.stringify(input.proof, null, 2)}\n` })
  if (result.status !== 0) throw new SignoffGitError(args, result.status, result.stderr)
  return { commit, ref: SIGNOFF_NOTES_REF }
}

export type SignoffProofLookup =
  | { readonly found: true; readonly proof: SignoffProof; readonly commit: string; readonly binding: 'exact' | 'tree-equivalent' }
  | { readonly found: false; readonly commit: string }

/** The note attached to exactly this commit, or `found: false`. Never searches. */
export function readSignoffProofNote(repoDir: string, rev: string): SignoffProofLookup {
  const commit = resolveCommit(repoDir, rev)
  const result = runGit(repoDir, ['notes', `--ref=${SIGNOFF_NOTES_REF}`, 'show', commit])
  if (result.status !== 0) return { found: false, commit }
  return { found: true, proof: parseSignoffProof(result.stdout), commit, binding: 'exact' }
}

/** Every proof stored under the notes ref, paired with the commit it annotates. */
export function listSignoffProofs(repoDir: string): readonly { readonly commit: string; readonly proof: SignoffProof }[] {
  const listed = runGit(repoDir, ['notes', `--ref=${SIGNOFF_NOTES_REF}`, 'list'])
  if (listed.status !== 0) return []
  const out: { commit: string; proof: SignoffProof }[] = []
  for (const line of listed.stdout.split('\n')) {
    const [noteBlob, commit] = line.trim().split(/\s+/)
    if (noteBlob === undefined || commit === undefined) continue
    out.push({ commit, proof: parseSignoffProof(gitText(repoDir, ['cat-file', 'blob', noteBlob])) })
  }
  return out
}

/**
 * Answer "was this SHA signed off" for any commit, including one produced by a
 * rebase or a squash-merge of the branch that was actually verified.
 *
 * Exact note first. Then the tree scan — a proof whose `commitTree` equals this
 * commit's tree verified byte-identical content, which is the strongest claim
 * available once the SHA has been rewritten. The binding is returned so a caller
 * can tell the two apart; nothing here treats them as the same thing.
 */
export function resolveSignoffProof(repoDir: string, rev: string): SignoffProofLookup {
  const direct = readSignoffProofNote(repoDir, rev)
  if (direct.found) return direct
  const facts = readCommitFacts(repoDir, rev)
  for (const entry of listSignoffProofs(repoDir)) {
    if (entry.proof.body.subject.commitTree === facts.commitTree) {
      return { found: true, proof: entry.proof, commit: facts.commit, binding: 'tree-equivalent' }
    }
  }
  return { found: false, commit: facts.commit }
}
