import type { TurnDriveResult } from '@tangle-network/sandbox'
import type { Outcome } from '../sandbox/outcome'
import {
  SANDBOX_TRANSIENT_DEADLINE_MS,
  SandboxTransientDeadlineError,
  classifySandboxTransientFailure,
  sandboxTransientBackoffMs,
  type SandboxTransientFailure,
} from '../sandbox/transient-failure'

/** The stable identity a Workflow reuses on every retry of one turn. */
export interface DetachedTurnWorkflowIdentity {
  /** Sandbox session resume key. */
  sessionId: string
  /** Sandbox completed-turn idempotency key. */
  turnId: string
}

/** The part of Cloudflare's Workflow event needed by the tick. */
export interface CloudflareWorkflowEventLike<TPayload> {
  payload: TPayload
}

/** A duration accepted by Cloudflare Workflow `step.sleep`. */
export type CloudflareWorkflowSleepDuration =
  | `${number} ${
      | 'second'
      | 'seconds'
      | 'minute'
      | 'minutes'
      | 'hour'
      | 'hours'
      | 'day'
      | 'days'
      | 'week'
      | 'weeks'
      | 'month'
      | 'months'
      | 'year'
      | 'years'}`
  | number

/** The durable Workflow operations used by the tick. */
export interface CloudflareWorkflowStepLike {
  do<T>(name: string, callback: (context: unknown) => Promise<T>): Promise<T>
  sleep(name: string, duration: CloudflareWorkflowSleepDuration): Promise<void>
}

/** The states returned by the Sandbox `driveTurn` primitive. */
export type DetachedTurnDriveState = TurnDriveResult['state']

/** The small state contract a durable tick needs. Product observers may carry
 * a richer terminal receipt than Sandbox's `TurnDriveResult`. */
export interface DetachedTurnDriveResultLike {
  state: DetachedTurnDriveState
}

/** The terminal result passed to product settlement. */
export type DetachedTurnTerminalResult<
  TResult extends DetachedTurnDriveResultLike = TurnDriveResult,
> = Exclude<TResult, { state: 'running' }>

/** A drive call's retryable transport boundary. */
export type DetachedTurnDriveOutcome<
  TResult extends DetachedTurnDriveResultLike = TurnDriveResult,
> = Outcome<TResult>

/** Options for one durable detached-turn Workflow run. */
export interface DetachedTurnWorkflowTickOptions<
  TPayload extends DetachedTurnWorkflowIdentity,
  TSettled,
  TResult extends DetachedTurnDriveResultLike = TurnDriveResult,
> {
  event: CloudflareWorkflowEventLike<TPayload>
  step: CloudflareWorkflowStepLike
  /** One SDK drive pass. Rejected results must not enter the Workflow cache. */
  drive: (payload: TPayload) => Promise<DetachedTurnDriveOutcome<TResult>>
  /** Must be idempotent: the Worker can stop after the write but before commit. */
  settle: (payload: TPayload, result: DetachedTurnTerminalResult<TResult>) => Promise<TSettled>
  /** Wait between passes: one duration, or one per zero-based pass so a long
   *  turn polls less often. It must depend only on the pass number, so a
   *  replayed Workflow takes the same steps. Default: 5 seconds. */
  pollDelay?: CloudflareWorkflowSleepDuration | ((attempt: number) => CloudflareWorkflowSleepDuration)
  stepName?: string
  /**
   * Wait out transient Sandbox failures instead of failing the pass. A drive
   * failure the policy classifies is checkpointed as a running pass, the next
   * pass waits the policy's backoff, and the tick throws
   * {@link SandboxTransientDeadlineError} once one transient stretch outlasts
   * the deadline. Unclassified failures throw from the step as before.
   * Default: the shared Sandbox transient policy.
   */
  transient?: DetachedTurnTransientPolicy | false
}

/** Which drive failures a tick waits out, and for how long. */
export interface DetachedTurnTransientPolicy {
  classify(error: unknown): SandboxTransientFailure | null
  deadlineMs: number
  /** Wait before pass `attempt` (1-based) of one transient stretch. */
  backoffMs(attempt: number): number
}

/** The shared Sandbox transient policy: 5 s doubling to 60 s, for at most 15 minutes. */
export const SANDBOX_TRANSIENT_TICK_POLICY: DetachedTurnTransientPolicy = {
  classify: classifySandboxTransientFailure,
  deadlineMs: SANDBOX_TRANSIENT_DEADLINE_MS,
  backoffMs: sandboxTransientBackoffMs,
}

/** A pass that met a transient failure, as the step checkpoints it. */
interface TransientPass {
  state: 'running'
  transient: SandboxTransientFailure & { at: number }
}

function transientPass(value: unknown): TransientPass['transient'] | undefined {
  const transient = (value as Partial<TransientPass> | null)?.transient
  return transient && typeof transient.at === 'number' && typeof transient.code === 'string' ? transient : undefined
}

function assertIdentity(payload: DetachedTurnWorkflowIdentity): void {
  if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
    throw new Error('detached turn Workflow payload requires a non-empty sessionId')
  }
  if (typeof payload.turnId !== 'string' || !payload.turnId.trim()) {
    throw new Error('detached turn Workflow payload requires a non-empty turnId')
  }
}

// Keyed by the SDK's own union, so a state a new Sandbox adds fails this
// package's build instead of retrying a settled turn as "unknown" forever.
const DRIVE_STATES: Record<DetachedTurnDriveState, true> = {
  running: true,
  completed: true,
  failed: true,
  awaiting_plan_decision: true,
  blocked_on_approval: true,
  awaiting_question: true,
  awaiting_interaction: true,
}

function isKnownDriveState(state: unknown): state is DetachedTurnDriveState {
  return typeof state === 'string' && Object.hasOwn(DRIVE_STATES, state)
}

function checkedDriveResult<TResult extends DetachedTurnDriveResultLike>(value: TResult): TResult {
  const state = (value as { state?: unknown } | null)?.state
  if (!isKnownDriveState(state)) {
    throw new Error(`detached turn drive returned unknown state: ${String(state)}`)
  }
  return value
}

/**
 * Drive a detached SDK turn with durable steps, not an HTTP waitUntil lifetime.
 * Stable step names let an evicted Workflow resume without repeating committed
 * passes. Validation belongs inside step.do so a transient malformed response
 * is retried rather than committed permanently as a poisoned checkpoint.
 */
export async function runDetachedTurnWorkflowTick<
  TPayload extends DetachedTurnWorkflowIdentity,
  TSettled,
  TResult extends DetachedTurnDriveResultLike = TurnDriveResult,
>(
  options: DetachedTurnWorkflowTickOptions<TPayload, TSettled, TResult>,
): Promise<TSettled> {
  assertIdentity(options.event?.payload)
  // Never allow a callback to change the admission identity for later passes.
  const payload = Object.freeze({ ...options.event.payload }) as TPayload
  const name = options.stepName ?? 'detached-turn'
  const pollDelay = options.pollDelay ?? '5 seconds'
  const delayFor = (attempt: number): CloudflareWorkflowSleepDuration =>
    typeof pollDelay === 'function' ? pollDelay(attempt) : pollDelay
  const transient = options.transient === false ? undefined : options.transient ?? SANDBOX_TRANSIENT_TICK_POLICY
  let attempt = 0
  // One stretch of consecutive transient passes. Both come from checkpointed
  // step results, so a replayed Workflow takes the same waits.
  let transientSince: number | undefined
  let transientAttempts = 0
  let terminalResult: DetachedTurnTerminalResult<TResult>
  while (true) {
    const driveResult = checkedDriveResult(await options.step.do<TResult>(`${name}:drive:${attempt}`, async () => {
      let outcome: DetachedTurnDriveOutcome<TResult>
      try {
        outcome = await options.drive(payload)
      } catch (error) {
        outcome = { succeeded: false, error: error instanceof Error ? error : new Error(String(error)) }
      }
      if (!outcome.succeeded) {
        const failure = transient?.classify(outcome.error)
        if (!failure) throw outcome.error
        return { state: 'running', transient: { ...failure, at: Date.now() } } satisfies TransientPass as unknown as TResult
      }
      return checkedDriveResult(outcome.value)
    }))
    // Validate replayed values as well, including checkpoints from older code.
    if (driveResult.state !== 'running') {
      terminalResult = driveResult as DetachedTurnTerminalResult<TResult>
      break
    }
    const pass = transient ? transientPass(driveResult) : undefined
    if (pass && transient) {
      transientSince ??= pass.at
      transientAttempts += 1
      const delayMs = transient.backoffMs(transientAttempts)
      if (pass.at + delayMs - transientSince > transient.deadlineMs) {
        throw new SandboxTransientDeadlineError(pass, transientSince, transientAttempts)
      }
      await options.step.sleep(`${name}:wait:${attempt}`, delayMs)
    } else {
      transientSince = undefined
      transientAttempts = 0
      await options.step.sleep(`${name}:wait:${attempt}`, delayFor(attempt))
    }
    attempt += 1
  }
  return options.step.do(`${name}:settle`, () => options.settle(payload, terminalResult))
}
