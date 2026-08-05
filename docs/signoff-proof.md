# Sign-off proof

`@tangle-network/agent-app/signoff/proof` is the record a local sign-off leaves behind, and the command that checks it.

The runner (`./signoff`) decides whether a commit passes.
This half makes that decision **interrogable later**: given a merged SHA, anyone can ask *was this signed off, by what, and did it pass* and get a definite answer.

## What is in a proof

| Field | Why it is there |
| --- | --- |
| `subject.commit`, `subject.parents`, `subject.committedAt` | which commit the run was about |
| `subject.commitTree` | the tree that commit carries — the binding that survives a rebase |
| `subject.tree` | the tree the checks **actually ran against**, including uncommitted and untracked files |
| `steps[]` | id, command, cwd, status, exit code, duration, start time, and a sha256 of the step's combined output |
| `declaredRequired` | the bar the run claims it met — cross-checked, never trusted |
| `seeds` | every seed the run used, so a reader can replay one step |
| `tooling.node`, `tooling.pnpm`, `tooling.peers[]` | the versions that **resolved on disk**, which is the thing a warm `node_modules` gets wrong |
| `host` | hostname, platform, arch, user |
| `signedAt` | UTC, when the sign-off finished |
| `seal` | sha256 over the canonical body, plus an HMAC under a local key |

`subject.tree` is the field that makes drift detectable.
It is computed with `git add -A` into a throwaway index, so it covers untracked files, honours `.gitignore` (a warm `node_modules` is not drift), and never touches the real index another agent may be using.

## Threat model — stated plainly

A proof defends against **accident and drift**:

- a check that never ran, or ran and failed, being reported as green
- a step that was skipped, cancelled or blocked reading as a pass (it has no exit code, and `0` is the wrong thing to assume)
- a proof produced over a different tree than the commit carries
- a proof copied from one commit onto another
- a field edited by hand after the fact
- a run whose peer or tool versions differ from what a reader assumes

It does **not** defend against a malicious operator.
The HMAC key is a local file on the machine that runs the checks, so anyone who can run a sign-off can also mint a proof for checks that never ran.
There is no secret server, by requirement.
What the seal buys is that a proof cannot be produced or altered by someone **without** that key, and cannot be silently retargeted at another commit.

Trust in the numbers themselves comes from the steps being real commands with real exit codes and an output digest — not from cryptography.

## Why `git notes`, and what the alternatives cost

The requirement is that the proof attaches to the commit, not to a file someone can forget.
Three carriers were evaluated.

**A commit-message trailer** cannot carry the field that matters.
The trailer is part of the commit object, so writing it changes the SHA the proof claims to cover — the proof would have to exist before the commit it names.
Amending rewrites the SHA again, and a GitHub squash-merge rebuilds the message from the PR body, so the trailer does not survive the one transition it would need to.

**A committed artifact directory** (`.signoff/<sha>.json`) changes the tree, so the tree hash inside the proof can never cover the file carrying it.
It also lands in every diff, and deleting it looks like a normal change — the "file someone can forget" shape the requirement rules out.

**`git notes` is the only carrier addressed BY the SHA without being part of it.**
The note is written after the commit exists, changes neither the SHA nor the tree, and `git notes show <sha>` is a definite yes/no for any commit anyone can name.

### The tradeoff it really carries

Notes attach to a commit id, and a rebase or squash-merge produces a new one, so the note does not follow by itself.
Two mechanisms close that, and both are needed:

1. `notes.rewriteRef` makes local rebase and amend copy the note forward.
2. `resolveSignoffProof` falls back to a **tree scan** — it matches a stored proof against the tree the commit carries. A rebase or a squash of one branch onto an unchanged base preserves the tree, so the content that was verified is provably the content that merged.

The verifier reports which binding it used and never conflates them:

- `exact` — the proof names this commit.
- `tree-equivalent` — different commit id, byte-identical content.
- `none` — the proof does not describe this commit. Always a failure.

Notes are neither pushed nor fetched by default. Configure once per clone:

```bash
git config --add remote.origin.fetch '+refs/notes/signoff:refs/notes/signoff'
git config --add remote.origin.push 'refs/notes/signoff'
git config notes.rewriteRef 'refs/notes/signoff'
git config notes.rewrite.amend true
git config notes.rewrite.rebase true
```

`agent-app-verify-proof` prints these whenever a commit has no proof, because an unconfigured clone is the usual cause rather than an unsigned commit.

## `agent-app-verify-proof`

```bash
agent-app-verify-proof <rev>                     # look the proof up by commit
agent-app-verify-proof --file proof.json <rev>   # check a document against a commit
  --dir <repo>    repository to read (default: cwd)
  --key <file>    local HMAC key; without it the mac is reported unchecked, never assumed good
  --repo <name>   the repo the reader expects; a mismatch is a failure
  --json          machine-readable result
```

Exit 0 only when every check passes.
Exit 1 on any failure, **and on a commit with no proof at all** — "nobody signed this off" is a rejection, not a pass.

`--file` requires a revision to check against, and does not default to the commit the proof names.
A proof checked against its own subject can never fail the commit binding, which is a check that reads as strong and catches nothing.

### What it fails on

| Code | Catches |
| --- | --- |
| `tree-mismatch` | the proof covers a different tree than the commit carries |
| `dirty-worktree` | the checks ran over uncommitted work, so no commit carries what was verified |
| `commit-unbound` | the proof describes neither this commit nor its content |
| `missing-required-step` | a step in the repo's table never ran |
| `lowered-bar` | the proof declares a smaller required set than its repo's table |
| `duplicate-step` | one step id twice, which makes coverage ambiguous |
| `step-failed` | a step that failed, **or one that never ran**, or a record whose status and exit code disagree |
| `verdict-fail` | the run recorded a failing verdict |
| `stale-proof` | signed before the commit it names, or reused on a later commit that restored the same tree |
| `body-tampered` | any field edited after sealing |
| `mac-invalid` / `mac-missing` | sealed under a different key, or not sealed at all |
| `unknown-repo` / `repo-mismatch` | no required-step table, or the wrong repo |
| `unsupported-version` | a proof format this verifier does not read |

### Two rules worth understanding

**The proof does not own its own bar.**
A run that declares its requirements can declare none, so the authoritative table lives in the verifier (`SIGNOFF_REQUIRED_STEPS`), transcribed from each repo's CI job.
A proof declaring fewer requirements than its repo's table fails as `lowered-bar`.

**Staleness is checked two ways, because the clock alone cannot answer it.**
Git records committer time to the second, so a proof and the commit it is replayed onto routinely share a timestamp.
The clock check catches a back-dated proof.
The clock-free check catches the case it cannot: when the binding is `tree-equivalent` and the proof's commit is an **ancestor** of the target, the tree matches only because later work was reverted — and that work was never signed off.
A rebase or squash replaces the verified commit, so it is not reachable from the result; a revert leaves it reachable. That is the discriminator.

## The line to paste

`formatSignoffSummary(proof)` is one line for a PR comment or a merge commit:

```
signoff pass · 7/7 steps · 4m12s · agent-app@2b0bd8621 tree 189b3865c · seeds base=481207 test#0=481207 test#1=912774 · node v22.14.0 pnpm 11.17.0 · sealed hmac-sha256 key 544e62cee803 · 2026-08-05T01:28:00.867Z
```

A sign-off that ran over a dirty tree says `DIRTY-TREE` in that line, so a drifted run cannot be pasted as a clean one.

## Composition

```ts
import { runSignoff } from '@tangle-network/agent-app/signoff'
import { proofFromSignoffReport, attachSignoffProof, formatSignoffSummary, readSignoffKey } from '@tangle-network/agent-app/signoff/proof'

const report = await runSignoff({ repoDir: process.cwd() })
const proof = proofFromSignoffReport({ report, repo: 'agent-app', key: readSignoffKey(keyPath) })
attachSignoffProof({ repoDir: process.cwd(), proof })
console.log(formatSignoffSummary(proof))
```

`proofFromSignoffReport` refuses to build a proof if HEAD moved during the run: the checks ran over one commit and the proof would name another, and that is not reconcilable after the fact.

## What a proof does not prove

- That the required steps are the *right* steps. The table is a transcription of CI; keeping it honest is a review question.
- That the commands did what their names say. A step called `test` that runs `true` exits 0 and seals cleanly.
- Anything about a commit whose tree nobody verified. That is reported as `NO PROOF`, which is the correct answer, not a gap.
