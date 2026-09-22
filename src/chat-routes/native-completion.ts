/**
 * Exact terminal observation for a native Sandbox execution that another
 * request already admitted. This module never sends a prompt, calls
 * `driveTurn`, or cancels a run.
 */

import type { SandboxInstance, SessionInfo, SessionMessage } from '@tangle-network/sandbox'
import type { ChatTurnUsage } from './turn-routes'
import { readCompletedSandboxTurn, recoverSandboxAssistantMessage } from './completed-sandbox-turn'

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

function timestamp(value: Date | number | null | undefined): number | undefined {
  if (value instanceof Date) return value.getTime()
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
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

function attribution(result: Record<string, unknown> | undefined): Pick<
  NativeCompletionTurnReceipt,
  'servedModel' | 'servedProvider' | 'servedSource'
> {
  const metadata = record(result?.metadata)
  const modelAttribution = record(result?.modelAttribution) ?? record(metadata?.modelAttribution)
  const backend = record(result?.effectiveBackend) ?? record(metadata?.effectiveBackend)
  const source = nonEmptyString(result?.servedSource)
    ?? nonEmptyString(modelAttribution?.servedSource)
    ?? nonEmptyString(backend?.source)
  const servedSource = source === 'request' || source === 'environment' || source === 'profile'
    ? source
    : undefined
  const servedModel = nonEmptyString(result?.servedModel)
    ?? nonEmptyString(modelAttribution?.servedModel)
    ?? nonEmptyString(backend?.model)
  const servedProvider = nonEmptyString(result?.servedProvider)
    ?? nonEmptyString(modelAttribution?.servedProvider)
    ?? nonEmptyString(backend?.provider)
  return {
    ...(servedModel ? { servedModel } : {}),
    ...(servedProvider ? { servedProvider } : {}),
    ...(servedSource ? { servedSource } : {}),
  }
}

function usageFromResult(result: Record<string, unknown> | undefined): ChatTurnUsage {
  const raw = record(result?.usage) ?? record(result?.tokenUsage)
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    ...(number(raw?.inputTokens) !== undefined ? { inputTokens: number(raw?.inputTokens) } : {}),
    ...(number(raw?.outputTokens) !== undefined ? { outputTokens: number(raw?.outputTokens) } : {}),
    ...(number(raw?.cacheReadTokens) !== undefined ? { cacheReadTokens: number(raw?.cacheReadTokens) } : {}),
    ...(number(raw?.cacheWriteTokens) !== undefined ? { cacheWriteTokens: number(raw?.cacheWriteTokens) } : {}),
    ...(number(result?.costUsd) !== undefined ? { costUsd: number(result?.costUsd) } : {}),
  }
}

function interruptedMessages(messages: SessionMessage[], turnId: string): SessionMessage[] {
  return messages.filter((message) =>
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && (message.metadata.interrupted === true || message.metadata.status === 'interrupted'),
  )
}

function mergeUsage(messageUsage: ChatTurnUsage, resultUsage: ChatTurnUsage): ChatTurnUsage {
  return { ...messageUsage, ...resultUsage }
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
    return {
      state: 'failed',
      receipt: aggregateNativeCompletionReceipts([
        missingTurnReceipt(options.turnId, 'Native Sandbox dispatch was not observed before the admission deadline'),
      ]),
    }
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

  const messages = await exactSession.messages({ limit: 1_000 })
  const recovered: NativeCompletionTurnReceipt[] = []
  for (const turnId of admittedTurnIds) {
    const run = runsByTurnId.get(turnId)
    if (!run) {
      recovered.push(missingTurnReceipt(turnId, 'Native Sandbox execution ledger is missing the admitted turn'))
      continue
    }
    const completed = run.status === 'completed'
      ? await readCompletedSandboxTurn(source, { turnId, sessionId: options.sessionId })
      : null
    const cached = run.status === 'completed'
      ? await source.findCompletedTurn(turnId, { sessionId: options.sessionId })
      : null
    if (run.status === 'completed' && completed) {
      recovered.push({
        turnId,
        state: 'completed',
        text: completed.text ?? '',
        parts: completed.parts ?? [],
        usage: completed.usage ?? {},
        ...attribution(cached?.result),
      })
      continue
    }
    const interrupted = interruptedMessages(messages, turnId)
    if ((run.status === 'failed' || run.status === 'cancelled') && interrupted.length === 1) {
      const message = recoverSandboxAssistantMessage(interrupted[0]!)
      const result = await exactSession.result({ executionId: turnId })
      recovered.push({
        turnId,
        state: 'failed',
        text: message.text ?? result.response ?? '',
        parts: message.parts ?? [],
        usage: mergeUsage(message.usage ?? {}, {
          ...usageFromResult(result as unknown as Record<string, unknown>),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        }),
        ...attribution(result as unknown as Record<string, unknown>),
        error: result.error ?? interrupted[0]!.metadata?.interruptReason ?? status.failureReason?.message,
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
  const receipt = aggregateNativeCompletionReceipts(recovered)
  return receipt.state === 'completed'
    ? { state: 'completed', receipt }
    : { state: 'failed', receipt }
}
