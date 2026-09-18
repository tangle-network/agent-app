import type { TurnDriveResult } from '@tangle-network/sandbox'
import type { Outcome } from '../sandbox/outcome'

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

/** The terminal result passed to product settlement. */
export type DetachedTurnTerminalResult = Exclude<TurnDriveResult, { state: 'running' }>

/** A drive call's retryable transport boundary. */
export type DetachedTurnDriveOutcome = Outcome<TurnDriveResult>

/** Options for one durable detached-turn Workflow run. */
export interface DetachedTurnWorkflowTickOptions<
  TPayload extends DetachedTurnWorkflowIdentity,
  TSettled,
> {
  event: CloudflareWorkflowEventLike<TPayload>
  step: CloudflareWorkflowStepLike
  /** One SDK drive pass. Rejected results must not enter the Workflow cache. */
  drive: (payload: TPayload) => Promise<DetachedTurnDriveOutcome>
  /** Must be idempotent: the Worker can stop after the write but before commit. */
  settle: (payload: TPayload, result: DetachedTurnTerminalResult) => Promise<TSettled>
  pollDelay?: CloudflareWorkflowSleepDuration
  stepName?: string
}

function assertIdentity(payload: DetachedTurnWorkflowIdentity): void {
  if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
    throw new Error('detached turn Workflow payload requires a non-empty sessionId')
  }
  if (typeof payload.turnId !== 'string' || !payload.turnId.trim()) {
    throw new Error('detached turn Workflow payload requires a non-empty turnId')
  }
}

function isKnownDriveState(state: unknown): state is DetachedTurnDriveState {
  return state === 'running'
    || state === 'completed'
    || state === 'failed'
    || state === 'awaiting_plan_decision'
}

function checkedDriveResult(value: TurnDriveResult): TurnDriveResult {
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
>(
  options: DetachedTurnWorkflowTickOptions<TPayload, TSettled>,
): Promise<TSettled> {
  assertIdentity(options.event?.payload)
  // Never allow a callback to change the admission identity for later passes.
  const payload = Object.freeze({ ...options.event.payload }) as TPayload
  const name = options.stepName ?? 'detached-turn'
  const delay = options.pollDelay ?? '5 seconds'
  let attempt = 0
  let terminalResult: DetachedTurnTerminalResult
  while (true) {
    const driveResult = checkedDriveResult(await options.step.do(`${name}:drive:${attempt}`, async () => {
      const outcome = await options.drive(payload)
      if (!outcome.succeeded) throw outcome.error
      return checkedDriveResult(outcome.value)
    }))
    // Validate replayed values as well, including checkpoints from older code.
    if (driveResult.state !== 'running') {
      terminalResult = driveResult as DetachedTurnTerminalResult
      break
    }
    await options.step.sleep(`${name}:wait:${attempt}`, delay)
    attempt += 1
  }
  return options.step.do(`${name}:settle`, () => options.settle(payload, terminalResult))
}
