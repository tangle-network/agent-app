import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempRepo, passingSteps, type TempRepo } from './proof-fixture'
import { attachSignoffProof } from './proof-attach'
import { gitIsAncestor, readCommitFacts } from './proof-git'
import { buildSignoffProof, parseSignoffProof, sealProof, serializeSignoffProof, type SignoffProof, type SignoffProofStep } from './proof-record'
import { formatSignoffVerification, requiredStepsFor, SIGNOFF_REQUIRED_STEPS, verifySignoffAtRev, verifySignoffProof, verifySignoffProofFile } from './proof-verify'

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)
const AGENT_APP_STEPS = SIGNOFF_REQUIRED_STEPS['agent-app'] as readonly string[]

let repos: TempRepo[] = []
function repo(): TempRepo {
  const created = createTempRepo()
  repos.push(created)
  return created
}
afterEach(() => {
  for (const created of repos) created.cleanup()
  repos = []
})

interface Scenario {
  readonly fixture: TempRepo
  readonly proof: SignoffProof
  readonly commit: string
}

/** A repo with one commit and a full, passing, sealed agent-app sign-off over it. */
function signedOff(
  overrides: {
    readonly steps?: readonly SignoffProofStep[]
    readonly declaredRequired?: readonly string[]
    readonly repo?: string
    readonly key?: Uint8Array
    readonly now?: Date
    readonly drift?: boolean
  } = {},
): Scenario {
  const fixture = repo()
  fixture.write('src/a.ts', 'export const a = 1\n')
  const commit = fixture.commit('first')
  if (overrides.drift === true) fixture.write('src/a.ts', 'export const a = 2\n')
  const proof = buildSignoffProof({
    repoDir: fixture.dir,
    repo: overrides.repo ?? 'agent-app',
    steps: overrides.steps ?? passingSteps(AGENT_APP_STEPS),
    declaredRequired: overrides.declaredRequired ?? AGENT_APP_STEPS,
    wallClockMs: 240_000,
    seeds: { vitest: 1712 },
    key: overrides.key ?? KEY,
    now: overrides.now,
  })
  return { fixture, proof, commit }
}

function codes(result: { readonly failures: readonly { readonly code: string }[] }): string[] {
  return result.failures.map((failure) => failure.code)
}

function verify(scenario: Scenario, options: { readonly key?: Uint8Array; readonly rev?: string; readonly expectRepo?: string } = {}) {
  return verifySignoffProof(scenario.proof, {
    target: readCommitFacts(scenario.fixture.dir, options.rev ?? 'HEAD'),
    isAncestor: gitIsAncestor(scenario.fixture.dir),
    key: 'key' in options ? options.key : KEY,
    expectRepo: options.expectRepo,
  })
}

describe('the required-step table is the authority, not the proof', () => {
  it('transcribes each repo CI job', () => {
    expect(requiredStepsFor('agent-app')).toEqual(['install', 'typecheck', 'test:gates', 'test', 'build', 'test:generated', 'knip'])
    expect(requiredStepsFor('tax-agent')).toEqual(['install', 'peer-check', 'typecheck', 'test', 'toolkit-deps', 'toolkit-test', 'build', 'worker-startup'])
    expect(requiredStepsFor('legal-agent')).toEqual(['install', 'peer-check', 'typegen', 'typecheck', 'test', 'build:check'])
  })

  it('throws for a repo with no table — an unrecognised repo has no bar, and no bar is not a pass', () => {
    expect(() => requiredStepsFor('mystery-agent')).toThrow(/no required-step table/)
  })
})

describe('a complete, clean, sealed sign-off', () => {
  it('verifies, binds to the exact commit, and reports the mac as checked', () => {
    const result = verify(signedOff())
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.commitBinding).toBe('exact')
    expect(result.macChecked).toBe(true)
  })

  it('verifies against a rewritten SHA carrying the same tree, and says the binding was content, not identity', () => {
    const scenario = signedOff()
    scenario.fixture.git(['commit', '--amend', '-m', 'reworded', '--no-verify'])
    const result = verify(scenario)
    expect(result.ok).toBe(true)
    expect(result.commitBinding).toBe('tree-equivalent')
  })
})

describe('FAILS: a proof whose tree hash does not match', () => {
  it('rejects a proof presented against a commit it did not verify', () => {
    const scenario = signedOff()
    scenario.fixture.write('src/b.ts', 'export const b = 2\n')
    scenario.fixture.commit('later work nobody signed off')

    const result = verify(scenario)
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('tree-mismatch')
    expect(codes(result)).toContain('commit-unbound')
    expect(result.commitBinding).toBe('none')
  })

  it('rejects a sign-off that ran over uncommitted drift, naming the two trees', () => {
    const result = verify(signedOff({ drift: true }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('dirty-worktree')
    expect(result.failures.find((failure) => failure.code === 'dirty-worktree')?.detail).toMatch(/uncommitted work/)
  })
})

describe('FAILS: a missing required step', () => {
  it('rejects a run that skipped knip, and names it', () => {
    const kept = AGENT_APP_STEPS.filter((id) => id !== 'knip')
    const result = verify(signedOff({ steps: passingSteps(kept), declaredRequired: kept }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('missing-required-step')
    expect(result.failures.find((failure) => failure.code === 'missing-required-step')?.detail).toContain('knip')
  })

  it('rejects a proof that declares a smaller bar than its repo, even when every declared step ran', () => {
    const result = verify(signedOff({ steps: passingSteps(['typecheck']), declaredRequired: ['typecheck'] }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('lowered-bar')
  })

  it('rejects a repeated step id, which would let one run stand in for two requirements', () => {
    const duplicated = [...passingSteps(AGENT_APP_STEPS), ...passingSteps(['test'])]
    const result = verify(signedOff({ steps: duplicated }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('duplicate-step')
  })

  it('rejects a repo with no required-step table at all', () => {
    const result = verify(signedOff({ repo: 'mystery-agent' }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('unknown-repo')
  })

  it('rejects a proof for a different repo than the reader asked about', () => {
    const result = verify(signedOff(), { expectRepo: 'legal-agent' })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('repo-mismatch')
  })
})

describe('FAILS: a step that exited non-zero', () => {
  it('rejects the run and names the step, its status and its exit code', () => {
    const steps = passingSteps(AGENT_APP_STEPS)
    const failing = [...steps]
    failing[6] = { ...(steps[6] as SignoffProofStep), status: 'failed', exitCode: 1 }

    const result = verify(signedOff({ steps: failing }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('step-failed')
    expect(codes(result)).toContain('verdict-fail')
    expect(result.failures.find((failure) => failure.code === 'step-failed')?.detail).toContain('step knip is failed, not passed (exit 1')
  })

  it('rejects a step that never ran, even though a step that never ran has exit code 0', () => {
    const steps = passingSteps(AGENT_APP_STEPS)
    const skipped = [...steps]
    skipped[6] = { ...(steps[6] as SignoffProofStep), status: 'skipped', exitCode: 0 }

    const result = verify(signedOff({ steps: skipped }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('step-failed')
    expect(result.failures.find((failure) => failure.code === 'step-failed')?.detail).toContain('step knip is skipped, not passed')
  })

  it('rejects a record whose status and exit code disagree, rather than believing either one', () => {
    const steps = passingSteps(AGENT_APP_STEPS)
    const inconsistent = [...steps]
    inconsistent[6] = { ...(steps[6] as SignoffProofStep), status: 'passed', exitCode: 3 }

    const result = verify(signedOff({ steps: inconsistent }))
    expect(result.ok).toBe(false)
    expect(result.failures.find((failure) => failure.code === 'step-failed')?.detail).toContain('claims status passed but exited 3')
  })
})

describe('FAILS: a stale proof', () => {
  it('rejects a proof signed before the commit it names was written', () => {
    const scenario = signedOff()
    const committedAt = Date.parse(scenario.proof.body.subject.committedAt)
    const stale = signedOff({ now: new Date(committedAt - 3600_000) })
    const result = verify(stale)
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('stale-proof')
  })

  it('rejects a proof reused on a newer commit that happens to restore the same tree', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    const proof = buildSignoffProof({
      repoDir: fixture.dir,
      repo: 'agent-app',
      steps: passingSteps(AGENT_APP_STEPS),
      declaredRequired: AGENT_APP_STEPS,
      wallClockMs: 240_000,
      seeds: {},
      key: KEY,
    })

    // A revert restores the exact tree the proof covered, on a commit written later.
    fixture.write('src/b.ts', 'export const b = 2\n')
    fixture.commit('add b')
    fixture.git(['revert', '--no-edit', 'HEAD'])
    const reverted = readCommitFacts(fixture.dir, 'HEAD')
    expect(reverted.commitTree).toBe(proof.body.subject.commitTree)

    const result = verifySignoffProof(proof, { target: reverted, isAncestor: gitIsAncestor(fixture.dir), key: KEY })
    expect(result.commitBinding).toBe('tree-equivalent')
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('stale-proof')
  })
})

describe('FAILS: a tampered field', () => {
  it('catches a failing step edited to look green — the seal is what notices, not the step check', () => {
    const steps = passingSteps(AGENT_APP_STEPS)
    const failing = [...steps]
    failing[6] = { ...(steps[6] as SignoffProofStep), status: 'failed', exitCode: 1 }
    const scenario = signedOff({ steps: failing })

    const doctored = JSON.parse(serializeSignoffProof(scenario.proof)) as {
      body: { steps: { status: string; exitCode: number }[]; verdict: string }
    }
    doctored.body.steps[6] = { ...(doctored.body.steps[6] as { status: string; exitCode: number }), status: 'passed', exitCode: 0 }
    doctored.body.verdict = 'pass'

    const result = verifySignoffProof(parseSignoffProof(JSON.stringify(doctored)), {
      target: readCommitFacts(scenario.fixture.dir, 'HEAD'),
      isAncestor: gitIsAncestor(scenario.fixture.dir),
      key: KEY,
    })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('body-tampered')
    expect(codes(result)).not.toContain('step-failed')
    expect(codes(result)).not.toContain('verdict-fail')
  })

  it('catches a re-sealed proof signed with a key the reader does not hold', () => {
    const scenario = signedOff({ key: OTHER_KEY })
    const result = verify(scenario, { key: KEY })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('mac-invalid')
    expect(result.macChecked).toBe(false)
  })

  it('catches an unsealed proof presented to a reader who expects a seal', () => {
    const scenario = signedOff()
    const unsealed = sealProof(scenario.proof.body)
    const result = verifySignoffProof(unsealed, { target: readCommitFacts(scenario.fixture.dir, 'HEAD'), isAncestor: gitIsAncestor(scenario.fixture.dir), key: KEY })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('mac-missing')
  })

  it('reports the mac as unchecked, never as good, when the reader supplies no key', () => {
    const result = verify(signedOff(), { key: undefined })
    expect(result.ok).toBe(true)
    expect(result.macChecked).toBe(false)
  })

  it('catches a proof version this verifier does not understand', () => {
    const scenario = signedOff()
    const future = sealProof({ ...scenario.proof.body, proofVersion: 99 }, KEY)
    const result = verifySignoffProof(future, { target: readCommitFacts(scenario.fixture.dir, 'HEAD'), isAncestor: gitIsAncestor(scenario.fixture.dir), key: KEY })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('unsupported-version')
  })
})

describe('verifySignoffAtRev', () => {
  it('answers a merged SHA from the note attached to it', () => {
    const scenario = signedOff()
    attachSignoffProof({ repoDir: scenario.fixture.dir, proof: scenario.proof })
    const outcome = verifySignoffAtRev({ repoDir: scenario.fixture.dir, rev: 'HEAD', key: KEY })
    expect(outcome.found).toBe(true)
    if (!outcome.found) throw new Error('unreachable')
    expect(outcome.ok).toBe(true)
  })

  it('answers a commit nobody signed off with not-found plus the notes config that usually explains it', () => {
    const scenario = signedOff()
    const outcome = verifySignoffAtRev({ repoDir: scenario.fixture.dir, rev: 'HEAD' })
    expect(outcome.found).toBe(false)
    if (outcome.found) throw new Error('unreachable')
    expect(outcome.commit).toBe(scenario.commit)
    expect(outcome.hint.join('\n')).toContain('refs/notes/signoff')
  })
})

describe('verifySignoffProofFile', () => {
  it('checks a proof document against the commit the reader named', () => {
    const scenario = signedOff()
    const file = join(scenario.fixture.dir, '..', 'proof.json')
    writeFileSync(file, serializeSignoffProof(scenario.proof))
    const result = verifySignoffProofFile({ repoDir: scenario.fixture.dir, file, rev: 'HEAD', key: KEY })
    expect(result.ok).toBe(true)
  })

  it('rejects the file when the reader asks about a commit the proof does not cover', () => {
    const scenario = signedOff()
    const file = join(scenario.fixture.dir, '..', 'proof.json')
    writeFileSync(file, serializeSignoffProof(scenario.proof))
    scenario.fixture.write('src/unsigned.ts', 'export const u = 1\n')
    scenario.fixture.commit('work nobody signed off')

    const result = verifySignoffProofFile({ repoDir: scenario.fixture.dir, file, rev: 'HEAD', key: KEY })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('tree-mismatch')
    expect(codes(result)).toContain('commit-unbound')
  })
})

describe('formatSignoffVerification', () => {
  it('leads with the verdict and lists each failure with its code', () => {
    const text = formatSignoffVerification(verify(signedOff({ drift: true })))
    expect(text.split('\n')[0]).toMatch(/^REJECTED agent-app@[0-9a-f]{9} binding=/)
    expect(text).toContain('dirty-worktree:')
  })

  it('says VERIFIED and names the binding when everything passes', () => {
    expect(formatSignoffVerification(verify(signedOff()))).toMatch(/^VERIFIED agent-app@[0-9a-f]{9} binding=exact mac=checked$/)
  })
})
