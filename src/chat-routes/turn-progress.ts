/**
 * Turn progress: the real stage a chat turn is in, on the turn stream.
 *
 * A turn can spend seconds before its first answer token: authorization, the
 * conversation load, the single-flight lock, the product's pre-turn work, a
 * sandbox, the harness and the model's first token. `session.run.phase` events
 * name those stages as they happen, so a chat shows where the turn is instead
 * of a spinner.
 *
 * A client that sends {@link TURN_PROGRESS_HEADER} gets the response stream as
 * soon as the request is parsed, before authorization. Anything the route
 * would have answered with a non-stream response (a 401, 402, 409, 429, a
 * gate's own response) then arrives as one {@link TURN_RESPONSE_EVENT} carrying
 * that response's status, headers and body, and {@link settleTurnResponse}
 * turns it back into the `Response` the caller already handles. A client that
 * does not send the header gets exactly the responses it got before.
 *
 * Browser-safe and import-free: the server route and the web client share it.
 */

/** Request header that asks for a progress-first turn stream. */
export const TURN_PROGRESS_HEADER = 'x-turn-progress'
/** The only value of {@link TURN_PROGRESS_HEADER}. The route echoes it on a progress-first response. */
export const TURN_PROGRESS_FIRST = 'first'

/** Stream event naming the turn's current stage. Non-terminal and never turn content. */
export const TURN_PHASE_EVENT = 'session.run.phase'

/**
 * Stages the shared route emits before the producer runs. Products add their
 * own (a sandbox product emits `provisioning`, `starting`,
 * `awaiting-first-token`).
 * - `accepted`: the request is parsed; access and the conversation are loading.
 * - `preparing`: the turn holds its lock; the product's pre-turn work is running.
 */
export type TurnRoutePhase = 'accepted' | 'preparing'

/** The data of a {@link TURN_PHASE_EVENT}. */
export type TurnPhaseData = {
  /** Stage id: a {@link TurnRoutePhase} or a product's own stage. */
  phase: string
  /** Text the client shows verbatim. */
  message: string
  /** A keepalive for the current stage rather than a new stage. */
  heartbeat?: boolean
  /** Milliseconds since the current wait began. */
  elapsedMs?: number
  /** Milliseconds since the server received the request. */
  sinceRequestMs?: number
}

/** A {@link TURN_PHASE_EVENT} as it crosses the wire. */
export type TurnPhaseEvent = { type: typeof TURN_PHASE_EVENT; data: TurnPhaseData }

/** Default text for the route's own stages. Products override it through `createChatTurnRoutes({ progressMessages })`. */
export const TURN_ROUTE_PHASE_MESSAGES: Record<TurnRoutePhase, string> = {
  accepted: 'Loading your conversation…',
  preparing: 'Preparing the agent…',
}

/** Build a {@link TURN_PHASE_EVENT}. */
export function buildTurnPhaseEvent(
  phase: string,
  message: string,
  opts: { heartbeat?: boolean; elapsedMs?: number; sinceRequestMs?: number } = {},
): TurnPhaseEvent {
  return {
    type: TURN_PHASE_EVENT,
    data: {
      phase,
      message,
      ...(opts.heartbeat ? { heartbeat: true } : {}),
      ...(typeof opts.elapsedMs === 'number' ? { elapsedMs: opts.elapsedMs } : {}),
      ...(typeof opts.sinceRequestMs === 'number' ? { sinceRequestMs: opts.sinceRequestMs } : {}),
    },
  }
}

/** True for a {@link TURN_PHASE_EVENT} with a usable `phase` and `message`. */
export function isTurnPhaseEvent(event: unknown): event is TurnPhaseEvent {
  if (!event || typeof event !== 'object') return false
  const candidate = event as { type?: unknown; data?: { phase?: unknown; message?: unknown } }
  return candidate.type === TURN_PHASE_EVENT
    && typeof candidate.data?.phase === 'string'
    && typeof candidate.data?.message === 'string'
}

/** Terminal event of a progress-first stream that ended without a turn: the response the route returned instead. */
export const TURN_RESPONSE_EVENT = 'turn.response'

/** The data of a {@link TURN_RESPONSE_EVENT}. */
export type TurnResponseData = {
  status: number
  /** Response headers other than `set-cookie` and framing headers. */
  headers: Record<string, string>
  body: string
}

/** Headers a {@link TURN_RESPONSE_EVENT} cannot carry: cookies cannot be set after the stream opened, and framing belongs to the outer response. */
const UNCARRIED_HEADERS = new Set(['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection'])

/** Error code {@link settleTurnResponse} reports when a progress-first stream closes before the turn started. */
export const TURN_STREAM_LOST_CODE = 'turn_stream_lost'

/** Serialize a non-stream response for a {@link TURN_RESPONSE_EVENT}. */
export async function turnResponseEventFor(response: Response): Promise<{ type: typeof TURN_RESPONSE_EVENT; data: TurnResponseData }> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (!UNCARRIED_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = value
  })
  return { type: TURN_RESPONSE_EVENT, data: { status: response.status, headers, body: await response.text() } }
}

/**
 * Settle a turn response for a client that sent {@link TURN_PROGRESS_HEADER}.
 *
 * Reads the stream's leading progress events, handing each to `onPhase`, until
 * the first other event. A {@link TURN_RESPONSE_EVENT} resolves to a `Response`
 * with the original status, headers and body, so the caller's existing error
 * handling runs unchanged. Any other event resolves to a `Response` whose body
 * starts at that event and continues with the rest of the stream. A response
 * that is not progress-first is returned as it is.
 */
export async function settleTurnResponse(
  response: Response,
  onPhase: (phase: TurnPhaseData) => void,
): Promise<Response> {
  if (response.headers.get(TURN_PROGRESS_HEADER) !== TURN_PROGRESS_FIRST || !response.body) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let ended = false
  for (;;) {
    let newline = buffer.indexOf('\n')
    while (newline < 0) {
      if (ended) {
        // The stream closed inside the progress prefix: the turn never started.
        return Response.json(
          { error: 'The connection closed before the turn started. Try again.', code: TURN_STREAM_LOST_CODE },
          { status: 502 },
        )
      }
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        buffer += decoder.decode()
        // A final line without its newline is still a line.
        if (buffer.trim()) buffer += '\n'
      } else {
        buffer += decoder.decode(value, { stream: true })
      }
      newline = buffer.indexOf('\n')
    }
    const line = buffer.slice(0, newline).trim()
    if (!line) {
      buffer = buffer.slice(newline + 1)
      continue
    }
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      event = null
    }
    if (isTurnPhaseEvent(event)) {
      buffer = buffer.slice(newline + 1)
      onPhase(event.data)
      continue
    }
    const answered = event as { type?: unknown; data?: Partial<TurnResponseData> } | null
    if (answered?.type === TURN_RESPONSE_EVENT && typeof answered.data?.status === 'number') {
      await reader.cancel().catch(() => {})
      return new Response(answered.data.status === 204 || answered.data.status === 304 ? null : String(answered.data.body ?? ''), {
        status: answered.data.status,
        headers: answered.data.headers ?? {},
      })
    }
    return streamFrom(reader, buffer, encoder, response)
  }
}

/** The rest of a progress-first stream, starting with bytes already read. */
function streamFrom(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: string,
  encoder: TextEncoder,
  original: Response,
): Response {
  let first = pending
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        controller.enqueue(encoder.encode(first))
        first = ''
        return
      }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: original.status, headers: original.headers })
}
