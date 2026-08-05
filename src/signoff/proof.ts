/**
 * The sign-off proof surface: build a machine-checkable record of a local
 * verification run, attach it to the commit it verified, and check it later.
 *
 * Node-only (git, `fs`, `crypto`) and deliberately its own subpath, the way
 * `/peer-floors` is — a consumer runs this from a script, never from a bundle.
 *
 * The threat model is in `proof-record.ts` and the carrier tradeoff is in
 * `proof-attach.ts`. Both are load-bearing; read them before relying on a proof.
 *
 * **Surface is narrowed to what a caller composes, not what this file happens
 * to define.** The `agent-app-signoff` bin itself does NOT build or attach a
 * proof today — it runs the gate and prints the plain report (`./cli.ts`); the
 * proof pipeline below is the documented composition [`docs/signoff-proof.md`]
 * a product wires into its OWN CI step. Schema internals, hashing primitives
 * and low-level git plumbing (`canonicalJson`, `hashProofBody`, `sealProof`,
 * `runGit`, the zod schemas, …) stay module-internal, where `knip` can see
 * them unused rather than reading as committed public API with zero callers.
 */
export {
  verifySignoffProof,
  type SignoffCommitBinding,
  type SignoffFailure,
  type SignoffFailureCode,
  type SignoffVerification,
  type VerifySignoffProofOptions,
} from './proof-verify'

export { formatSignoffSummary, parseSignoffProof, readSignoffKey } from './proof-record'
export type {
  SignoffProof,
  SignoffProofBody,
  SignoffProofPeer,
  SignoffProofSeal,
  SignoffProofStep,
  SignoffProofSubject,
} from './proof-record'

/** Types needed to construct `VerifySignoffProofOptions.target`/`.isAncestor`
 *  without pulling in this package's OWN git-shelling implementation — a
 *  consumer supplies commit facts and ancestry however it already tracks
 *  them (its own git library, a cache, …). */
export type { CommitFacts, IsAncestorFn } from './proof-git'

/**
 * The SIGNING side — building a proof from a report and attaching it to the
 * commit it verified. Nobody in this repo calls these today (the census that
 * justified narrowing this barrel found zero callers, this pair included);
 * they stay exported anyway because `docs/signoff-proof.md`'s documented
 * composition is the ONLY way to reach them at all — `package.json` declares
 * no `./signoff/proof-attach` or `./signoff/proof-from-report` subpath, so
 * dropping these here would make a real, tested, documented capability
 * unreachable from outside the package, not merely unexercised inside it.
 */
export { proofFromSignoffReport, type ProofFromReportInput } from './proof-from-report'
export { attachSignoffProof, type AttachSignoffProofInput, type AttachedSignoffProof } from './proof-attach'
