import type { TurnSpan, TurnTrace } from './recorder'
import { parseServerTiming, serverTimingAttrs } from './server-timing'

const counters = new WeakMap<TurnTrace, Map<string, number>>()

/** 1-based count of `name` spans started through {@link nextCallIndex} on this trace. */
export function nextCallIndex(trace: TurnTrace, name: string): number {
  const byName = counters.get(trace) ?? new Map<string, number>()
  counters.set(trace, byName)
  const next = (byName.get(name) ?? 0) + 1
  byName.set(name, next)
  return next
}

export interface TracedModelFetchOptions {
  /** The span a model call hangs from. Default: the trace's root. */
  parent?: TurnSpan
  /** The model the request asks for. */
  model?: string
  /** Receives each model call's span as it starts, so the engine can add the token counts when usage arrives. */
  onSpan?: (span: TurnSpan) => void
}

/**
 * `fetch` for a model request, recording one `model.call` span per send: the
 * wall time from the request to the end of its body, the time to the first
 * byte, and the Router's own `Server-Timing` so the wait before the first byte
 * splits into network and server time.
 *
 * Children partition the call:
 * - `network`: the wait for headers, less the Router's server time;
 * - `router.pre_upstream`: the Router's work before its provider fetch
 *   (`upstream_start`);
 * - `router.upstream_wait`: the provider's time to response headers
 *   (`upstream_headers`);
 * - `model.stream`: headers to the end of the body.
 * Without a `Server-Timing` header the first byte's wait is one `model.wait`
 * span, because the split is not known.
 *
 * The response body is passed through unchanged; the span ends when the body
 * ends, errors or is cancelled.
 */
export function tracedModelFetch(trace: TurnTrace, inner: typeof fetch, options: TracedModelFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    const sentAt = Date.now()
    const span = trace.start('model.call', 'model', {
      'gen_ai.operation.name': 'chat',
      'call.index': nextCallIndex(trace, 'model.call'),
      ...(options.model ? { 'gen_ai.request.model': options.model } : {}),
    }, options.parent)
    options.onSpan?.(span)
    let response: Response
    try {
      response = await inner(input, init)
    } catch (error) {
      span.end({ 'http.failed': true }, error)
      throw error
    }
    const headersAt = Date.now()
    const timing = parseServerTiming(response.headers.get('server-timing'))
    const stamp = (name: string) => timing.find((entry) => entry.name === name)?.durMs
    const preUpstreamMs = stamp('upstream_start')
    const upstreamWaitMs = stamp('upstream_headers')
    const waitMs = headersAt - sentAt
    span.set({ 'http.status_code': response.status, ttfb_ms: waitMs, ...serverTimingAttrs(timing) })

    let firstByteAt: number | undefined
    const finish = (endedAt: number, error?: unknown, cancelled?: boolean) => {
      const known = preUpstreamMs !== undefined || upstreamWaitMs !== undefined
      if (known) {
        const serverMs = Math.min(waitMs, (preUpstreamMs ?? 0) + (upstreamWaitMs ?? 0))
        const networkMs = waitMs - serverMs
        let at = sentAt
        span.record('network', 'network', at, at + networkMs, { 'network.ms': Math.round(networkMs) })
        at += networkMs
        if (preUpstreamMs !== undefined) {
          const end = Math.min(headersAt, at + preUpstreamMs)
          span.record('router.pre_upstream', 'router', at, end)
          at = end
        }
        if (upstreamWaitMs !== undefined) span.record('router.upstream_wait', 'model', at, headersAt)
        span.set({ network_ms: Math.round(networkMs), router_server_ms: Math.round(serverMs) })
      } else {
        span.record('model.wait', 'model', sentAt, headersAt, { split: 'unknown' })
      }
      span.record('model.stream', 'model', headersAt, Math.max(headersAt, endedAt))
      const failure = error ?? (response.status >= 400 ? `http_${response.status}` : undefined)
      span.end({
        ...(firstByteAt !== undefined ? { ttft_ms: firstByteAt - sentAt } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      }, failure)
    }

    if (!response.body) {
      finish(headersAt)
      return response
    }
    const reader = response.body.getReader()
    let settled = false
    const settle = (error?: unknown, cancelled?: boolean) => {
      if (settled) return
      settled = true
      finish(Date.now(), error, cancelled)
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            settle()
            controller.close()
            return
          }
          firstByteAt ??= Date.now()
          controller.enqueue(value)
        } catch (error) {
          settle(error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        settle(undefined, true)
        await reader.cancel(reason)
      },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
