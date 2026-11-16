import type { SandboxRuntimeConfig, SandboxScope } from './configuration'
import { assertEnvWithinLimits, DEFAULT_PROVISION_TIMEOUT_MS } from './payload-limits'
import type { SandboxInstance, EgressPolicy } from '@tangle-network/sandbox'
import { type Outcome, ok, fail } from './outcome'
import { createHash } from 'node:crypto'
import { checksFor, isRecent, TRUSTED_REUSE_TTL_MS, recordCheck } from './runtime-cache'
import {
  readDeferredCorpusMarker,
  materializeDeferredFilesForExistingBox,
  deferredProfileWriteFailed,
} from './profile-corpus'
import { Sandbox } from '@tangle-network/sandbox/core'
import { type SandboxExistingBoxStage, SandboxEgressPolicyMismatchError } from './lifecycle-errors'
import type { Harness } from '../harness/index'
import { plannedHostRestart, readDuringPlannedHostRestart } from './transient-failure'

export async function resolveWorkspaceRuntimeEnv(
  shell: SandboxRuntimeConfig,
  scope: SandboxScope,
): Promise<Record<string, string>> {
  const env = await shell.runtimeEnv?.(scope) ?? {}
  assertEnvWithinLimits(env)
  return env
}

type EgressRead = Awaited<ReturnType<SandboxInstance['egress']['get']>>

/**
 * Round trips of a reused box that do not depend on its liveness, started with
 * the liveness probe so they overlap it. The egress read and the corpus marker
 * are only reads: the policy is still asserted (and migrated) in finalize, and
 * an unknown marker means the corpus is written as before. The runtime env is
 * sent early only when the egress assertion cannot change where credentials
 * may go (see {@link egressGatesCredentials}); otherwise it waits for it.
 * A read or push this isolate completed within {@link TRUSTED_REUSE_TTL_MS} on
 * the same box identity is not repeated, subject to the credential rule in
 * {@link prefetchExistingBoxReads}.
 */
interface ExistingBoxPrefetch {
  egress?: Promise<Outcome<EgressRead>>
  /** The box's egress was verified recently enough that this reuse reads and asserts nothing. */
  egressVerified?: boolean
  corpusMarker?: Promise<string | null>
  /** The renewal already sent to the box; finalize waits for it instead of sending another. */
  runtimeEnv?: Promise<Outcome<void>>
  /** The box already holds this runtime environment, so nothing is sent. */
  envDelivered?: boolean
  /** Settles when the minted environment has decided the fields above. */
  decided: Promise<void>
}

type ReuseMeasure = <T>(stage: string, operation: () => Promise<T>) => Promise<T>

function runtimeEnvDigest(env: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeJson(env)), 'utf8').digest('hex')
}

function hasDeliveredEnv(box: SandboxInstance, env: Record<string, string>): boolean {
  const delivered = checksFor(box)?.env
  return isRecent(delivered?.at, TRUSTED_REUSE_TTL_MS) && delivered?.digest === runtimeEnvDigest(env)
}

function hasRecentEgress(box: SandboxInstance, desired: EgressPolicy): boolean {
  const verified = checksFor(box)?.egress
  return isRecent(verified?.at, TRUSTED_REUSE_TTL_MS) && verified?.key === normalizedEgressPolicy(desired)
}

async function pushRuntimeEnv(
  box: SandboxInstance,
  env: Record<string, string>,
  measure?: ReuseMeasure,
  deadline?: number,
): Promise<Outcome<void>> {
  try {
    const push = () => box.setRuntimeEnv(env)
    const deliver = async () => {
      if (deadline === undefined) await push()
      else await readDuringPlannedHostRestart(push, deadline)
    }
    await (measure ? measure('runtime_env_push', deliver) : deliver())
    recordCheck(box, { env: { digest: runtimeEnvDigest(env), at: Date.now() } })
    return ok(undefined)
  } catch (cause) {
    return fail(cause)
  }
}

/**
 * Start the reads of a reused box. A recent egress read stands in for a new one
 * when the policy is `open` (a stale verdict can only cost the box its reach) or
 * when this reuse sends the box no credentials: the environment it would send is
 * already there and the shell has no bootstrap. A `strict` or `blocked` verdict
 * never stands in for the read that gates credentials, so a changed environment
 * or a bootstrap waits for a fresh read.
 */
export function prefetchExistingBoxReads(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  runtimeEnv: Promise<Record<string, string>>,
  measure: ReuseMeasure,
): ExistingBoxPrefetch {
  const desired = shell.egressPolicy
  const readEgress = () => measure('egress', async () => {
    try {
      return ok(await box.egress.get())
    } catch (cause) {
      return fail(cause)
    }
  })
  const egressRecent = desired !== undefined && hasRecentEgress(box, desired)
  const prefetch: ExistingBoxPrefetch = { decided: Promise.resolve() }
  if (desired && !egressRecent) prefetch.egress = readEgress()
  if (shell.deferProfileFiles && !isRecent(checksFor(box)?.corpus?.at, TRUSTED_REUSE_TTL_MS)) {
    prefetch.corpusMarker = readDeferredCorpusMarker(box)
  }
  // A mint failure rejects `runtimeEnv` and the reuse stops before finalize, so
  // nothing was sent; the renewal itself is settled here and never rejects.
  prefetch.decided = runtimeEnv.then((env) => {
    const delivered = Object.keys(env).length === 0 || hasDeliveredEnv(box, env)
    prefetch.envDelivered = delivered
    if (desired && egressRecent) {
      if (desired.mode === 'open' || (delivered && !shell.bootstrap)) prefetch.egressVerified = true
      else prefetch.egress = readEgress()
    }
    if (!delivered && !egressGatesCredentials(desired)) {
      prefetch.runtimeEnv = pushRuntimeEnv(box, env, measure)
    }
  }, () => undefined)
  return prefetch
}

/**
 * Whether the egress assertion must finish before credentials reach a reused
 * box. `open` is the most permissive mode, so no policy the box can hold lets
 * credentials go anywhere `open` would not; asserting it only restores the
 * box's reach (a migration from a narrower policy). `strict` and `blocked`
 * bound where credentials can be sent, so they are asserted first.
 */
function egressGatesCredentials(desired: EgressPolicy | undefined): boolean {
  return desired !== undefined && desired.mode !== 'open'
}

function recordVerifiedEgress(box: SandboxInstance, desired: EgressPolicy): void {
  recordCheck(box, { egress: { key: normalizedEgressPolicy(desired), at: Date.now() } })
}

// All retained-box paths renew credentials before the product bootstrap.
export async function finalizeExistingBox(
  shell: SandboxRuntimeConfig,
  client: Sandbox,
  box: SandboxInstance,
  stage: SandboxExistingBoxStage,
  name: string,
  workspaceId: string,
  userId: string | undefined,
  harness: Harness,
  scope: SandboxScope,
  runtimeEnv: Record<string, string>,
  prefetch: Omit<ExistingBoxPrefetch, 'decided'> = {},
): Promise<SandboxInstance> {
  const deadline = Date.now() + (shell.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS)
  if (!prefetch.egressVerified) {
    await assertExistingBoxEgress(box, shell.egressPolicy, shell.migrateEgressPolicy, stage, name, deadline, prefetch.egress)
  }
  const written = await materializeDeferredFilesForExistingBox(
    shell,
    client,
    box,
    stage,
    name,
    workspaceId,
    userId,
    harness,
    prefetch.corpusMarker,
  )
  if (!written.succeeded) {
    throw deferredProfileWriteFailed(stage, name, written.error)
  }
  const finalBox = written.value
  if (prefetch.runtimeEnv) {
    // Liveness may be cached or omitted. Await only the typed restart signal
    // within the existing budget, after the previous push has settled.
    let renewed = await prefetch.runtimeEnv
    if (!renewed.succeeded && plannedHostRestart(renewed.error)) {
      renewed = await pushRuntimeEnv(finalBox, runtimeEnv, undefined, deadline)
    }
    if (!renewed.succeeded) throw renewed.error
  } else if (!prefetch.envDelivered && Object.keys(runtimeEnv).length > 0) {
    const renewed = await pushRuntimeEnv(finalBox, runtimeEnv, undefined, deadline)
    if (!renewed.succeeded) throw renewed.error
  }
  await bootstrapBox(shell, finalBox, scope, harness, stage, name, false)
  return finalBox
}

/** Where a box records the bootstrap keys it ran: one empty file per key in the agent's home, so a record lasts as
 *  long as the box's filesystem and is gone when the home is wiped or the box is replaced. */
const BOOTSTRAP_MARKERS = '"$HOME/.agent-app/bootstrapped"'
/** A marker older than this no longer stands in for the bootstrap, which bounds how long files the bootstrap wrote and
 *  something later deleted can go unrepaired: a day, or the next release, whichever comes first. */
const BOOTSTRAP_MARKER_MAX_AGE_MINUTES = 24 * 60

/**
 * Run the product bootstrap unless this box ran it under the same key within a day: the build the product declares
 * ({@link SandboxRuntimeConfig.bootstrapDigest}), the harness, the egress policy and the scope. Reading the marker is
 * one exec; the bootstrap it stands for is several. A fresh box has none to read. The marker is written only after the
 * bootstrap succeeds, and a failed write costs the next reuse a bootstrap. With no declared build, every call runs it.
 */
export async function bootstrapBox(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  scope: SandboxScope,
  harness: Harness,
  stage: string,
  name: string,
  fresh: boolean,
): Promise<void> {
  const bootstrap = shell.bootstrap
  if (!bootstrap) return
  const key = await bootstrapKey(shell, scope, harness)
  if (key !== undefined && !fresh && await hasBootstrapMarker(box, key)) return
  const boot = await bootstrap.call(shell, box, scope)
  if (!boot.succeeded) {
    throw new Error(`bootstrap failed on ${stage} box ${name}`, { cause: boot.error })
  }
  if (key !== undefined) await writeBootstrapMarker(box, key)
}

async function bootstrapKey(shell: SandboxRuntimeConfig, scope: SandboxScope, harness: Harness): Promise<string | undefined> {
  if (!shell.bootstrapDigest) return undefined
  const build = await shell.bootstrapDigest(scope)
  if (!build) return undefined
  const egress = shell.egressPolicy ? normalizedEgressPolicy(shell.egressPolicy) : null
  return createHash('sha256')
    .update(JSON.stringify([build, harness, egress, scope.workspaceId, scope.userId ?? null]), 'utf8').digest('hex')
}

async function hasBootstrapMarker(box: SandboxInstance, key: string): Promise<boolean> {
  try {
    const fresh = `find ${BOOTSTRAP_MARKERS} -maxdepth 1 -name ${key} -mmin -${BOOTSTRAP_MARKER_MAX_AGE_MINUTES} 2>/dev/null`
    return (await box.exec(`test -n "$(${fresh})"`)).exitCode === 0
  } catch {
    return false
  }
}

/**
 * Remove this box's bootstrap markers, so its next start runs the bootstrap again. Call it when a turn fails on
 * something the bootstrap provides (a runtime it installs, a folder it creates): without it, the box would stay
 * broken until the next release or for up to a day. Best effort; returns whether the box confirmed the removal.
 */
export async function forgetBootstrap(box: SandboxInstance): Promise<boolean> {
  try {
    return (await box.exec(`rm -rf ${BOOTSTRAP_MARKERS}`)).exitCode === 0
  } catch {
    return false
  }
}

async function writeBootstrapMarker(box: SandboxInstance, key: string): Promise<void> {
  try {
    await box.exec(`mkdir -p ${BOOTSTRAP_MARKERS} && : > ${BOOTSTRAP_MARKERS}/${key}`)
  } catch {
    // The next reuse finds no marker and bootstraps again.
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  )
}

function normalizedEgressPolicy(policy: EgressPolicy): string {
  const normalized: Record<string, unknown> = { ...policy }
  if (policy.mode === 'strict') {
    // Entries arrive as bare domains or `{ domain, allowPrivateIps }` records;
    // canonicalize both shapes so an equivalent record and bare entry compare
    // equal while differing private-IP allowances still mismatch.
    normalized.allowDomains = [...new Set(
      (policy.allowDomains ?? [])
        .map((entry) => {
          if (typeof entry === 'string') {
            const domain = entry.trim().toLowerCase()
            return domain ? JSON.stringify({ domain, allowPrivateIps: [] }) : null
          }
          const domain = entry.domain.trim().toLowerCase()
          return domain
            ? JSON.stringify({ domain, allowPrivateIps: [...new Set(entry.allowPrivateIps)].sort() })
            : null
        })
        .filter((entry): entry is string => entry !== null),
    )].sort()
    normalized.includeImplicitDomains = policy.includeImplicitDomains !== false
  } else {
    // `allowDomains` and `includeImplicitDomains` are ignored in open and
    // blocked modes, and the platform keeps a box's old strict list attached
    // after a migration to open. Comparing them refused a box that already had
    // exactly the policy asked for, and every reuse of that box after.
    delete normalized.allowDomains
    delete normalized.includeImplicitDomains
  }
  return JSON.stringify(canonicalizeJson(normalized))
}

function existingBoxEgressError(
  operation: 'read' | 'migration',
  box: SandboxInstance,
  stage: SandboxExistingBoxStage,
  name: string,
  cause: unknown,
): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  const status = (error as { status?: unknown }).status
  const suffix = operation === 'migration' ? '/egress' : ''
  return Object.assign(
    new Error(`egress policy ${operation} failed on ${stage} box ${name}: ${error.message}`, {
      cause: error,
    }),
    {
      origin: 'sandbox-api',
      endpoint: `/v1/sandboxes/${encodeURIComponent(box.id)}${suffix}`,
      ...(typeof status === 'number' || typeof status === 'string' ? { status } : {}),
    },
  )
}

async function assertExistingBoxEgress(
  box: SandboxInstance,
  desired: EgressPolicy | undefined,
  migrate: boolean | undefined,
  stage: SandboxExistingBoxStage,
  name: string,
  deadline: number,
  prefetched?: Promise<Outcome<Awaited<ReturnType<SandboxInstance['egress']['get']>>>>,
): Promise<void> {
  if (!desired) return
  let current: Awaited<ReturnType<SandboxInstance['egress']['get']>>
  const read = prefetched ? await prefetched : undefined
  if (read?.succeeded) {
    current = read.value
  } else {
    if (read && !read.succeeded && !plannedHostRestart(read.error)) {
      throw existingBoxEgressError('read', box, stage, name, read.error)
    }
    // A cached or omitted probe may not have observed the host return.
    // Wait for the typed refusal to clear before asserting current policy.
    try {
      current = (await readDuringPlannedHostRestart(() => box.egress.get(), deadline)).value
    } catch (cause) {
      throw existingBoxEgressError('read', box, stage, name, cause)
    }
  }
  const matchingPolicy = normalizedEgressPolicy(current.policy) === normalizedEgressPolicy(desired)
  const explicitSource = current.source !== 'platform'
  if (matchingPolicy && explicitSource) {
    recordVerifiedEgress(box, desired)
    return
  }

  if (migrate) {
    try {
      await box.egress.update(desired)
      const migrated = await box.egress.get()
      const migratedPolicy = normalizedEgressPolicy(migrated.policy) === normalizedEgressPolicy(desired)
      if (migratedPolicy && migrated.source !== 'platform') {
        recordVerifiedEgress(box, desired)
        return
      }
      current = migrated
    } catch (cause) {
      throw existingBoxEgressError('migration', box, stage, name, cause)
    }
  }

  throw new SandboxEgressPolicyMismatchError(
    stage,
    name,
    current.policy,
    current.source,
    desired,
  )
}
