/**
 * Durable terminal assembly for a native turn admitted by another request.
 * Product callbacks own domain effects and may use their own Workflow steps;
 * this helper never nests those callbacks inside `step.do`.
 */

import type {
  NativeCompletionObservation,
  NativeCompletionReceipt,
} from '../chat-routes/native-completion'
import {
  runDetachedTurnWorkflowTick,
  type CloudflareWorkflowEventLike,
  type CloudflareWorkflowSleepDuration,
  type CloudflareWorkflowStepLike,
  type DetachedTurnWorkflowIdentity,
} from './detached-turn-workflow'

/** Stable identity required to resume a registered native completion. */
export interface NativeCompletionWorkflowPayload extends DetachedTurnWorkflowIdentity {
  registeredAt: number
}

type NativeCompletionDriveResult = NativeCompletionObservation

export interface NativeCompletionWorkflowOptions<
  TPayload extends NativeCompletionWorkflowPayload,
  TMessageId,
> {
  event: CloudflareWorkflowEventLike<TPayload>
  step: CloudflareWorkflowStepLike
  /** Read-only exact observation. It must never dispatch, drive, or cancel. */
  observe(payload: TPayload): Promise<NativeCompletionObservation>
  /**
   * Product-owned idempotent preparation, for example artifact promotion and
   * output classification. It runs outside an enclosing Workflow step so a
   * product may use its own named steps without nesting `step.do`.
   */
  prepare?(payload: TPayload, receipt: NativeCompletionReceipt): Promise<NativeCompletionReceipt>
  /**
   * Durable transcript write. Without a message id it must upsert the turn's
   * one row: the terminal observation step checkpoints the observed receipt
   * with it before preparation, and the transcript step writes the prepared
   * receipt over that checkpoint. A supplied message id updates the existing row.
   */
  persistTranscript(
    payload: TPayload,
    receipt: NativeCompletionReceipt,
    existingMessageId?: TMessageId,
  ): Promise<TMessageId>
  /**
   * Product-owned idempotent settlement. A rejection leaves the lock held and
   * skips finalization, making the failed dependency observable and retryable.
   */
  settle(
    payload: TPayload,
    receipt: NativeCompletionReceipt,
    messageId: TMessageId,
  ): Promise<NativeCompletionReceipt | void>
  /** Optional product buffer completion after successful settlement. */
  finalizeBuffer?(payload: TPayload, receipt: NativeCompletionReceipt, messageId: TMessageId): Promise<void>
  /** Release the product lock only after every terminal effect completed. */
  releaseLock(payload: TPayload): Promise<void>
  /** Default: 5 s for the first two minutes, 15 s until thirty minutes, then 30 s. */
  pollDelay?: CloudflareWorkflowSleepDuration | ((attempt: number) => CloudflareWorkflowSleepDuration)
  stepName?: string
}

/**
 * Wait before observation pass `attempt + 1`: 5 s for the first two minutes,
 * 15 s until thirty minutes, then 30 s. Each pass is two Workflow steps and a
 * Workflow allows 10,000, so a fixed 5 s wait ends an instance after about
 * seven hours; this schedule leaves room for more than forty.
 */
function nativeCompletionPollDelay(attempt: number): CloudflareWorkflowSleepDuration {
  if (attempt < 24) return '5 seconds'
  if (attempt < 136) return '15 seconds'
  return '30 seconds'
}

function validObservation(value: NativeCompletionObservation): NativeCompletionDriveResult {
  if (!value || (value.state !== 'running' && value.state !== 'completed' && value.state !== 'failed')) {
    throw new Error(`native completion observer returned unknown state: ${String((value as { state?: unknown } | null)?.state)}`)
  }
  if (value.state !== 'running' && !value.receipt) {
    throw new Error('native completion observer returned a terminal state without a receipt')
  }
  return value
}

/**
 * Drive exact observation through durable retry steps, then run the terminal
 * sequence once. `prepare` and `settle` are deliberately outside `step.do` so
 * product callbacks can compose their own named Cloudflare Workflow steps.
 */
export async function runNativeCompletionWorkflow<
  TPayload extends NativeCompletionWorkflowPayload,
  TMessageId,
>(options: NativeCompletionWorkflowOptions<TPayload, TMessageId>): Promise<NativeCompletionReceipt> {
  const name = options.stepName ?? 'native-completion'
  let receipt = await runDetachedTurnWorkflowTick<
    TPayload,
    NativeCompletionReceipt,
    NativeCompletionDriveResult
  >({
    event: options.event,
    step: options.step,
    pollDelay: options.pollDelay ?? nativeCompletionPollDelay,
    stepName: `${name}:observe`,
    drive: async (payload) => {
      const observation = validObservation(await options.observe(payload))
      // The observed answer is written in the same step that observed it, so
      // a later preparation, settlement or Workflow failure cannot lose it.
      if (observation.state !== 'running') await options.persistTranscript(payload, observation.receipt)
      return { succeeded: true, value: observation }
    },
    settle: async (_payload, result) => result.receipt,
  })

  if (options.prepare) receipt = await options.prepare(options.event.payload, receipt)
  const messageId = await options.step.do(`${name}:persist-transcript`, () => (
    options.persistTranscript(options.event.payload, receipt)
  ))
  const settledReceipt = await options.settle(options.event.payload, receipt, messageId)
  if (settledReceipt) {
    receipt = settledReceipt
    await options.step.do(`${name}:persist-final-transcript`, () => (
      options.persistTranscript(options.event.payload, receipt, messageId)
    ))
  }
  if (options.finalizeBuffer) {
    await options.step.do(`${name}:finalize-buffer`, () => (
      options.finalizeBuffer!(options.event.payload, receipt, messageId)
    ))
  }
  await options.step.do(`${name}:release-lock`, () => options.releaseLock(options.event.payload))
  return receipt
}
