/**
 * The join between the runner and the proof: one sign-off run produces one
 * report, and this turns that report into the signed, attachable record.
 *
 * Nothing here re-runs or re-judges anything. The runner owns what happened; the
 * proof owns what is provable about it later. Keeping the two in one direction
 * is what stops a second, drifting idea of "which steps ran" from appearing.
 */
import { hashStepOutput, buildSignoffProof, type SignoffProof, type SignoffProofStep } from './proof-record'
import { readCommitFacts } from './proof-git'
import type { SignoffReport, SignoffStepResult } from './types'

/**
 * A step that never executed has no exit code, so it is recorded as one no
 * process can produce. `status` is what a reader and the verifier judge on;
 * this exists so the field is never a plausible-looking `0`.
 */
const NO_EXIT_CODE = -1

/** The `command` of a step that never executed. A skipped step had no command line. */
const NOT_EXECUTED_COMMAND = '(never executed)'

export interface ProofFromReportInput {
  readonly report: SignoffReport
  /** Repo identity the verifier's required-step table is keyed on. */
  readonly repo: string
  /** Source repository. Defaults to the root the run recorded. */
  readonly repoDir?: string
  /** Step ids the run treated as required. Defaults to every step the report carries. */
  readonly declaredRequired?: readonly string[]
  readonly key?: Uint8Array
  readonly now?: Date
}

function stepFromResult(result: SignoffStepResult, startedAtEpochMs: number): SignoffProofStep {
  const attempts = result.attempts
  const worst = attempts.reduce<number>((worstSoFar, attempt) => (attempt.exitCode !== 0 ? attempt.exitCode : worstSoFar), 0)
  return {
    id: result.name,
    command: attempts[0]?.command ?? NOT_EXECUTED_COMMAND,
    cwd: '.',
    status: result.status,
    exitCode: attempts.length === 0 ? NO_EXIT_CODE : worst,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    startedAt: new Date(startedAtEpochMs + (result.startedAtMs ?? 0)).toISOString(),
    // Every attempt's output, in order — a shuffled step that failed on the
    // second seed must not digest to the same value as one that passed twice.
    outputSha256: hashStepOutput(attempts.map((attempt) => attempt.output).join('\n')),
  }
}

/** Every seed the run used, keyed so a reader can replay one step rather than the whole run. */
function seedsFromReport(report: SignoffReport): Record<string, string | number> {
  const seeds: Record<string, string | number> = { base: report.seedBase }
  for (const step of report.steps) {
    step.attempts.forEach((attempt, index) => {
      if (attempt.seed !== null) seeds[`${step.name}#${index}`] = attempt.seed
    })
  }
  return seeds
}

export function proofFromSignoffReport(input: ProofFromReportInput): SignoffProof {
  const { report } = input
  const repoDir = input.repoDir ?? report.repo.root

  // HEAD moving during a run makes every later claim ambiguous — the checks ran
  // over one commit and the proof would name another. Refused, not reconciled.
  const facts = readCommitFacts(repoDir, 'HEAD')
  if (facts.commit !== report.repo.head) {
    throw new Error(`HEAD moved during the sign-off: the run verified ${report.repo.head}, ${repoDir} is now at ${facts.commit}`)
  }

  const startedAtEpochMs = Date.parse(report.startedAt)
  const install: SignoffProofStep = {
    id: 'install',
    command: report.install.command,
    cwd: report.workspace,
    status: report.install.exitCode === 0 ? 'passed' : 'failed',
    exitCode: report.install.exitCode,
    durationMs: Math.max(0, Math.round(report.install.durationMs)),
    startedAt: new Date(startedAtEpochMs).toISOString(),
    outputSha256: hashStepOutput(report.install.output),
  }
  const steps = [install, ...report.steps.map((step) => stepFromResult(step, startedAtEpochMs))]

  return buildSignoffProof({
    repoDir,
    repo: input.repo,
    steps,
    wallClockMs: report.wallClockMs,
    declaredRequired: input.declaredRequired ?? steps.map((step) => step.id),
    seeds: seedsFromReport(report),
    key: input.key,
    now: input.now,
  })
}
