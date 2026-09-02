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

/** Stable identity shared by a Workflow and one Sandbox session turn. */
export interface WorkflowTurnIdentity {
  sessionId: string
  turnId: string
}

/** Options for a generic admit, poll, and settle Workflow turn. */
export interface WorkflowTurnTickOptions<
  TPayload extends WorkflowTurnIdentity,
  TAdmission,
  TStatus,
  TSettled,
> {
  /** Keep the payload to stable ids; rebuild Sandbox clients inside callbacks. */
  event: CloudflareWorkflowEventLike<TPayload>
  step: CloudflareWorkflowStepLike
  /** Admit the turn once. The operation must be idempotent for the turn id. */
  admit: (payload: TPayload) => Promise<Outcome<TAdmission>>
  /** Read the authoritative status after admission. */
  poll: (payload: TPayload, admission: TAdmission) => Promise<Outcome<TStatus>>
  /** Identify whether another durable poll is required. */
  isRunning: (status: TStatus) => boolean
  /** Persist the terminal result. This callback must be idempotent. */
  settle: (payload: TPayload, status: TStatus) => Promise<TSettled>
  pollDelay?: CloudflareWorkflowSleepDuration
  stepName?: string
}

/** The states returned by the Sandbox `driveTurn` primitive. */
export type DetachedTurnDriveState = TurnDriveResult['state']

/** The terminal result passed to product settlement. */
export type DetachedTurnTerminalResult = Exclude<TurnDriveResult, { state: 'running' }>

/** A drive call's retryable transport boundary. */
export type DetachedTurnDriveOutcome = Outcome<TurnDriveResult>

function assertWorkflowTurnIdentity(payload: WorkflowTurnIdentity): void {
  if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
    throw new Error('Workflow turn payload requires a non-empty sessionId')
  }
  if (typeof payload.turnId !== 'string' || !payload.turnId.trim()) {
    throw new Error('Workflow turn payload requires a non-empty turnId')
  }
}

/**
 * Own one Sandbox turn from a durable Workflow without holding a stream open.
 *
 * Admission is a durable step, so a Workflow replay does not submit it twice.
 * Poll and settlement use only product-supplied authoritative Sandbox reads.
 */
export async function runWorkflowTurnTick<
  TPayload extends WorkflowTurnIdentity,
  TAdmission,
  TStatus,
  TSettled,
>(options: WorkflowTurnTickOptions<TPayload, TAdmission, TStatus, TSettled>): Promise<TSettled> {
  const payload = options.event?.payload
  assertWorkflowTurnIdentity(payload)
  const name = options.stepName ?? 'workflow-turn'
  const delay = options.pollDelay ?? '5 seconds'
  const admission = await options.step.do(`${name}:admit`, async () => {
    const outcome = await options.admit(payload)
    if (!outcome.succeeded) throw outcome.error
    return outcome.value
  })

  let attempt = 0
  let terminal: TStatus
  while (true) {
    const status = await options.step.do(`${name}:poll:${attempt}`, async () => {
      const outcome = await options.poll(payload, admission)
      if (!outcome.succeeded) throw outcome.error
      return outcome.value
    })
    if (!options.isRunning(status)) {
      terminal = status
      break
    }
    await options.step.sleep(`${name}:wait:${attempt}`, delay)
    attempt += 1
  }

  return options.step.do(`${name}:settle`, () => options.settle(payload, terminal))
}

/** Options for one durable detached-turn Workflow run. */
export interface DetachedTurnWorkflowTickOptions<
  TPayload extends DetachedTurnWorkflowIdentity,
  TSettled,
> {
  /** The Workflow event. Its payload must keep the same session and turn ids. */
  event: CloudflareWorkflowEventLike<TPayload>
  /** Cloudflare's durable step runner. */
  step: CloudflareWorkflowStepLike
  /**
   * Run exactly one `driveSandboxTurn`/`box.driveTurn` pass.
   *
   * The callback runs inside one `step.do`. A transport failure is thrown from
   * that step so Cloudflare retries the pass with the same deterministic ids.
   */
  drive: (
    payload: TPayload,
  ) => Promise<DetachedTurnDriveOutcome>
  /**
   * Read the completed Sandbox cache/session records and persist the product's
   * deterministic assistant row. This callback MUST be idempotent because a
   * Worker can stop after the write and before the Workflow step commits.
   */
  settle: (payload: TPayload, result: DetachedTurnTerminalResult) => Promise<TSettled>
  /** Delay between one-tick drive passes. */
  pollDelay?: CloudflareWorkflowSleepDuration
  /** Stable prefix for the Workflow's drive and wait step names. */
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

/**
 * Drive one detached Sandbox turn from a Cloudflare Workflow.
 *
 * Each drive step makes one prompt admission/status pass and returns promptly.
 * A running pass sleeps durably before the next pass. The final settlement is
 * also a step, so replayed Workflow execution never holds a live stream open.
 */
export async function runDetachedTurnWorkflowTick<
  TPayload extends DetachedTurnWorkflowIdentity,
  TSettled,
>(
  options: DetachedTurnWorkflowTickOptions<TPayload, TSettled>,
): Promise<TSettled> {
  const payload = options.event?.payload
  assertIdentity(payload)
  const name = options.stepName ?? 'detached-turn'
  const delay = options.pollDelay ?? '5 seconds'

  let attempt = 0
  let terminalResult: DetachedTurnTerminalResult
  while (true) {
    const driveResult = await options.step.do(`${name}:drive:${attempt}`, async () => {
      const outcome = await options.drive(payload)
      if (!outcome.succeeded) throw outcome.error
      return outcome.value
    })
    const state = (driveResult as { state?: unknown } | null)?.state
    if (!isKnownDriveState(state)) {
      throw new Error(`detached turn drive returned unknown state: ${String(state)}`)
    }
    if (state !== 'running') {
      terminalResult = driveResult as DetachedTurnTerminalResult
      break
    }
    await options.step.sleep(`${name}:wait:${attempt}`, delay)
    attempt += 1
  }

  return options.step.do(`${name}:settle`, () => options.settle(payload, terminalResult))
}
