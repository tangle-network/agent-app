/**
 * Exact terminal observation for a native Sandbox execution that another
 * request already admitted. This module never sends a prompt, calls
 * `driveTurn`, or cancels a run.
 */

import type { SandboxInstance, SessionInfo, SessionMessage } from '@tangle-network/sandbox'
import type { ChatTurnUsage } from './turn-routes'
import {
  readCompletedSandboxTurn,
  recoverSandboxAssistantMessage,
} from './completed-sandbox-turn'

export interface NativeCompletionReceipt {
  state: 'completed' | 'failed'
  text: string
  parts: Array<Record<string, unknown>>
  /** An empty object is an unknown usage receipt, never a measured zero. */
  usage: ChatTurnUsage
  servedModel?: string
  servedProvider?: string
  servedSource?: 'request' | 'environment' | 'profile'
  error?: string
  completedTurnIds: string[]
}

export interface NativeCompletionAdmission {
  executionId: string
  state: 'open' | 'closed'
  admittedTurnIds: readonly string[]
  ownerLeaseUntil: Date | number
  updatedAt?: Date | number
  closedAt?: Date | number | null
}

/** Product persistence for the one admission that authorizes this observer. */
export interface NativeCompletionAdmissionStore {
  read(executionId: string): Promise<NativeCompletionAdmission | null>
  renew(executionId: string, now: Date): Promise<NativeCompletionAdmission | null>
  closeExpired(executionId: string, now: Date): Promise<NativeCompletionAdmission | null>
}

/** The official Sandbox reads needed for exact native completion observation. */
export type NativeCompletionSessionSource = Pick<SandboxInstance, 'findCompletedTurn' | 'session'>

export interface NativeCompletionObservationOptions {
  /** Null when the product cannot currently resolve the admitted Sandbox. */
  source: NativeCompletionSessionSource | null
  admissionStore: NativeCompletionAdmissionStore
  executionId: string
  sessionId: string
  turnId: string
  registeredAt: number
  absentDispatchDeadlineMs?: number
  receiptDeadlineMs?: number
  now?: number
}

export type NativeCompletionObservation =
  | { state: 'running' }
  | { state: 'completed'; receipt: NativeCompletionReceipt }
  | { state: 'failed'; receipt: NativeCompletionReceipt }

/** One exact turn receipt before an admission's ordered aggregate. */
export interface NativeCompletionTurnReceipt {
  turnId: string
  state: 'completed' | 'failed'
  text: string
  parts: Array<Record<string, unknown>>
  usage: ChatTurnUsage
  servedModel?: string
  servedProvider?: string
  servedSource?: 'request' | 'environment' | 'profile'
  error?: string
}

const DEFAULT_ABSENT_DISPATCH_DEADLINE_MS = 10 * 60_000
const DEFAULT_RECEIPT_DEADLINE_MS = 10 * 60_000
/** Session messages are read from this long before registration, so clock
 *  skew between the product Worker and the Sandbox cannot hide the turn. */
const MESSAGE_READ_SKEW_MS = 10 * 60_000

/**
 * Serialized UTF-8 budget for one terminal receipt. A Cloudflare Workflow
 * refuses a step result over 1 MiB and D1 refuses a row over 2 MB, and a
 * receipt approaches both as tool payloads accumulate over a long turn.
 */
export const NATIVE_COMPLETION_RECEIPT_MAX_BYTES = 900 * 1024

/** Per-string caps tried in order until a receipt fits its budget. */
// Status, ids and paths stay well under the smallest cap.
const RECEIPT_STRING_CAPS = [16_384, 4_096, 1_024, 256] as const

const encoder = new TextEncoder()

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function capString(value: string, cap: number): string {
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}…[truncated ${value.length - cap} characters; the Sandbox session keeps the full value]`
}

function capStrings(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return capString(value, cap)
  if (Array.isArray(value)) return value.map((item) => capStrings(item, cap))
  const object = record(value)
  if (!object) return value
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, capStrings(item, cap)]))
}

/** Tool payloads and reasoning shrink; the answer text, files and interactions do not. */
function capReceiptPart(part: Record<string, unknown>, cap: number): Record<string, unknown> {
  const type = String(part.type ?? '')
  if (type === 'tool') {
    const state = record(part.state)
    if (!state) return part
    const capped = capStrings(state, cap) as Record<string, unknown>
    if (serializedBytes(capped) === serializedBytes(state)) return part
    return { ...part, state: { ...capped, metadata: { ...record(capped.metadata), receiptTruncated: true } } }
  }
  if (type === 'reasoning' && typeof part.text === 'string' && part.text.length > cap) {
    return { ...part, text: capString(part.text, cap), receiptTruncated: true }
  }
  return part
}

/** Last resort for a receipt whose part count alone exceeds the budget. */
function skeletonPart(part: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(part.type ?? '')
  if (type === 'reasoning') return null
  if (type !== 'tool') return part
  const state = record(part.state)
  return {
    type: 'tool',
    ...(part.id !== undefined ? { id: part.id } : {}),
    ...(part.tool !== undefined ? { tool: part.tool } : {}),
    state: { status: state?.status ?? 'completed', metadata: { receiptTruncated: true } },
  }
}

/**
 * Fit a terminal receipt inside {@link NATIVE_COMPLETION_RECEIPT_MAX_BYTES}.
 * A receipt under the budget is returned unchanged. Over it, the longest
 * strings in tool payloads and reasoning are clipped with a marker, at
 * successively smaller caps, so a long turn's answer is always persistable.
 */
export function boundNativeCompletionReceipt(
  receipt: NativeCompletionReceipt,
  maxBytes: number = NATIVE_COMPLETION_RECEIPT_MAX_BYTES,
): NativeCompletionReceipt {
  if (serializedBytes(receipt) <= maxBytes) return receipt
  for (const cap of RECEIPT_STRING_CAPS) {
    const bounded = { ...receipt, parts: receipt.parts.map((part) => capReceiptPart(part, cap)) }
    if (serializedBytes(bounded) <= maxBytes) return bounded
  }
  const skeleton = {
    ...receipt,
    parts: receipt.parts.map(skeletonPart).filter((part): part is Record<string, unknown> => part !== null),
  }
  if (serializedBytes(skeleton) <= maxBytes) return skeleton
  // Only the answer text is left to shrink.
  const textBudget = Math.max(0, Math.floor(maxBytes / 4))
  return {
    ...skeleton,
    text: capString(skeleton.text, textBudget),
    parts: skeleton.parts.map((part) => (part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: capString(part.text, textBudget) }
      : part)),
  }
}

function terminal(receipt: NativeCompletionReceipt): NativeCompletionObservation {
  const bounded = boundNativeCompletionReceipt(receipt)
  return bounded.state === 'completed'
    ? { state: 'completed', receipt: bounded }
    : { state: 'failed', receipt: bounded }
}

function timestamp(value: Date | number | null | undefined): number | undefined {
  if (value instanceof Date) return value.getTime()
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isSandboxNotFoundError(value: unknown): boolean {
  const error = record(value)
  return error?.name === 'NotFoundError' || error?.code === 'NOT_FOUND' || error?.status === 404
}

function interruptedMessages(messages: SessionMessage[], turnId: string): SessionMessage[] {
  return messages.filter((message) =>
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && (message.metadata.interrupted === true || message.metadata.status === 'interrupted'),
  )
}

function consistent<T>(values: Array<T | undefined>): T | undefined {
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined
  const first = values[0] as T
  return values.every((value) => value === first) ? first : undefined
}

function sum(values: Array<number | undefined>): number | undefined {
  if (values.some((value) => value === undefined)) return undefined
  return (values as number[]).reduce((total, value) => total + value, 0)
}

/** Assemble admitted exact receipts in dispatch order. Missing usage stays unknown. */
export function aggregateNativeCompletionReceipts(turns: readonly NativeCompletionTurnReceipt[]): NativeCompletionReceipt {
  const failed = turns.some((turn) => turn.state === 'failed')
  const usage: ChatTurnUsage = {}
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
    const total = sum(turns.map((turn) => turn.usage[key]))
    if (total !== undefined) usage[key] = total
  }
  // A missing exact receipt is the terminal observer failure even when an
  // earlier execution also failed. Preserve that earlier partial transcript,
  // but surface why this aggregate could not be fully reconciled.
  const error = turns.find((turn) =>
    turn.error?.startsWith('Admitted native execution did not produce')
    || turn.error?.startsWith('Native Sandbox execution ledger is missing'),
  )?.error ?? turns.find((turn) => turn.error)?.error
  return {
    state: failed ? 'failed' : 'completed',
    text: turns.map((turn) => turn.text).join(''),
    parts: turns.flatMap((turn) => turn.parts),
    usage,
    ...(consistent(turns.map((turn) => turn.servedModel)) ? { servedModel: consistent(turns.map((turn) => turn.servedModel)) } : {}),
    ...(consistent(turns.map((turn) => turn.servedProvider)) ? { servedProvider: consistent(turns.map((turn) => turn.servedProvider)) } : {}),
    ...(consistent(turns.map((turn) => turn.servedSource)) ? { servedSource: consistent(turns.map((turn) => turn.servedSource)) } : {}),
    ...(error ? { error } : {}),
    completedTurnIds: turns.map((turn) => turn.turnId),
  }
}

function missingTurnReceipt(turnId: string, error: string): NativeCompletionTurnReceipt {
  // An execution ledger entry proves this turn reached a terminal state, but
  // not that its terminal transcript was retained. Keep any earlier exact
  // evidence when the bounded wait expires; `{}` means aggregate usage is
  // unknown because this turn has no usage receipt.
  return { turnId, state: 'failed', text: '', parts: [], usage: {}, error }
}

/**
 * Observe only the turns admitted under `executionId`. Transport failures throw
 * so the durable owner retries. A missing or partial terminal record remains
 * `running` until the configured deadline; it never starts another run.
 */
export async function observeNativeCompletion(
  options: NativeCompletionObservationOptions,
): Promise<NativeCompletionObservation> {
  const now = options.now ?? Date.now()
  let admission = await options.admissionStore.read(options.executionId)
  if (!admission) throw new Error('Native completion admission is missing')
  if (admission.executionId !== options.executionId) throw new Error('Native completion admission identity conflict')
  const leaseUntil = timestamp(admission.ownerLeaseUntil) ?? 0
  const source = options.source
  const session = source?.session(options.sessionId)
  let status: SessionInfo | null
  if (!session) {
    status = null
  } else {
    try {
      status = await session.status()
    } catch (error) {
      if (!isSandboxNotFoundError(error)) throw error
      status = null
    }
  }

  if (!status || !session || !source) {
    if (admission.state === 'open' && leaseUntil <= now) {
      admission = await options.admissionStore.closeExpired(options.executionId, new Date(now)) ?? admission
    }
    if (admission.state === 'open' || now - options.registeredAt < (options.absentDispatchDeadlineMs ?? DEFAULT_ABSENT_DISPATCH_DEADLINE_MS)) {
      return { state: 'running' }
    }
    return terminal(aggregateNativeCompletionReceipts([
      missingTurnReceipt(options.turnId, 'Native Sandbox dispatch was not observed before the admission deadline'),
    ]))
  }
  const exactSession = session

  if (admission.state === 'open') {
    if (status.status === 'queued' || status.status === 'running') {
      admission = await options.admissionStore.renew(options.executionId, new Date(now)) ?? admission
    } else if (leaseUntil <= now) {
      admission = await options.admissionStore.closeExpired(options.executionId, new Date(now)) ?? admission
    }
    if (admission.state === 'open') return { state: 'running' }
  }
  // `closeExpired` may return the current row after another owner appended a
  // continuation. Read its full ordered ledger rather than observing the
  // earlier snapshot from before the close attempt.
  const admittedTurnIds = [...admission.admittedTurnIds]
  if (admittedTurnIds.length === 0 || admittedTurnIds[0] !== options.turnId) {
    throw new Error('Native completion admission has an invalid turn sequence')
  }

  const runs = await exactSession.runs()
  const runsByTurnId = new Map(runs.map((run) => [run.executionId, run]))
  const missingExecution = admittedTurnIds.find((turnId) => !runsByTurnId.has(turnId))
  if (missingExecution && now - options.registeredAt < (options.absentDispatchDeadlineMs ?? DEFAULT_ABSENT_DISPATCH_DEADLINE_MS)) {
    return { state: 'running' }
  }
  if (admittedTurnIds.some((turnId) => runsByTurnId.get(turnId)?.status === 'active')) return { state: 'running' }

  // Completed recovery owns its message read. Load interrupted history only
  // when it is needed, and share that one read across failed continuations.
  // Both reads start shortly before registration, so their size follows this
  // turn rather than the whole session.
  const since = Math.max(0, options.registeredAt - MESSAGE_READ_SKEW_MS)
  let messages: SessionMessage[] | undefined
  const recovered: NativeCompletionTurnReceipt[] = []
  for (const turnId of admittedTurnIds) {
    const run = runsByTurnId.get(turnId)
    if (!run) {
      recovered.push(missingTurnReceipt(turnId, 'Native Sandbox execution ledger is missing the admitted turn'))
      continue
    }
    const completed = run.status === 'completed'
      ? await readCompletedSandboxTurn(source, { turnId, sessionId: options.sessionId, since })
      : null
    if (run.status === 'completed' && completed) {
      recovered.push({
        ...completed,
        turnId,
        state: 'completed',
        text: completed.text ?? '',
        parts: completed.parts ?? [],
        usage: completed.usage ?? {},
      })
      continue
    }
    const interrupted = run.status === 'failed' || run.status === 'cancelled'
      ? interruptedMessages(messages ??= await exactSession.messages({ limit: 1_000, since }), turnId)
      : []
    if ((run.status === 'failed' || run.status === 'cancelled') && interrupted.length === 1) {
      // The receipt is the interrupted message the Sandbox recorded. Replaying
      // the execution's event stream instead costs CPU in proportion to the
      // run's length, which a long turn's terminal step cannot afford within a
      // Workflow step's CPU limit.
      const message = recoverSandboxAssistantMessage(interrupted[0]!)
      const interruptReason = interrupted[0]!.metadata?.interruptReason
      recovered.push({
        turnId,
        state: 'failed',
        text: message.text ?? '',
        parts: message.parts ?? [],
        usage: message.usage ?? {},
        error: (typeof interruptReason === 'string' && interruptReason)
          || status.failureReason?.message
          || `Native Sandbox execution ${run.status}`,
      })
      continue
    }
    const closedAt = timestamp(admission.closedAt)
      ?? timestamp(admission.updatedAt)
      ?? options.registeredAt
    if (now - closedAt < (options.receiptDeadlineMs ?? DEFAULT_RECEIPT_DEADLINE_MS)) return { state: 'running' }
    recovered.push(missingTurnReceipt(
      turnId,
      `Admitted native execution did not produce an exact completion: ${turnId}`,
    ))
  }
  return terminal(aggregateNativeCompletionReceipts(recovered))
}
