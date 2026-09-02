import type { SandboxStreamEvent } from '../sandbox/index'
import type { ChatTurnExecutionLimits, ChatTurnRoutes } from './turn-routes'
import { chatTurnRequestInit, type ChatTurnRequestPayload } from './wire'

export interface StreamChatRouteAsSandboxOptions {
  routes: ChatTurnRoutes
  request: Request
  payload: ChatTurnRequestPayload
  waitUntil?: (promise: Promise<unknown>) => void
  /** Stop forwarding when the API client disconnects. The persisted turn continues. */
  signal?: AbortSignal
  /** Limits authenticated by the gateway and forwarded to the producer. */
  executionLimits?: ChatTurnExecutionLimits
}

interface ParsedChatRouteEvent {
  type?: string
  data?: Record<string, unknown>
  text?: string
  usage?: Record<string, unknown>
  toolName?: string
}

type GatewayUsageUpdate = NonNullable<NonNullable<SandboxStreamEvent['data']>['usage']>

/**
 * Drive the normal persisted chat route and expose its events to an
 * agent-gateway sandbox adapter. The route remains the only turn owner: auth,
 * locking, live delivery, transcript writes, and completion hooks run once.
 */
export async function* streamChatRouteAsSandboxEvents(
  options: StreamChatRouteAsSandboxOptions,
): AsyncGenerator<SandboxStreamEvent> {
  const parentSignal = options.signal ?? options.request.signal
  if (parentSignal.aborted) return
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const stopForwarding = () => void reader?.cancel()
  parentSignal.addEventListener('abort', stopForwarding, { once: true })

  const request = new Request(options.request.url, {
    ...chatTurnRequestInit(options.payload),
    headers: options.request.headers,
  })
  request.headers.set('Content-Type', 'application/json')

  let complete = false
  try {
    const response = await options.routes.turn(
      request,
      {
        ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
        ...(options.executionLimits ? { executionLimits: options.executionLimits } : {}),
      },
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`chat route rejected the gateway turn (${response.status})`)
    }
    if (!response.body) throw new Error('chat route returned no stream')

    reader = response.body.getReader()
    if (parentSignal.aborted) {
      await reader.cancel().catch(() => undefined)
      return
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        complete = true
        buffer += decoder.decode()
        const event = toSandboxEvent(parseEvent(buffer))
        if (event) yield event
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = toSandboxEvent(parseEvent(line))
        if (event) yield event
      }
    }
  } finally {
    if (!complete) await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
    parentSignal.removeEventListener('abort', stopForwarding)
  }
}

function parseEvent(line: string): ParsedChatRouteEvent | null {
  if (!line.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('chat route returned invalid NDJSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('chat route returned a non-object event')
  }
  const event = value as Record<string, unknown>
  if (event.type !== undefined && typeof event.type !== 'string') {
    throw new Error('chat route returned an invalid event type')
  }
  const data = event.data
  if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('chat route returned invalid event data')
  }
  const dataUsage = data && (data as Record<string, unknown>).usage
  if (dataUsage !== undefined && (!dataUsage || typeof dataUsage !== 'object' || Array.isArray(dataUsage))) {
    throw new Error('chat route returned invalid data.usage')
  }
  if (event.text !== undefined && typeof event.text !== 'string') {
    throw new Error('chat route returned an invalid text event')
  }
  const usage = event.usage
  if (usage !== undefined && (!usage || typeof usage !== 'object' || Array.isArray(usage))) {
    throw new Error('chat route returned invalid usage')
  }
  if (event.toolName !== undefined && typeof event.toolName !== 'string') {
    throw new Error('chat route returned an invalid tool name')
  }
  return {
    ...(typeof event.type === 'string' ? { type: event.type } : {}),
    ...(data ? { data: data as SandboxStreamEvent['data'] } : {}),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
    ...(usage ? { usage: usage as Record<string, unknown> } : {}),
    ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function aliasedSafeInteger(
  usage: Record<string, unknown>,
  field: string,
  alias?: string,
): number | undefined {
  const value = usage[field]
  const aliasValue = alias ? usage[alias] : undefined
  for (const candidate of [value, aliasValue]) {
    if (candidate !== undefined && !isNonNegativeSafeInteger(candidate)) {
      throw new Error(`chat route returned invalid usage.${field}`)
    }
  }
  if (value !== undefined && aliasValue !== undefined && value !== aliasValue) {
    throw new Error(`chat route returned conflicting usage.${field}`)
  }
  return (value ?? aliasValue) as number | undefined
}

function aliasedNonNegativeNumber(
  usage: Record<string, unknown>,
  field: string,
  alias?: string,
): number | undefined {
  const value = usage[field]
  const aliasValue = alias ? usage[alias] : undefined
  for (const candidate of [value, aliasValue]) {
    if (
      candidate !== undefined &&
      (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)
    ) {
      throw new Error(`chat route returned invalid usage.${field}`)
    }
  }
  if (value !== undefined && aliasValue !== undefined && value !== aliasValue) {
    throw new Error(`chat route returned conflicting usage.${field}`)
  }
  return (value ?? aliasValue) as number | undefined
}

/** Preserve each measured field without inventing the fields the route lacks. */
function providerUsageUpdate(value: unknown): GatewayUsageUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const usage: GatewayUsageUpdate = {}
  const inputTokens = aliasedSafeInteger(source, 'inputTokens', 'promptTokens')
  const outputTokens = aliasedSafeInteger(source, 'outputTokens', 'completionTokens')
  const reasoningTokens = aliasedSafeInteger(source, 'reasoningTokens')
  const toolTokens = aliasedSafeInteger(source, 'toolTokens')
  const toolCallCount = aliasedSafeInteger(source, 'toolCallCount')
  const providerCostUsd = aliasedNonNegativeNumber(source, 'providerCostUsd', 'costUsd')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  if (toolTokens !== undefined) usage.toolTokens = toolTokens
  if (toolCallCount !== undefined) usage.toolCallCount = toolCallCount
  if (providerCostUsd !== undefined) usage.providerCostUsd = providerCostUsd
  if (source.budgetEnforced !== undefined) {
    if (typeof source.budgetEnforced !== 'boolean') {
      throw new Error('chat route returned invalid usage.budgetEnforced')
    }
    usage.budgetEnforced = source.budgetEnforced
  }
  return Object.keys(usage).length > 0 ? usage : null
}

/** Translate the app route's producer vocabulary to the gateway stream shape. */
function toSandboxEvent(event: ParsedChatRouteEvent | null): SandboxStreamEvent | null {
  if (!event) return null

  // `createChatTurnRoutes` emits flattened text events. The gateway's adapter
  // contract uses the sandbox's canonical part-update shape instead.
  if (event.type === 'text') {
    if (event.text === undefined) throw new Error('chat route text event had no text')
    return {
      type: 'message.part.updated',
      data: { part: { type: 'text' }, delta: event.text },
    }
  }

  // Reasoning is persisted by the app route but is not public API output.
  // Dropping it also prevents internal thought text from crossing the paid
  // gateway boundary.
  if (event.type === 'reasoning') return null

  // Preserve measured fields even when the app route cannot prove a complete
  // provider-enforced receipt. The gateway fills only absent legacy fields and
  // marks that completed receipt as not provider-enforced.
  if (event.type === 'usage' || event.usage || event.data?.usage) {
    const usage = providerUsageUpdate(event.usage ?? event.data?.usage)
    if (!usage) return null
    return { type: 'usage', data: { usage } }
  }

  // A producer can announce the same tool call twice while its arguments fill
  // in. The terminal tool result occurs once, so count that event instead.
  if (event.type === 'tool_result') {
    if (!event.toolName) throw new Error('chat route tool result had no tool name')
    return { type: 'tool_result', data: { tool: { name: event.toolName } } }
  }

  if (event.type === 'input-required' && !event.data?.inputRequired) {
    const prompt = typeof event.data?.prompt === 'string' ? event.data.prompt : undefined
    return {
      type: 'input-required',
      data: { inputRequired: prompt ? { prompt } : {} },
    }
  }

  return {
    ...(event.type ? { type: event.type } : {}),
    ...(event.data ? { data: event.data as SandboxStreamEvent['data'] } : {}),
  }
}
