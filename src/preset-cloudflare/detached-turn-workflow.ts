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

function assertWorkflowTurnIdentity(
  payload: unknown,
  label: string,
): asserts payload is WorkflowTurnIdentity {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  if (!record || typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
    throw new Error(`${label} requires a non-empty sessionId`)
  }
  if (typeof record.turnId !== 'string' || !record.turnId.trim()) {
    throw new Error(`${label} requires a non-empty turnId`)
  }
}

interface WorkflowTurnStepNames {
  admit: string
  poll: (attempt: number) => string
  wait: (attempt: number) => string
  settle: string
}

interface WorkflowTurnLoopOptions<TAdmission, TStatus, TSettled> {
  step: CloudflareWorkflowStepLike
  names: WorkflowTurnStepNames
  delay: CloudflareWorkflowSleepDuration
  admit: () => Promise<Outcome<TAdmission>>
  initialStatus?: (admission: TAdmission) => TStatus
  poll: (admission: TAdmission) => Promise<Outcome<TStatus>>
  isRunning: (status: TStatus) => boolean
  settle: (status: TStatus) => Promise<TSettled>
}

async function resolveWorkflowOutcome<T>(
  operation: () => Promise<Outcome<T>>,
): Promise<T> {
  const outcome = await operation()
  if (!outcome.succeeded) throw outcome.error
  return outcome.value
}

async function runWorkflowTurnLoop<TAdmission, TStatus, TSettled>(
  options: WorkflowTurnLoopOptions<TAdmission, TStatus, TSettled>,
): Promise<TSettled> {
  const admission = await options.step.do(
    options.names.admit,
    () => resolveWorkflowOutcome(options.admit),
  )
  let hasStatus = options.initialStatus !== undefined
  let status!: TStatus
  if (hasStatus) status = options.initialStatus!(admission)
  let attempt = 0
  while (true) {
    if (!hasStatus) {
      status = await options.step.do(
        options.names.poll(attempt),
        () => resolveWorkflowOutcome(() => options.poll(admission)),
      )
    }
    if (!options.isRunning(status)) {
      return options.step.do(options.names.settle, () => options.settle(status))
    }
    await options.step.sleep(options.names.wait(attempt), options.delay)
    attempt += 1
    hasStatus = false
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
  assertWorkflowTurnIdentity(payload, 'Workflow turn payload')
  const name = options.stepName ?? 'workflow-turn'
  const delay = options.pollDelay ?? '5 seconds'
  return runWorkflowTurnLoop({
    step: options.step,
    names: {
      admit: `${name}:admit`,
      poll: (attempt) => `${name}:poll:${attempt}`,
      wait: (attempt) => `${name}:wait:${attempt}`,
      settle: `${name}:settle`,
    },
    delay,
    admit: () => options.admit(payload),
    poll: (admission) => options.poll(payload, admission),
    isRunning: options.isRunning,
    settle: (status) => options.settle(payload, status),
  })
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
  assertWorkflowTurnIdentity(payload, 'detached turn Workflow payload')
  const name = options.stepName ?? 'detached-turn'
  const delay = options.pollDelay ?? '5 seconds'
  return runWorkflowTurnLoop({
    step: options.step,
    names: {
      admit: `${name}:drive:0`,
      poll: (attempt) => `${name}:drive:${attempt}`,
      wait: (attempt) => `${name}:wait:${attempt}`,
      settle: `${name}:settle`,
    },
    delay,
    admit: () => options.drive(payload),
    initialStatus: (driveResult) => driveResult,
    poll: () => options.drive(payload),
    isRunning: (driveResult) => {
      const state = (driveResult as { state?: unknown } | null)?.state
      if (!isKnownDriveState(state)) {
        throw new Error(`detached turn drive returned unknown state: ${String(state)}`)
      }
      return state === 'running'
    },
    settle: (driveResult) => options.settle(payload, driveResult as DetachedTurnTerminalResult),
  })
}
