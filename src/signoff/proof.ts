/**
 * The sign-off proof surface: build a machine-checkable record of a local
 * verification run, attach it to the commit it verified, and check it later.
 *
 * Node-only (git, `fs`, `crypto`) and deliberately its own subpath, the way
 * `/peer-floors` is — a consumer runs this from a script, never from a bundle.
 *
 * The threat model is in `proof-record.ts` and the carrier tradeoff is in
 * `proof-attach.ts`. Both are load-bearing; read them before relying on a proof.
 */
export {
  NOT_EXECUTED_COMMAND,
  NO_EXIT_CODE,
  proofFromSignoffReport,
  seedsFromReport,
  type ProofFromReportInput,
} from './proof-from-report'

export {
  SIGNOFF_PROOF_VERSION,
  SIGNOFF_STEP_STATUSES,
  buildSignoffProof,
  canonicalJson,
  canonicalizeProofBody,
  collectToolingFacts,
  formatSignoffSummary,
  hashProofBody,
  hashStepOutput,
  macMatches,
  parseSignoffProof,
  readInstalledVersion,
  readSignoffKey,
  sealProof,
  serializeSignoffProof,
  signoffKeyId,
  signoffProofBodySchema,
  signoffProofSchema,
  signoffProofSealSchema,
  signoffProofStepSchema,
  tangleDependencyNames,
  type BuildSignoffProofInput,
  type SignoffProof,
  type SignoffProofBody,
  type SignoffProofPeer,
  type SignoffProofSeal,
  type SignoffProofStep,
  type SignoffProofSubject,
  type ToolingFactsInput,
} from './proof-record'

export {
  SIGNOFF_NOTES_GIT_CONFIG,
  SIGNOFF_NOTES_REF,
  attachSignoffProof,
  listSignoffProofs,
  readSignoffProofNote,
  resolveSignoffProof,
  type AttachSignoffProofInput,
  type AttachedSignoffProof,
  type SignoffProofLookup,
} from './proof-attach'

export {
  SIGNOFF_REQUIRED_STEPS,
  formatSignoffVerification,
  requiredStepsFor,
  verifySignoffAtRev,
  verifySignoffProof,
  verifySignoffProofFile,
  type SignoffCommitBinding,
  type SignoffFailure,
  type SignoffFailureCode,
  type SignoffLookupFailure,
  type SignoffVerification,
  type SignoffVerifyOutcome,
  type VerifySignoffAtRevInput,
  type VerifySignoffFileInput,
  type VerifySignoffProofOptions,
} from './proof-verify'

export {
  SignoffGitError,
  computeWorktreeTree,
  gitIsAncestor,
  gitText,
  readCommitFacts,
  resolveCommit,
  runGit,
  type CommitFacts,
  type GitResult,
  type IsAncestorFn,
} from './proof-git'
