/**
 * Serialize request-time sandbox provisioning across Worker isolates.
 *
 * Background prewarming can lose a race without delaying a request. A real
 * user turn cannot: its losing request must wait for the owner, adopt the box
 * that became ready, or report why the owner did not leave a usable box.
 */

import type { Harness } from '../harness/index'
import type { PeekWorkspaceSandboxOutcome } from './index'
import {
  sandboxPrewarmClaimKey,
  type FencedPrewarmClaimStore,
  type PrewarmClaimLease,
} from './prewarm'

export const DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS = 180
export const DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS = 5_000

export type ReadyRunningSandboxOutcome = Extract<
  PeekWorkspaceSandboxOutcome,
  { status: 'running' }
> & {
  box: Extract<PeekWorkspaceSandboxOutcome, { status: 'running' }>['box'] & {
    filesystemIncarnationReadiness: 'ready'
  }
}

export class SandboxProvisioningFailedElsewhereError extends Error {
  readonly code = 'sandbox.provisioning_failed_elsewhere'

  constructor(
    readonly workspaceId: string,
    readonly state: string,
  ) {
    super(
      `Sandbox provisioning for workspace ${workspaceId} failed in another request ` +
        `(state=${state})`,
    )
    this.name = 'SandboxProvisioningFailedElsewhereError'
  }
}

export class SandboxFilesystemNotReadyError extends Error {
  readonly code = 'sandbox.filesystem_not_ready'
  readonly retryable = true

  constructor(
    readonly workspaceId: string,
    readonly readiness: 'transitioning' | 'missing',
  ) {
    super(`Sandbox filesystem for workspace ${workspaceId} is ${readiness}`)
    this.name = 'SandboxFilesystemNotReadyError'
  }
}

export type ForegroundSandboxSingleFlightEvent =
  | { type: 'waiting'; key: string; workspaceId: string }
  | { type: 'release-failed'; key: string; workspaceId: string; error: string }

export interface ForegroundSandboxSingleFlightOptions<T> {
  claim: FencedPrewarmClaimStore
  workspaceId: string
  harness: Harness
  provision(): Promise<T>
  peek(): Promise<PeekWorkspaceSandboxOutcome>
  adopt(box: ReadyRunningSandboxOutcome): T | Promise<T>
  onEvent?(event: ForegroundSandboxSingleFlightEvent): void
  wait?(ms: number): Promise<void>
  claimTtlSeconds?: number
  pollIntervalMs?: number
}

function failedState(peek: PeekWorkspaceSandboxOutcome): string {
  return peek.status === 'not-running' ? peek.state : 'absent'
}

function isReadyRunningSandbox(
  peek: PeekWorkspaceSandboxOutcome,
): peek is ReadyRunningSandboxOutcome {
  return (
    peek.status === 'running' &&
    peek.box.filesystemIncarnationReadiness === 'ready'
  )
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
  return value
}

function safeErrorText(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message
      if (typeof message === 'string' && message) return message
    }
  } catch {
    // Error values can be proxies or custom subclasses with hostile getters.
  }

  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const message = Reflect.get(error, 'message')
      if (typeof message === 'string' && message) return message
    }
  } catch {
    // A hostile proxy must not replace the successful provision result.
  }

  try {
    const text = typeof error === 'string' ? error : String(error)
    return text || 'unknown error'
  } catch {
    return 'unknown error'
  }
}

/**
 * Run one foreground provision or adopt the ready result from its current
 * owner. An expired retained claim permits takeover. A released claim without
 * a usable box reports the prior attempt instead of starting a retry storm.
 */
export async function runForegroundSandboxSingleFlight<T>(
  options: ForegroundSandboxSingleFlightOptions<T>,
): Promise<T> {
  const key = sandboxPrewarmClaimKey(options)
  const ttlSeconds = positiveNumber(
    options.claimTtlSeconds ?? DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS,
    'claimTtlSeconds',
  )
  const pollIntervalMs = positiveNumber(
    options.pollIntervalMs ?? DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS,
    'pollIntervalMs',
  )
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const emit = (event: ForegroundSandboxSingleFlightEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Observability cannot decide whether provisioning succeeds.
    }
  }

  const provisionAsOwner = async (lease: PrewarmClaimLease): Promise<T> => {
    try {
      return await options.provision()
    } finally {
      try {
        await options.claim.releaseLease(lease)
      } catch (error) {
        emit({
          type: 'release-failed',
          key,
          workspaceId: options.workspaceId,
          error: safeErrorText(error),
        })
      }
    }
  }

  const initialLease = await options.claim.acquireLease(key, ttlSeconds)
  if (initialLease) return provisionAsOwner(initialLease)

  emit({ type: 'waiting', key, workspaceId: options.workspaceId })
  while (true) {
    await wait(pollIntervalMs)
    const [peek, claim] = await Promise.all([
      options.peek(),
      options.claim.inspect(key),
    ])

    if (claim.status === 'held') continue
    if (peek.status === 'warming') {
      throw new SandboxFilesystemNotReadyError(options.workspaceId, 'transitioning')
    }
    if (isReadyRunningSandbox(peek)) return options.adopt(peek)
    if (peek.status === 'running') {
      throw new SandboxFilesystemNotReadyError(
        options.workspaceId,
        peek.box.filesystemIncarnationReadiness === 'transitioning'
          ? 'transitioning'
          : 'missing',
      )
    }

    if (claim.status === 'absent') {
      throw new SandboxProvisioningFailedElsewhereError(
        options.workspaceId,
        failedState(peek),
      )
    }
    const takeoverLease = await options.claim.acquireLease(key, ttlSeconds)
    if (takeoverLease) return provisionAsOwner(takeoverLease)
  }
}
