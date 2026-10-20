/** Stream framing, event inspection and cancellation around a chat producer. */
import type { ChatRouteEvent } from './turn-route-contracts'

/** Best-effort human-readable cause from a terminal `error` /
 *  `session.run.failed` event's `data`. */
export function failureReasonOf(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined
  const message = data.message ?? data.error ?? data.reason
  if (typeof message === 'string' && message.length > 0) return message
  return undefined
}

/** The typed reason a terminal `error` / `session.run.failed` event's `data`
 *  names, e.g. `sandbox.stream_failed` or an upstream code. */
export function failureCodeOf(data: Record<string, unknown> | undefined): string | undefined {
  const code = data?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/** A word the user sees: a producer `text` event, or a sandbox text part delta. */
export function isVisibleText(event: ChatRouteEvent): boolean {
  const value = event as ChatRouteEvent & { text?: unknown }
  if (event.type === 'text') return typeof value.text === 'string' ? value.text.trim().length > 0 : true
  if (event.type !== 'message.part.updated') return false
  const part = event.data?.part as { type?: unknown } | undefined
  const delta = event.data?.delta
  return part?.type === 'text' && typeof delta === 'string' && delta.trim().length > 0
}

/** Output rendered by either lane; admission/status/usage events are not model output. */
export function isVisibleOutput(event: ChatRouteEvent): boolean {
  if (isVisibleText(event)) return true
  const value = event as ChatRouteEvent & { text?: unknown }
  if (event.type === 'reasoning') return typeof value.text === 'string' && value.text.trim().length > 0
  if (event.type === 'tool_call' || event.type === 'tool.call' || event.type === 'tool_result' || event.type === 'tool.result' || event.type === 'tool.event') return true
  if (event.type !== 'message.part.updated') return false
  const part = event.data?.part as { type?: unknown; text?: unknown } | undefined
  if (part?.type === 'tool') return true
  if (part?.type !== 'reasoning' && part?.type !== 'text') return false
  const text = event.data?.delta ?? part.text
  return typeof text === 'string' && text.trim().length > 0
}

// ── producer-stream wrappers (heartbeat + raw tap) ───────────────────────────

/** Fire `onRawEvent` for each producer event, before the engine frames it.
 *  Best-effort — a telemetry throw is logged, never propagated. */
export async function* tapRawEvents(
  source: AsyncIterable<ChatRouteEvent>,
  onRawEvent: (event: ChatRouteEvent) => void | Promise<void>,
  log: (message: string, meta?: Record<string, unknown>) => void,
): AsyncGenerator<ChatRouteEvent, void, unknown> {
  for await (const event of source) {
    try {
      await onRawEvent(event)
    } catch (err) {
      log('[chat-routes] onRawEvent failed', { error: err instanceof Error ? err.message : String(err) })
    }
    yield event
  }
}

/** Inject a keepalive whenever `intervalMs` elapses with no source event. The
 *  silent window (elapsed + tick) resets on every real event, so a producer
 *  that keeps emitting never triggers a heartbeat. Closes the source on early
 *  return, matching a `for await` over it. */
export async function* withStreamHeartbeat(
  source: AsyncIterable<ChatRouteEvent>,
  intervalMs: number,
  makeEvent: (info: { elapsedMs: number; tick: number }) => ChatRouteEvent,
): AsyncGenerator<ChatRouteEvent, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    let pending = iterator.next()
    let windowStart = Date.now()
    let tick = 0
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let winner: 'event' | 'heartbeat'
      try {
        const heartbeat = new Promise<'heartbeat'>((resolve) => {
          timer = setTimeout(() => resolve('heartbeat'), intervalMs)
        })
        winner = await Promise.race([pending.then(() => 'event' as const), heartbeat])
      } finally {
        // Clear the pending timer on EVERY exit — including a `pending`
        // rejection — so a rejected source never orphans a setTimeout that
        // keeps the runtime alive for up to `intervalMs`.
        if (timer !== undefined) clearTimeout(timer)
      }
      if (winner === 'heartbeat') {
        tick += 1
        yield makeEvent({ elapsedMs: Date.now() - windowStart, tick })
        continue
      }
      const result = await pending
      if (result.done) return
      yield result.value
      pending = iterator.next()
      windowStart = Date.now()
      tick = 0
    }
  } finally {
    await iterator.return?.()
  }
}

/** Sequential concat of byte streams (marker line, then the engine body). */
export function concatStreams(streams: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  let index = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          const next = streams[index++]
          if (!next) {
            controller.close()
            return
          }
          reader = next.getReader()
        }
        const { done, value } = await reader.read()
        if (done) {
          reader = null
          continue
        }
        controller.enqueue(value)
        return
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
      for (const stream of streams.slice(index)) await stream.cancel(reason)
    },
  })
}

/**
 * Stop a producer pull as soon as an opted-in caller disconnects.
 * `AsyncIterator.return()` alone cannot interrupt a pending `next()` call, so
 * race each pull with the request signal and close the source in `finally`.
 */
export async function* abortOnSignal<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    await closeIteratorAfterAbort(iterator)
  }
}

function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(new Error('chat turn cancelled'))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('chat turn cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(result)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
      )
  })
}

const ABORT_CLEANUP_TIMEOUT_MS = 50

async function closeIteratorAfterAbort<T>(iterator: AsyncIterator<T>): Promise<void> {
  let closing: PromiseLike<unknown> | undefined
  try {
    const result = iterator.return?.()
    if (result) closing = Promise.resolve(result)
  } catch {
    return
  }
  if (!closing) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(closing).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, ABORT_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
