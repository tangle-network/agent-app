import type { SandboxStreamEvent } from '../sandbox/index'
import type { ChatTurnRoutes } from './turn-routes'
import { chatTurnRequestInit, type ChatTurnRequestPayload } from './wire'

export interface StreamChatRouteAsSandboxOptions {
  routes: ChatTurnRoutes
  request: Request
  payload: ChatTurnRequestPayload
  waitUntil?: (promise: Promise<unknown>) => void
  /** Abort the in-process route when the gateway client disconnects. */
  signal?: AbortSignal
}

interface ParsedChatRouteEvent {
  type?: string
  data?: Record<string, unknown>
  text?: string
}

/**
 * Drive the normal persisted chat route and expose its events to an
 * agent-gateway sandbox adapter. The route remains the only turn owner: auth,
 * locking, live delivery, transcript writes, and completion hooks run once.
 */
export async function* streamChatRouteAsSandboxEvents(
  options: StreamChatRouteAsSandboxOptions,
): AsyncGenerator<SandboxStreamEvent> {
  const routeAbort = new AbortController()
  const parentSignal = options.signal ?? options.request.signal
  const abortRoute = () => routeAbort.abort()
  if (parentSignal.aborted) abortRoute()
  else parentSignal.addEventListener('abort', abortRoute, { once: true })

  const request = new Request(options.request.url, {
    ...chatTurnRequestInit(options.payload),
    headers: options.request.headers,
    signal: routeAbort.signal,
  })
  request.headers.set('Content-Type', 'application/json')

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let complete = false
  try {
    const response = await options.routes.turn(
      request,
      {
        cancelOnDisconnect: true,
        ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      },
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`chat route rejected the gateway turn (${response.status})`)
    }
    if (!response.body) throw new Error('chat route returned no stream')

    reader = response.body.getReader()
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
    if (!complete) {
      routeAbort.abort()
      await reader?.cancel().catch(() => undefined)
    }
    reader?.releaseLock()
    parentSignal.removeEventListener('abort', abortRoute)
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
  if (event.text !== undefined && typeof event.text !== 'string') {
    throw new Error('chat route returned an invalid text event')
  }
  return {
    ...(typeof event.type === 'string' ? { type: event.type } : {}),
    ...(data ? { data: data as SandboxStreamEvent['data'] } : {}),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
  }
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
  if (event.type === 'reasoning' || event.type === 'usage') return null

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
