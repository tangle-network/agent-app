/**
 * Durable terminal assembly for a native turn admitted by another request.
 * Product callbacks own domain effects and may use their own Workflow steps;
 * this helper never nests those callbacks inside `step.do`.
 */

import {
  NATIVE_COMPLETION_RECEIPT_MAX_BYTES,
  type NativeCompletionObservation,
  type NativeCompletionReceipt,
} from '../chat-routes/native-completion'
import { sha256Hex } from '../crypto/digest'
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

/** A checkpoint addresses the existing native record; it owns no copy of its body. */
interface NativeCompletionReceiptReference {
  receiptReference: {
    sessionId: string
    turnId: string
    turnIds: string[]
    contentSha256: string
    bytes: number
  }
  /** Includes product extensions, such as a native execution proof. */
  metadata: Omit<NativeCompletionReceipt, 'text' | 'parts'>
}

type NativeCompletionDriveResult = NativeCompletionObservation | (
  NativeCompletionReceiptReference & { state: 'completed' | 'failed' }
)

/** Large final output points at the transcript the product already persisted. */
export interface NativeCompletionTranscriptReference<TMessageId> extends Omit<NativeCompletionReceipt, 'text' | 'parts'> {
  text?: never
  parts?: never
  transcriptReference: { messageId: TMessageId; omitted: ['text', 'parts'] }
}

export type NativeCompletionWorkflowResult<TMessageId> = NativeCompletionReceipt | NativeCompletionTranscriptReference<TMessageId>

const encoder = new TextEncoder()
function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

/** JSON key order is immaterial; part order and every serialized value are not. */
function receiptBody(receipt: NativeCompletionReceipt): string {
  return JSON.stringify({ text: receipt.text, parts: receipt.parts }, (_key, value: unknown) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]))
      : value
  ))
}

export interface NativeCompletionWorkflowOptions<
  TPayload extends NativeCompletionWorkflowPayload,
  TMessageId,
> {
  event: CloudflareWorkflowEventLike<TPayload>
  step: CloudflareWorkflowStepLike
  /** Read-only exact observation. It must never dispatch, drive, or cancel. */
  observe(payload: TPayload): Promise<NativeCompletionObservation>
  /**
   * Reload this admission's exact retained native receipt, without changing
   * admission, stream status, transcript or settlement. Required only when an
   * observation exceeds the checkpoint budget. The adapter verifies the whole
   * content against the checkpoint before preparation. Original usage, terminal
   * facts and product proof metadata stay in the checkpoint; a later read cannot
   * replace them. A missing or changed result is retryable; it never becomes an
   * empty successful answer. Reuse the product's existing native read adapter.
   */
  readReceipt?(payload: TPayload): Promise<NativeCompletionReceipt | null>
  /**
   * Product-owned idempotent preparation, for example artifact promotion and
   * output classification. It runs outside an enclosing Workflow step so a
   * product may use its own named steps without nesting `step.do`.
   */
  prepare?(payload: TPayload, receipt: NativeCompletionReceipt): Promise<NativeCompletionReceipt>
  /**
   * Durable transcript write. Without a message id it must upsert the turn's
   * one row: the terminal observation step checkpoints the observed receipt
   * with it before preparation for an inline receipt. Oversized native bodies
   * stay in the native result until preparation promotes their artifacts; the
   * transcript step then writes the prepared view. A supplied message id updates
   * the existing row. The product owns that view's storage limits.
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
  /**
   * Record final timing only after settlement (including Vault reconciliation) returned its final verdict.
   * The callback must be idempotent by turnStreamId and use explicit durable facts, never isolate-local fallback.
   * Workflow replay reuses this step; an observer outage never reaches it.
   */
  recordTiming?(payload: TPayload, receipt: NativeCompletionReceipt, timing: { settledAt: number }): Promise<void>
  /** Optional product buffer completion after successful settlement. */
  finalizeBuffer?(payload: TPayload, receipt: NativeCompletionReceipt, messageId: TMessageId): Promise<void>
  /** Release the product lock only after every terminal effect completed. */
  releaseLock(payload: TPayload): Promise<void>
  /** Durable trace delivery/final markers after the finished turn lock is released. */
  afterRelease?(payload: TPayload, receipt: NativeCompletionReceipt): Promise<void>
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
  if (value.state !== 'running' && value.receipt.state !== value.state) {
    throw new Error('native completion observation contradicts its receipt state')
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
>(options: NativeCompletionWorkflowOptions<TPayload, TMessageId>): Promise<NativeCompletionWorkflowResult<TMessageId>> {
  const name = options.stepName ?? 'native-completion'
  // Only the invocation that observed the answer holds this value. A replay
  // resolves the checkpoint through the native reader, never a mutable chat row
  // or the product's observation callback (which may update stream status).
  let observedReceipt: NativeCompletionReceipt | undefined
  const checkpoint = await runDetachedTurnWorkflowTick<
    TPayload,
    NativeCompletionReceipt | NativeCompletionReceiptReference,
    NativeCompletionDriveResult
  >({
    event: options.event,
    step: options.step,
    pollDelay: options.pollDelay ?? nativeCompletionPollDelay,
    stepName: `${name}:observe`,
    drive: async (payload) => {
      const observation = validObservation(await options.observe(payload))
      if (observation.state === 'running') return { succeeded: true, value: observation }
      if (!('receipt' in observation)) throw new Error('native completion observer returned a reference instead of a receipt')
      if (serializedBytes(observation) > NATIVE_COMPLETION_RECEIPT_MAX_BYTES) {
        if (!options.readReceipt) throw new Error('Oversized native completion requires a read-only exact receipt reader')
        const { text: _text, parts: _parts, ...metadata } = observation.receipt
        const serialized = receiptBody(observation.receipt)
        const reference = {
          state: observation.state,
          receiptReference: {
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            turnIds: observation.receipt.completedTurnIds,
            contentSha256: await sha256Hex(serialized),
            bytes: encoder.encode(serialized).byteLength,
          },
          metadata,
        }
        if (serializedBytes(reference) > NATIVE_COMPLETION_RECEIPT_MAX_BYTES) {
          throw new Error('Native completion reference metadata exceeds the checkpoint byte budget')
        }
        observedReceipt = observation.receipt
        return { succeeded: true, value: reference }
      }
      // The observed answer is written in the same step that observed it, so
      // a later preparation, settlement or Workflow failure cannot lose it.
      await options.persistTranscript(payload, observation.receipt)
      return { succeeded: true, value: observation }
    },
    settle: async (_payload, result) => 'receipt' in result ? result.receipt : result,
  })

  let receipt: NativeCompletionReceipt
  if ('receiptReference' in checkpoint) {
    const reference = checkpoint.receiptReference
    if (reference.sessionId !== options.event.payload.sessionId || reference.turnId !== options.event.payload.turnId) {
      throw new Error('Native completion reference belongs to another admission')
    }
    const retained = observedReceipt ?? await options.readReceipt?.(options.event.payload)
    if (!retained) throw new Error('Native completion referenced receipt is unavailable; retry the exact native read')
    const serialized = receiptBody(retained)
    if (retained.state !== checkpoint.metadata.state
      || JSON.stringify(retained.completedTurnIds) !== JSON.stringify(reference.turnIds)
      || encoder.encode(serialized).byteLength !== reference.bytes
      || await sha256Hex(serialized) !== reference.contentSha256) {
      throw new Error('Native completion referenced receipt changed; reconciliation is required')
    }
    receipt = { ...checkpoint.metadata, text: retained.text, parts: retained.parts }
  } else {
    receipt = checkpoint
  }
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
  let result: NativeCompletionWorkflowResult<TMessageId> = receipt
  if (serializedBytes(receipt) > NATIVE_COMPLETION_RECEIPT_MAX_BYTES) {
    const { text: _text, parts: _parts, ...metadata } = receipt
    result = { ...metadata, transcriptReference: { messageId, omitted: ['text', 'parts'] } }
    if (serializedBytes(result) > NATIVE_COMPLETION_RECEIPT_MAX_BYTES) {
      throw new Error('Native completion transcript reference metadata exceeds the output byte budget')
    }
  }
  if (options.recordTiming) {
    await options.step.do(`${name}:record-timing`, () => (
      options.recordTiming!(options.event.payload, receipt, { settledAt: Date.now() })
    ))
  }
  if (options.finalizeBuffer) {
    await options.step.do(`${name}:finalize-buffer`, () => (
      options.finalizeBuffer!(options.event.payload, receipt, messageId)
    ))
  }
  await options.step.do(`${name}:release-lock`, () => options.releaseLock(options.event.payload))
  await options.afterRelease?.(options.event.payload, receipt)
  return result
}
