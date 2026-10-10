/**
 * Sandbox failures that clear on their own, and how long to wait them out.
 *
 * Both callers that meet them use this one policy: the run dispatch, which
 * resends the same execution, and the completion Workflow, which observes it.
 * A box restarting under load answers "filesystem incarnation is not ready"
 * for minutes (8 minutes for GTM's busiest box on 2026-10-10, 10:37 to 10:45
 * UTC), and its gateway refuses dispatches with 502 or 503 while it does.
 * Failing on the first such answer lost those turns; retrying forever would
 * hold a lock on a box that never comes back. The policy backs off from 5 s
 * to a 60 s ceiling and gives up after 15 minutes.
 */
import { isSandboxApiTransientFailure, serializeSandboxProvisioningError } from './diagnostics'

export type SandboxTransientFailureCode =
  /** The box is running but its filesystem incarnation is not ready yet. */
  | 'sandbox.filesystem_not_ready'
  /** The sandbox gateway answered the run dispatch with 502, 503 or 504. */
  | 'sandbox.dispatch_refused'
  /** A Sandbox API control-plane call failed with a server error. */
  | 'sandbox.control_plane_transient'

export interface SandboxTransientFailure {
  code: SandboxTransientFailureCode
  message: string
}

/** How long a transient failure may last before the caller fails. */
export const SANDBOX_TRANSIENT_DEADLINE_MS = 15 * 60_000

/** Wait before retry `attempt` (1-based): 5 s doubling to a 60 s ceiling. */
export function sandboxTransientBackoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function causeChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = []
  let current = record(error)
  for (let depth = 0; current && depth < 8 && !chain.includes(current); depth += 1) {
    chain.push(current)
    current = record(current.cause)
  }
  return chain
}

function status(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value)
  return undefined
}

const FILESYSTEM_NOT_READY = /filesystem incarnation is not ready/i
const RUN_DISPATCH_ENDPOINT = /\/runtime\/agents\/run\/stream(?:[?#]|$)/

/** The typed transient failure `error` carries anywhere in its cause chain, or null. */
export function classifySandboxTransientFailure(error: unknown): SandboxTransientFailure | null {
  for (const cause of causeChain(error)) {
    const message = typeof cause.message === 'string' ? cause.message : ''
    if (cause.code === 'FILESYSTEM_INCARNATION_NOT_READY' || FILESYSTEM_NOT_READY.test(message)) {
      return { code: 'sandbox.filesystem_not_ready', message: 'Sandbox filesystem incarnation is not ready' }
    }
    const code = status(cause.status)
    const endpoint = typeof cause.endpoint === 'string' ? cause.endpoint : ''
    if ((code === 502 || code === 503 || code === 504) && RUN_DISPATCH_ENDPOINT.test(endpoint)) {
      return { code: 'sandbox.dispatch_refused', message: `The sandbox gateway refused the run dispatch with ${code}` }
    }
  }
  if (isSandboxApiTransientFailure(serializeSandboxProvisioningError(error))) {
    return { code: 'sandbox.control_plane_transient', message: 'A Sandbox API call failed with a server error' }
  }
  return null
}

/** The error a caller raises when a transient failure outlasted the deadline. */
export class SandboxTransientDeadlineError extends Error {
  readonly code: SandboxTransientFailureCode
  readonly firstSeenAt: number
  readonly attempts: number

  constructor(failure: SandboxTransientFailure, firstSeenAt: number, attempts: number, cause?: unknown) {
    const minutes = Math.round(SANDBOX_TRANSIENT_DEADLINE_MS / 60_000)
    super(`${failure.message}; it persisted for more than ${minutes} minutes over ${attempts} attempts`, cause === undefined ? undefined : { cause })
    this.name = 'SandboxTransientDeadlineError'
    this.code = failure.code
    this.firstSeenAt = firstSeenAt
    this.attempts = attempts
  }
}

export interface SandboxTransientRetryOptions {
  /** Defaults to {@link SANDBOX_TRANSIENT_DEADLINE_MS}. */
  deadlineMs?: number
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  onRetry?: (failure: SandboxTransientFailure, attempt: number, delayMs: number) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(signal.reason)
  }, { once: true })
})

/**
 * Run `attempt` until it succeeds, it fails with something this policy does
 * not consider transient, or a transient failure outlasts the deadline.
 */
export async function retrySandboxTransient<T>(
  attempt: () => Promise<T>,
  options: SandboxTransientRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadlineMs = options.deadlineMs ?? SANDBOX_TRANSIENT_DEADLINE_MS
  let firstSeenAt: number | undefined
  for (let attempts = 1; ; attempts += 1) {
    try {
      return await attempt()
    } catch (error) {
      const failure = classifySandboxTransientFailure(error)
      if (!failure) throw error
      const at = now()
      firstSeenAt ??= at
      const delayMs = sandboxTransientBackoffMs(attempts)
      if (at + delayMs - firstSeenAt > deadlineMs) throw new SandboxTransientDeadlineError(failure, firstSeenAt, attempts, error)
      options.onRetry?.(failure, attempts, delayMs)
      await sleep(delayMs, options.signal)
    }
  }
}
