import type { SandboxInstance } from '@tangle-network/sandbox'
import type { PromptInputPart } from './prompt-profile'
import type { StreamSandboxPromptOptions } from './prompt-options'

export type StreamPromptOptions = Parameters<SandboxInstance['streamPrompt']>[1]

type DispatchPromptOptions = Parameters<SandboxInstance['dispatchPrompt']>[1]

type CompletedTurn = NonNullable<Awaited<ReturnType<SandboxInstance['findCompletedTurn']>>>

function cachedSandboxPromptEvents(
  cached: CompletedTurn,
  fallbackExecutionId: string,
): Array<Record<string, unknown>> {
  const cachedResult = cached.result
  const executionId = typeof cachedResult.executionId === 'string' && cachedResult.executionId.trim()
    ? cachedResult.executionId
    : fallbackExecutionId
  const finalText = typeof cachedResult.finalText === 'string'
    ? cachedResult.finalText
    : typeof cachedResult.response === 'string'
      ? cachedResult.response
      : typeof cachedResult.text === 'string'
        ? cachedResult.text
        : undefined

  return [
    {
      type: 'result',
      data: {
        ...cachedResult,
        ...(finalText !== undefined && cachedResult.finalText === undefined ? { finalText } : {}),
        sessionId: cached.sessionId,
        executionId,
      },
    },
    {
      type: 'done',
      data: {
        sessionId: cached.sessionId,
        executionId,
        status: 'completed',
        outcome: { type: 'completed' },
      },
    },
  ]
}

/**
 * Open the durable event lane for one detached prompt.
 *
 * `dispatchPrompt` is the admission boundary: it returns after the sandbox has
 * accepted the run and keeps executing it after this Worker disappears. The
 * SDK's execution replay stream is then the exact execution-scoped surface.
 * Replaying through `streamPrompt` preserves the direct run-event vocabulary;
 * the session bus wraps message parts under `data.properties`.
 */
export async function* detachedSandboxPromptEvents(
  box: SandboxInstance,
  prompt: string | PromptInputPart[],
  options: StreamSandboxPromptOptions,
  backend: NonNullable<StreamPromptOptions>['backend'],
): AsyncGenerator<unknown> {
  const sessionId = options.sessionId?.trim()
  const executionId = options.executionId?.trim()
  if (!sessionId || !executionId) {
    throw new Error('streamSandboxPrompt detach requires stable sessionId and executionId')
  }

  options.signal?.throwIfAborted()
  const lastEventId = options.lastEventId?.trim() || undefined
  const turnId = options.turnId?.trim() || executionId
  // A cursor is already proof that this execution was admitted. Re-dispatching
  // before replay would turn a failed terminal session into a new prompt.
  const admission = lastEventId
    ? null
    : await box.dispatchPrompt(prompt, {
        sessionId,
        executionId,
        turnId,
        backend,
        ...(options.expectedPublicProfileRequestDigest
          ? { expectedPublicProfileRequestDigest: options.expectedPublicProfileRequestDigest }
          : {}),
        ...(options.expectedSecretProfileReceipt
          ? { expectedSecretProfileReceipt: options.expectedSecretProfileReceipt }
          : {}),
        ...(options.requireVisibleAssistantOutput !== undefined
          ? { requireVisibleAssistantOutput: options.requireVisibleAssistantOutput }
          : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.trace ? { traceId: options.trace.traceId } : {}),
      } as DispatchPromptOptions)
  // An admission already sent must settle before observation ends. Its product
  // owner can fence an accepted native run; an aborted read is never no-send proof.
  options.signal?.throwIfAborted()
  // A completed-turn cache hit deliberately returns `dispatched: false` and
  // emits no new stream events. Yield its public result directly; the replay
  // buffer may already have aged out by the time a retry reaches this helper.
  if (admission?.dispatched === false) {
    const cached = await box.findCompletedTurn(turnId, { sessionId })
    options.signal?.throwIfAborted()
    if (cached) {
      if (cached.turnId !== turnId || cached.sessionId !== sessionId) {
        throw new Error('sandbox.detached_completed_turn_identity_mismatch')
      }
      yield* cachedSandboxPromptEvents(cached, executionId)
      return
    }
  }

  // The SDK may return a different active execution with dispatched: false.
  // That is neither admission of this run nor permission to observe its peer.
  // Only an exact keyed completed turn above may retain a prior execution ID.
  if (admission && (admission.sessionId !== sessionId || admission.executionId !== executionId)) {
    throw new Error('sandbox.detached_admission_identity_mismatch')
  }

  // The session bus is a useful observation surface, but its message events
  // use a different envelope (`data.properties.part`). Use the SDK's exact
  // execution replay instead so downstream producers receive the same event
  // vocabulary as a direct prompt stream (`data.part`, terminal `result`, etc.).
  yield* box.streamPrompt('', {
    sessionId,
    executionId,
    lastEventId: lastEventId || '0',
    ...(options.trace ? { traceId: options.trace.traceId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  } as StreamPromptOptions)
}

/**
 * The small event shape consumed by agent-gateway's streaming adapters.
 *
 * Sandbox providers can add fields to their event payloads over time. This
 * adapter deliberately copies only the fields the gateway understands so
 * consumers do not each have to maintain a provider-to-gateway cast.
 */
export interface SandboxStreamEvent {
  type?: string
  data?: {
    part?: { type?: string; text?: string }
    delta?: string
    finalText?: string
    code?: string
    message?: string
    details?: Record<string, unknown>
    inputRequired?: { prompt?: string }
    usage?: {
      inputTokens?: number
      outputTokens?: number
      reasoningTokens?: number
      toolTokens?: number
      toolCallCount?: number
      providerCostUsd?: number
      budgetEnforced?: boolean
    }
    tool?: { name?: string; inputTokens?: number; outputTokens?: number }
    reasoning?: { tokens?: number }
  }
}

function optionalNonNegativeNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`sandbox gateway event ${field} is invalid`)
  }
  return value
}

function optionalNonNegativeSafeInteger(
  value: unknown,
  field: string,
): number | undefined {
  const number = optionalNonNegativeNumber(value, field)
  if (number !== undefined && !Number.isSafeInteger(number)) {
    throw new Error(`sandbox gateway event ${field} is invalid`)
  }
  return number
}

function optionalGatewayRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`sandbox gateway event ${field} is invalid`)
  }
  return value as Record<string, unknown>
}

/** Normalize raw sandbox events for shared agent-gateway consumers. */
export function adaptSandboxStream(
  events: AsyncIterable<unknown>,
): AsyncGenerator<SandboxStreamEvent> {
  return (async function* () {
    for await (const rawEvent of events) {
      if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) continue

      const event = rawEvent as Record<string, unknown>
      const rawData = event.data
      const dataRecord =
        rawData && typeof rawData === 'object' && !Array.isArray(rawData)
          ? (rawData as Record<string, unknown>)
          : null
      const data: NonNullable<SandboxStreamEvent['data']> = {}

      const rawPart = dataRecord?.part
      if (rawPart && typeof rawPart === 'object' && !Array.isArray(rawPart)) {
        const part = rawPart as Record<string, unknown>
        const normalizedPart: NonNullable<
          NonNullable<SandboxStreamEvent['data']>['part']
        > = {}
        if (typeof part.type === 'string') normalizedPart.type = part.type
        if (typeof part.text === 'string') normalizedPart.text = part.text
        if (Object.keys(normalizedPart).length > 0) data.part = normalizedPart
      }

      if (typeof dataRecord?.delta === 'string') data.delta = dataRecord.delta
      if (typeof dataRecord?.finalText === 'string') data.finalText = dataRecord.finalText
      if (typeof dataRecord?.code === 'string') data.code = dataRecord.code
      if (typeof dataRecord?.message === 'string') data.message = dataRecord.message
      const rawDetails = dataRecord?.details
      if (rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)) {
        data.details = rawDetails as Record<string, unknown>
      }

      const usageRecord = optionalGatewayRecord(dataRecord?.usage, 'usage')
      if (usageRecord) {
        const usage: NonNullable<NonNullable<SandboxStreamEvent['data']>['usage']> = {}
        for (const field of [
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
          'toolTokens',
          'toolCallCount',
        ] as const) {
          const value = optionalNonNegativeSafeInteger(usageRecord[field], `usage.${field}`)
          if (value !== undefined) usage[field] = value
        }
        const providerCostUsd = optionalNonNegativeNumber(
          usageRecord.providerCostUsd,
          'usage.providerCostUsd',
        )
        if (providerCostUsd !== undefined) usage.providerCostUsd = providerCostUsd
        if (usageRecord.budgetEnforced !== undefined) {
          if (typeof usageRecord.budgetEnforced !== 'boolean') {
            throw new Error('sandbox gateway event usage.budgetEnforced is invalid')
          }
          usage.budgetEnforced = usageRecord.budgetEnforced
        }
        if (Object.keys(usage).length > 0) data.usage = usage
      }

      const toolRecord = optionalGatewayRecord(dataRecord?.tool, 'tool')
      if (toolRecord) {
        const tool: NonNullable<NonNullable<SandboxStreamEvent['data']>['tool']> = {}
        if (typeof toolRecord.name === 'string') tool.name = toolRecord.name
        const inputTokens = optionalNonNegativeSafeInteger(toolRecord.inputTokens, 'tool.inputTokens')
        const outputTokens = optionalNonNegativeSafeInteger(toolRecord.outputTokens, 'tool.outputTokens')
        if (inputTokens !== undefined) tool.inputTokens = inputTokens
        if (outputTokens !== undefined) tool.outputTokens = outputTokens
        if (Object.keys(tool).length > 0) data.tool = tool
      }

      const reasoningRecord = optionalGatewayRecord(dataRecord?.reasoning, 'reasoning')
      if (reasoningRecord) {
        const tokens = optionalNonNegativeSafeInteger(
          reasoningRecord.tokens,
          'reasoning.tokens',
        )
        if (tokens !== undefined) data.reasoning = { tokens }
      }

      const rawInputRequired = dataRecord?.inputRequired
      if (
        rawInputRequired &&
        typeof rawInputRequired === 'object' &&
        !Array.isArray(rawInputRequired)
      ) {
        const prompt = (rawInputRequired as Record<string, unknown>).prompt
        data.inputRequired = typeof prompt === 'string' ? { prompt } : {}
      }

      yield {
        ...(typeof event.type === 'string' ? { type: event.type } : {}),
        ...(Object.keys(data).length > 0 ? { data } : {}),
      }
    }
  })()
}

// Severed-stream classifier. Generic to any router-backed harness: a final step
// that finished with error/other/unknown is a truncated turn, not a completed one.
const SEVERED_FINISH_REASONS = new Set(['error', 'other', 'unknown'])

/** Define transitions marking the start or finish of a sandbox step with associated details */
export type SandboxStepTransition =
  | { kind: 'step-start' }
  | { kind: 'step-finish'; reason: string; severed: boolean }

function asPlainRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Resolve the severed stream event to a corresponding sandbox step transition or null */
export function classifySeveredStream(event: unknown): SandboxStepTransition | null {
  const root = asPlainRecord(event)
  if (!root || root.type !== 'message.part.updated') return null
  const body = asPlainRecord(root.properties) ?? asPlainRecord(root.data) ?? root
  const part = asPlainRecord(body.part)
  if (!part) return null
  if (part.type === 'step-start') return { kind: 'step-start' }
  if (part.type !== 'step-finish') return null
  const reason = typeof part.reason === 'string' && part.reason ? part.reason : 'unknown'
  return { kind: 'step-finish', reason, severed: SEVERED_FINISH_REASONS.has(reason) }
}

/** A backend result or terminal event, excluding SDK cleanup after observation loss. */
export function isTerminalPromptEvent(event: unknown): boolean {
  const root = asPlainRecord(event)
  return root?.type === 'result' || (root?.type === 'done' && asPlainRecord(root.data)?.status !== 'failed')
}

// Interactive-question detector. Returns the question text or null. Used by
// streamSandboxPrompt when disallowQuestions is set.
/** Resolve the interactive question text from a structured event or return null if none found */
export function detectInteractiveQuestion(event: unknown): string | null {
  const root = asPlainRecord(event)
  if (!root) return null
  const type = typeof root.type === 'string' ? root.type : undefined
  const data = asPlainRecord(root.data)
  const props = asPlainRecord(root.properties)
  const body = props ?? data ?? root
  if (type === 'question.asked' || type === 'question') return firstQuestionText(body)
  // Generic structured-interaction event (BackendConfig.interactions kinds surface as
  // `interaction` events with a `kind` discriminator); treat kind:"question" as a question.
  if (type === 'interaction' && body.kind === 'question') return firstQuestionText(body)
  const part = asPlainRecord(data?.part) ?? asPlainRecord(body.part)
  const tool =
    (typeof part?.tool === 'string' && part.tool) ||
    (typeof part?.name === 'string' && part.name) ||
    (typeof body.tool === 'string' && body.tool) ||
    undefined
  const isQ =
    type === 'message.part.updated' &&
    (tool === 'question' || asPlainRecord(part)?.type === 'question')
  if (!isQ) return null
  const state = asPlainRecord(asPlainRecord(part)?.state)
  return firstQuestionText(asPlainRecord(state?.input) ?? state ?? part ?? body)
}

function firstQuestionText(value: Record<string, unknown> | null): string {
  const arr = Array.isArray(value?.questions)
    ? value!.questions
    : Array.isArray(asPlainRecord(value?.input)?.questions)
      ? (asPlainRecord(value!.input)!.questions as unknown[])
      : []
  const first = asPlainRecord(arr[0])
  const q =
    (typeof first?.question === 'string' && first.question) ||
    (typeof first?.prompt === 'string' && first.prompt) ||
    undefined
  return q ?? 'interactive question'
}
