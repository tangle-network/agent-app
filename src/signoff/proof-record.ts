/**
 * The sign-off proof record: what a local verification run produces so that a
 * merged commit can be interrogated later.
 *
 * ## Threat model — read this before trusting a proof
 *
 * A proof defends against **accident and drift**:
 *   - a check that was never run, or ran and failed, being reported as green
 *   - a proof produced over a different tree than the commit carries
 *   - a proof copied from one commit onto another
 *   - a field edited by hand after the fact
 *   - a run whose peer versions or tool versions differ from what a reader assumes
 *
 * It does **not** defend against a malicious operator. The HMAC key is a local
 * file on the same machine that runs the checks, so anyone who can run a
 * sign-off can also mint a proof for checks that never ran. There is no secret
 * server, by requirement. What the seal buys is that a proof cannot be produced
 * or altered by someone WITHOUT that key, and that a proof cannot be silently
 * retargeted, which is the whole failure class an absent CI leaves open.
 *
 * Trust in the numbers themselves comes from the steps being real commands with
 * real exit codes and an output digest — not from cryptography.
 */
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { computeWorktreeTree, readCommitFacts } from './proof-git'
import type { SignoffStepStatus } from './types'

/** Bumped when the canonical body shape changes; a verifier refuses versions it does not know. */
export const SIGNOFF_PROOF_VERSION = 1

const isoString = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be a UTC ISO-8601 timestamp')
const sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-hex git object id')
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-hex sha256 digest')

/**
 * The runner's step outcomes, restated as proof vocabulary.
 *
 * A status is carried alongside the exit code because they answer different
 * questions and only one of them is safe on its own: a step that was `skipped`,
 * `cancelled` or `blocked` never produced an exit code at all, and defaulting
 * that to `0` is precisely how a run that did not happen reads as a pass.
 *
 * The `satisfies` and the `Exclude` below pin this list to the runner's own
 * union in BOTH directions, so a status added there fails this file's typecheck
 * instead of quietly arriving as an unmodelled string.
 */
const SIGNOFF_STEP_STATUSES = ['passed', 'failed', 'skipped', 'cancelled', 'blocked'] as const satisfies readonly SignoffStepStatus[]
type UnmodelledStatus = Exclude<SignoffStepStatus, (typeof SIGNOFF_STEP_STATUSES)[number]>
const _everyRunnerStatusIsModelled: UnmodelledStatus[] = []
void _everyRunnerStatusIsModelled

const signoffProofStepSchema = z.object({
  /** Stable id a repo's required-step table refers to (`typecheck`, `test`, `knip`, …). */
  id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  /** How the runner judged the step. Only `passed` can satisfy a requirement. */
  status: z.enum(SIGNOFF_STEP_STATUSES),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  startedAt: isoString,
  /** sha256 of the step's combined stdout+stderr. Logs are not carried; the digest is. */
  outputSha256: sha256Hex,
})

const signoffProofPeerSchema = z.object({
  name: z.string().min(1),
  /** `null` when the package is not resolvable on disk — recorded, never guessed. */
  version: z.string().min(1).nullable(),
})

const signoffProofSubjectSchema = z.object({
  repo: z.string().min(1),
  commit: sha1Hex,
  /** Tree the checks actually ran against, including uncommitted work. */
  tree: sha1Hex,
  /** Tree the commit itself carries. Equal to `tree` on a clean sign-off. */
  commitTree: sha1Hex,
  parents: z.array(sha1Hex),
  committedAt: isoString,
})

const signoffProofBodySchema = z.object({
  proofVersion: z.number().int().positive(),
  subject: signoffProofSubjectSchema,
  signedAt: isoString,
  host: z.object({
    hostname: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    user: z.string().min(1),
  }),
  tooling: z.object({
    node: z.string().min(1),
    pnpm: z.string().min(1).nullable(),
    peers: z.array(signoffProofPeerSchema),
  }),
  /**
   * Real elapsed time for the whole run. Recorded separately from the steps
   * because the runner schedules them as wide as their dependencies allow, so
   * the sum of step durations is the SERIAL cost and would overstate this.
   */
  wallClockMs: z.number().int().nonnegative(),
  /** Seeds fed to anything non-deterministic, so a reader can reproduce the same run. */
  seeds: z.record(z.string(), z.union([z.string(), z.number()])),
  /** The step ids this run claims were required. The verifier holds the authoritative table. */
  declaredRequired: z.array(z.string().min(1)),
  steps: z.array(signoffProofStepSchema),
  verdict: z.enum(['pass', 'fail']),
})

const signoffProofSealSchema = z.object({
  algorithm: z.enum(['sha256', 'hmac-sha256']),
  /** sha256 over the canonical body. Chains the seal to every field, including the commit and tree. */
  bodySha256: sha256Hex,
  /** First 12 hex of sha256(key), so a reader can tell WHICH key sealed this. */
  keyId: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  mac: sha256Hex.nullable(),
})

const signoffProofSchema = z.object({
  body: signoffProofBodySchema,
  seal: signoffProofSealSchema,
})

export type SignoffProofStep = z.infer<typeof signoffProofStepSchema>
export type SignoffProofPeer = z.infer<typeof signoffProofPeerSchema>
export type SignoffProofSubject = z.infer<typeof signoffProofSubjectSchema>
export type SignoffProofBody = z.infer<typeof signoffProofBodySchema>
export type SignoffProofSeal = z.infer<typeof signoffProofSealSchema>
export type SignoffProof = z.infer<typeof signoffProofSchema>

type CanonicalValue = string | number | boolean | null | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }

/**
 * Deterministic JSON: object keys sorted, array order preserved, no whitespace.
 *
 * The seal is a hash over this string, so two readers must produce byte-identical
 * bytes from the same record. `undefined` throws rather than vanishing — a field
 * that silently disappears is a field the hash stops covering.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${String(value)} is not representable`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as { readonly [key: string]: CanonicalValue }
  const keys = Object.keys(record).sort()
  const fields = keys.map((key) => {
    const entry = record[key]
    if (entry === undefined) throw new Error(`canonicalJson: field ${JSON.stringify(key)} is undefined`)
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`
  })
  return `{${fields.join(',')}}`
}

export function canonicalizeProofBody(body: SignoffProofBody): string {
  return canonicalJson(body as unknown as CanonicalValue)
}

export function hashProofBody(body: SignoffProofBody): string {
  return createHash('sha256').update(canonicalizeProofBody(body), 'utf8').digest('hex')
}

/** The digest a runner records for a step's combined output. Shared so both halves agree. */
export function hashStepOutput(output: string): string {
  return createHash('sha256').update(output, 'utf8').digest('hex')
}

export function signoffKeyId(key: Uint8Array): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/** Read the local sign-off key. Throws when absent — an unreadable key is never a silent downgrade to unsealed. */
export function readSignoffKey(path: string): Uint8Array {
  const raw = readFileSync(path)
  if (raw.byteLength < 16) throw new Error(`sign-off key at ${path} is ${raw.byteLength} bytes; at least 16 are required`)
  return new Uint8Array(raw)
}

export function sealProof(body: SignoffProofBody, key?: Uint8Array): SignoffProof {
  const canonical = canonicalizeProofBody(body)
  const bodySha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')
  if (key === undefined) {
    return { body, seal: { algorithm: 'sha256', bodySha256, keyId: null, mac: null } }
  }
  return {
    body,
    seal: {
      algorithm: 'hmac-sha256',
      bodySha256,
      keyId: signoffKeyId(key),
      mac: createHmac('sha256', key).update(canonical, 'utf8').digest('hex'),
    },
  }
}

/** Constant-time comparison of two hex digests of equal length. */
export function macMatches(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

interface ToolingFactsInput {
  readonly repoDir: string
  /** Package names whose resolved on-disk version belongs in the proof. */
  readonly peerNames: readonly string[]
}

/**
 * The versions that actually resolved on disk — the field CI's clean install
 * makes trustworthy and a warm local `node_modules` does not. A below-floor peer
 * is invisible to typecheck and to a green suite (it fails at the wire call), so
 * the proof records what was really there rather than what the manifest asks for.
 */
function collectToolingFacts(input: ToolingFactsInput): SignoffProofBody['tooling'] {
  return {
    node: process.version,
    pnpm: readPnpmVersion(input.repoDir),
    peers: input.peerNames.map((name) => ({ name, version: readInstalledVersion(input.repoDir, name) })),
  }
}

/** `null` when pnpm is not on PATH — a missing version is recorded as missing, never as a guess. */
function readPnpmVersion(repoDir: string): string | null {
  const result = spawnSync('pnpm', ['--version'], { cwd: repoDir, encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  return result.stdout.trim()
}

/** Resolved version from the consumer's own `node_modules`, or `null` when the package is not there. */
function readInstalledVersion(repoDir: string, packageName: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(repoDir, 'node_modules', packageName, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** Every `@tangle-network/*` name the repo declares as a peer or a dependency. */
function tangleDependencyNames(repoDir: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = new Set<string>()
  for (const block of [manifest.dependencies, manifest.peerDependencies, manifest.devDependencies]) {
    for (const name of Object.keys(block ?? {})) {
      if (name.startsWith('@tangle-network/')) names.add(name)
    }
  }
  return [...names].sort()
}

export interface BuildSignoffProofInput {
  readonly repoDir: string
  /** Repo identity the verifier's required-step table is keyed on. */
  readonly repo: string
  /** Revision the sign-off is for; defaults to `HEAD`. */
  readonly rev?: string
  readonly steps: readonly SignoffProofStep[]
  /** Measured elapsed time for the run. Required — it is not derivable from the steps. */
  readonly wallClockMs: number
  /** Step ids this run treated as required. Checked against the verifier's table. */
  readonly declaredRequired: readonly string[]
  readonly seeds: Readonly<Record<string, string | number>>
  readonly peerNames?: readonly string[]
  readonly key?: Uint8Array
  readonly now?: Date
}

export function buildSignoffProof(input: BuildSignoffProofInput): SignoffProof {
  const facts = readCommitFacts(input.repoDir, input.rev ?? 'HEAD')
  const body: SignoffProofBody = {
    proofVersion: SIGNOFF_PROOF_VERSION,
    subject: {
      repo: input.repo,
      commit: facts.commit,
      tree: computeWorktreeTree(input.repoDir),
      commitTree: facts.commitTree,
      parents: [...facts.parents],
      committedAt: facts.committedAt,
    },
    signedAt: (input.now ?? new Date()).toISOString(),
    wallClockMs: Math.max(0, Math.round(input.wallClockMs)),
    host: { hostname: hostname(), platform: process.platform, arch: process.arch, user: userInfo().username },
    tooling: collectToolingFacts({ repoDir: input.repoDir, peerNames: input.peerNames ?? tangleDependencyNames(input.repoDir) }),
    seeds: { ...input.seeds },
    declaredRequired: [...input.declaredRequired],
    steps: input.steps.map((step) => ({ ...step })),
    verdict: input.steps.every((step) => step.status === 'passed' && step.exitCode === 0) ? 'pass' : 'fail',
  }
  return sealProof(signoffProofBodySchema.parse(body), input.key)
}

/** Parse an untrusted proof document, failing loud on any shape the verifier cannot reason about. */
export function parseSignoffProof(json: string): SignoffProof {
  return signoffProofSchema.parse(JSON.parse(json))
}

export function serializeSignoffProof(proof: SignoffProof): string {
  return `${JSON.stringify(proof, null, 2)}\n`
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * The single line an operator pastes into a PR or a merge commit: how many steps
 * ran, how long it took, the seeds, and the verdict.
 */
export function formatSignoffSummary(proof: SignoffProof): string {
  const { body, seal } = proof
  const passed = body.steps.filter((step) => step.status === 'passed' && step.exitCode === 0).length
  const serialMs = body.steps.reduce((total, step) => total + step.durationMs, 0)
  // Wall clock is the number an operator is deciding on. The serial total rides
  // alongside it only when the schedule actually overlapped, so a parallel run
  // shows its saving instead of claiming one.
  const wall = serialMs > body.wallClockMs ? `${formatDuration(body.wallClockMs)} (serial ${formatDuration(serialMs)})` : formatDuration(body.wallClockMs)
  const seeds = Object.entries(body.seeds)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')
  const seal_ = seal.algorithm === 'hmac-sha256' ? `sealed ${seal.algorithm} key ${seal.keyId ?? 'unknown'}` : `unsealed sha256 ${seal.bodySha256.slice(0, 12)}`
  const dirty = body.subject.tree === body.subject.commitTree ? '' : ' DIRTY-TREE'
  return [
    `signoff ${body.verdict}${dirty}`,
    `${passed}/${body.steps.length} steps`,
    wall,
    `${body.subject.repo}@${body.subject.commit.slice(0, 9)} tree ${body.subject.tree.slice(0, 9)}`,
    seeds.length === 0 ? 'seeds none' : `seeds ${seeds}`,
    `node ${body.tooling.node} pnpm ${body.tooling.pnpm ?? 'unresolved'}`,
    seal_,
    body.signedAt,
  ].join(' · ')
}
