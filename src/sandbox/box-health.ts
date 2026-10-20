import type { SandboxInstance, ProvisionEvent } from '@tangle-network/sandbox'
import type { LivenessProbeConfig } from './configuration'
import { type Outcome, ok, fail } from './outcome'
import { isRecent, checksFor, TRUSTED_REUSE_TTL_MS, forgetBox, trustedBoxes, recordCheck } from './runtime-cache'
import { sandboxEdgeFailed, sandboxRuntimeUrl, refreshRuntimeConnection } from './runtime-connection'
import { SANDBOX_BACKING_CONTAINER_MISSING_CODE, isLegacySandboxBackingContainerMissingMessage } from './diagnostics'
import { Sandbox } from '@tangle-network/sandbox/core'
import { type SandboxExistingBoxStage, SandboxBoxBusyError, SandboxRecoveryFailedError } from './lifecycle-errors'

// The SDK owns the exec deadline. Await settlement before starting recovery;
// an application timeout race would leave the original request in flight.
async function isBoxAlive(
  box: SandboxInstance,
  probe: LivenessProbeConfig | undefined,
): Promise<Outcome<void>> {
  if (!probe) return ok(undefined)
  try {
    const alive = await box.exec('echo alive', { timeoutMs: probe.execTimeoutMs ?? 5000 })
    if (alive.exitCode !== 0 || alive.stdout.trim() !== 'alive') {
      return fail(new Error('alive check did not return a successful alive marker'))
    }
    return ok(undefined)
  } catch (cause) {
    return fail(new Error('alive check failed', { cause }))
  }
}

function hasRecentLivenessVerification(
  box: SandboxInstance,
  probe: LivenessProbeConfig,
  now = Date.now(),
): boolean {
  return isRecent(checksFor(box)?.alive, probe.cacheTtlMs ?? TRUSTED_REUSE_TTL_MS, now)
}

// Decide whether an existing (reused or resumed) box is safe to hand back.
// `refreshRuntimeConnection` has already polled for the runtime URL, so a box
// that still has none never became connectable and must not be silently
// reused — downstream exec/terminal traffic would fail against it. A failed
// edge is likewise unusable. Only when the connection is present do we spend
// an exec round-trip on the liveness probe. A box that fails this gate is
// RECOVERED (stop→resume, workspace intact) or fails loud — never deleted.
export async function isReusableBox(
  box: SandboxInstance,
  probe: LivenessProbeConfig | undefined,
): Promise<Outcome<void>> {
  if (sandboxEdgeFailed(box) || !sandboxRuntimeUrl(box)) {
    forgetBox(box.id)
    return fail(new Error(sandboxEdgeFailed(box) ? 'runtime edge readiness failed' : 'runtime URL is missing'))
  }
  if (!probe) return ok(undefined)
  if (hasRecentLivenessVerification(box, probe)) {
    trustedBoxes.add(box)
    return ok(undefined)
  }
  const alive = await isBoxAlive(box, probe)
  if (alive.succeeded) recordCheck(box, { alive: Date.now() })
  else forgetBox(box.id)
  return alive
}

// Resume a stopped box and wait for it to reach running.
function stoppedBoxResumeError(box: SandboxInstance, cause: unknown): unknown {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  const code = (error as { code?: unknown }).code
  if (code === SANDBOX_BACKING_CONTAINER_MISSING_CODE) return cause
  if (code !== undefined && code !== 'SERVER_ERROR') return cause
  if (!isLegacySandboxBackingContainerMissingMessage(error.message)) return cause

  const status = typeof cause === 'object' && cause !== null
    ? (cause as { status?: unknown }).status
    : undefined
  if (typeof status !== 'number' && typeof status !== 'string') return cause
  const wrapped = new Error(error.message, { cause: error })
  wrapped.name = error.name

  return Object.assign(wrapped, {
    status,
    origin: 'sandbox-api',
    endpoint: `/v1/sandboxes/${encodeURIComponent(box.id)}/resume`,
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
  })
}

export async function resumeStoppedBox(
  box: SandboxInstance,
  timeoutMs: number,
  runtimeEnv: Record<string, string>,
  onProgress?: (event: ProvisionEvent) => void,
): Promise<Outcome<SandboxInstance>> {
  // A resume is the lifecycle step callers label a turn by, and the waits
  // below report no progress for a stopped box, so report it here.
  const report = (status: ProvisionEvent['status'], message: string) => {
    try {
      onProgress?.({ step: 'container-start', status, message, timestamp: new Date().toISOString() })
    } catch {
      // A progress observer cannot interfere with the resume.
    }
  }
  try {
    forgetBox(box.id)
    report('started', 'Resuming the stopped sandbox')
    await resumeWithRequiredRuntimeEnv(box, timeoutMs, runtimeEnv)
    await box.waitFor('running', { timeoutMs, ...(onProgress ? { onProgress } : {}) })
    report('completed', 'The stopped sandbox is running again')
    return ok(box)
  } catch (cause) {
    report('error', 'The stopped sandbox could not be resumed')
    return fail(stoppedBoxResumeError(box, cause))
  }
}

// Sandbox resume takes `env` only for public keys whose values the platform
// withholds at rest, and uses them only to rebuild a removed runtime; any
// other key is refused (400 RESUME_ENV_KEY_NOT_ACCEPTED). A rebuild that lacks
// values names them (409 RESUME_ENV_REQUIRED, `missingEnvKeys`). So resume
// without env and supply exactly the named keys from the fresh runtime env.
// finalizeExistingBox then delivers every fresh value through setRuntimeEnv.
async function resumeWithRequiredRuntimeEnv(
  box: SandboxInstance,
  timeoutMs: number,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  try {
    await box.resume({ timeoutMs })
  } catch (cause) {
    const missingEnvKeys = resumeEnvRequiredKeys(cause)
    if (!missingEnvKeys?.length || missingEnvKeys.some((key) => runtimeEnv[key] === undefined)) throw cause
    await box.resume({
      timeoutMs: Math.max(1, deadline - Date.now()),
      env: Object.fromEntries(missingEnvKeys.map((key) => [key, runtimeEnv[key]!])),
    })
  }
}

// Matched by code so SDK versions without ResumeEnvRequiredError still load.
function resumeEnvRequiredKeys(cause: unknown): string[] | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const { code, missingEnvKeys } = cause as { code?: unknown; missingEnvKeys?: unknown }
  if (code !== 'RESUME_ENV_REQUIRED' || !Array.isArray(missingEnvKeys)) return undefined
  return missingEnvKeys.filter((key): key is string => typeof key === 'string')
}

// How many sessions a stop would end, from the runtime's own session list, or
// undefined when the runtime does not answer. Listing sessions spawns nothing,
// so a busy box answers it when it misses the exec probe. A session counts as
// running on the same evidence the SDK uses to refuse a second dispatch:
// running, an active execution, or queued with an admitted execution. The SDK
// owns the request deadline; settlement is awaited so no stop is issued while
// the answer is still in flight.
async function runningSessionCount(box: SandboxInstance): Promise<number | undefined> {
  try {
    const sessions = await box.sessions()
    return sessions.filter(({ info }) =>
      info.status === 'running' ||
      Boolean(info.activeExecutionId) ||
      (info.status === 'queued' && Boolean(info.latestExecutionId)),
    ).length
  } catch {
    return undefined
  }
}

// State-preserving recovery for a box that failed the reuse gate: stop (keeps
// the workspace — the platform's suspend path never scrubs storage), resume,
// then re-probe. `box.delete()` is DEPROVISIONING — it wipes the persistent
// workspace (sessions, uncommitted files, everything outside the product's own
// DB) — so it must never be a recovery action (#299: a single slow exec or a
// crashed harness process used to destroy a user's workspace). This restarts
// the container, which also reboots a dead sidecar/harness process. Every
// failure throws SandboxRecoveryFailedError with the workspace intact —
// including on the `tangle` driver, where stop is unsupported and the throw
// carries the platform's rejection as its cause.
//
// The stop also ends every session on the box, so it is only issued when the
// runtime reports no running session. A box that misses the probe while busy
// (a loaded 2-core box can miss it while healthy, #934) is returned as is when
// it is connectable, and otherwise fails only this request with
// SandboxBoxBusyError. A runtime that cannot list its sessions gives no such
// evidence, and the box is restarted as before.
export async function recoverUnresponsiveBox(
  client: Sandbox,
  box: SandboxInstance,
  probe: LivenessProbeConfig | undefined,
  stage: SandboxExistingBoxStage,
  name: string,
  resumeTimeout: number,
  runtimeEnv: Record<string, string>,
  onProgress?: (event: ProvisionEvent) => void,
): Promise<SandboxInstance> {
  const running = await runningSessionCount(box)
  if (running) {
    if (sandboxRuntimeUrl(box) && !sandboxEdgeFailed(box)) return box
    throw new SandboxBoxBusyError(
      stage,
      name,
      running,
      sandboxEdgeFailed(box) ? 'runtime edge readiness failed' : 'runtime URL is missing',
    )
  }
  try {
    await box.stop()
  } catch (err) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      'stop',
      'the platform could not stop the box for a state-preserving restart',
      err,
    )
  }
  const resumed = await resumeStoppedBox(box, resumeTimeout, runtimeEnv, onProgress)
  if (!resumed.succeeded) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      'resume',
      'the box did not reach running after a state-preserving restart',
      resumed.error,
    )
  }
  const recovered = await refreshRuntimeConnection(client, resumed.value)
  const reusable = await isReusableBox(recovered, probe)
  if (!reusable.succeeded) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      'probe',
      `the box is still unresponsive after a state-preserving restart: ${reusable.error.message}`,
      reusable.error,
    )
  }
  return recovered
}
