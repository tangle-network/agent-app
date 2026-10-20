import type { SandboxInstance, EgressPolicy } from '@tangle-network/sandbox'

export type SandboxExistingBoxStage = 'reused' | 'resumed'

export type SandboxEgressPolicySource = Awaited<
  ReturnType<SandboxInstance['egress']['get']>
>['source']

/**
 * Thrown when an existing sandbox cannot be proven to have the requested
 * outbound network policy. The sandbox is preserved and its policy is not
 * changed. The caller explicitly decides whether to preserve, migrate, or
 * replace the sandbox.
 */
export class SandboxEgressPolicyMismatchError extends Error {
  readonly stage: SandboxExistingBoxStage
  readonly boxName: string
  readonly currentPolicy: EgressPolicy
  readonly currentSource: SandboxEgressPolicySource
  readonly desiredPolicy: EgressPolicy

  constructor(
    stage: SandboxExistingBoxStage,
    boxName: string,
    currentPolicy: EgressPolicy,
    currentSource: SandboxEgressPolicySource,
    desiredPolicy: EgressPolicy,
  ) {
    super(
      `egress policy mismatch on ${stage} box ${boxName}: ` +
        `current ${currentPolicy.mode} policy from ${currentSource} does not explicitly match ` +
        `desired ${desiredPolicy.mode} policy; the existing box was preserved and egress was not updated.`,
    )
    this.name = 'SandboxEgressPolicyMismatchError'
    this.stage = stage
    this.boxName = boxName
    this.currentPolicy = currentPolicy
    this.currentSource = currentSource
    this.desiredPolicy = desiredPolicy
  }
}

/** Represent an error thrown when sandbox runtime authentication refresh fails for a specific stage and name */
export class SandboxRuntimeAuthRefreshError extends Error {
  constructor(stage: SandboxExistingBoxStage, name: string, detail: string, cause?: unknown) {
    super(`${stage} sandbox auth refresh failed for ${name}: ${detail}`, { cause })
    this.name = 'SandboxRuntimeAuthRefreshError'
  }
}

/** Which step of the state-preserving stop→resume recovery failed. `stop` with a
 *  driver-unsupported cause means the platform cannot restart this box (the
 *  `tangle` driver exposes create/delete only); `probe` means the box restarted
 *  but is still unresponsive. */
export type SandboxRecoveryPhase = 'stop' | 'resume' | 'probe'

/**
 * Thrown when an unresponsive box could not be recovered by a state-preserving
 * restart. Contract: this error is only ever thrown with the workspace intact —
 * recovery never deletes. The caller decides what to do next (retry, surface to
 * the user, or explicitly replace via `forceNew`).
 */
export class SandboxRecoveryFailedError extends Error {
  readonly boxKey: string
  readonly stage: SandboxExistingBoxStage
  readonly phase: SandboxRecoveryPhase
  constructor(
    stage: SandboxExistingBoxStage,
    boxKey: string,
    phase: SandboxRecoveryPhase,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `${stage} sandbox ${boxKey} failed liveness recovery at ${phase}: ${detail}. ` +
        `The workspace is preserved; pass forceNew to replace the box.`,
      { cause },
    )
    this.name = 'SandboxRecoveryFailedError'
    this.boxKey = boxKey
    this.stage = stage
    this.phase = phase
  }
}

/**
 * Thrown instead of restarting a box that failed the reuse gate because it is
 * not connectable (runtime URL missing or edge readiness failed) while its
 * runtime reports running sessions. A restart would end those sessions, so the
 * box is left running and only the request that asked for it fails. The box is
 * not replaced either; retry once its sessions finish.
 */
export class SandboxBoxBusyError extends Error {
  readonly boxKey: string
  readonly stage: SandboxExistingBoxStage
  readonly runningSessions: number
  constructor(stage: SandboxExistingBoxStage, boxKey: string, runningSessions: number, detail: string) {
    super(
      `${stage} sandbox ${boxKey} is not connectable (${detail}) but is serving ${runningSessions} running ` +
        `session${runningSessions === 1 ? '' : 's'}, so it was not restarted. Retry when they finish.`,
    )
    this.name = 'SandboxBoxBusyError'
    this.boxKey = boxKey
    this.stage = stage
    this.runningSessions = runningSessions
  }
}
