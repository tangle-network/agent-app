/**
 * OpenAI-compatible stream → `LoopEvent` adapter, for NON-sandbox copilots.
 *
 * `streamAppToolLoop` takes a `streamTurn` seam that yields `LoopEvent`s. A
 * sandboxed agent produces those from its container; a browser/edge copilot
 * instead calls a model directly. The Tangle Router, the tcloud SDK, and most
 * providers all speak the OpenAI Chat Completions streaming shape — so the ONE
 * reusable piece is assembling that stream (content deltas + FRAGMENTED
 * tool-call deltas) into `LoopEvent`s. That assembly is the boilerplate every
 * copilot would re-write (and get wrong — OpenAI streams tool-call arguments in
 * pieces across chunks).
 *
 * This does NOT implement an HTTP client beyond a minimal `fetch` + SSE reader
 * (browser/edge/Node-safe, zero deps). For richer transport use the tcloud SDK
 * or the Vercel AI SDK and pipe their stream through {@link toLoopEvents}.
 */
import type { LoopEvent, LoopMessage, LoopToolCall } from './loop'
import { normalizeModelId } from './model-catalog'

/** Minimal OpenAI Chat Completions streaming chunk (structural — no `openai` dep). */
export interface OpenAIStreamChunk {
  /** The model that produced this chunk. The Tangle Router reports the DATED
   *  upstream id here (`gpt-5-2025-08-07`) whether or not it substituted, so
   *  this is a served-model source only after id folding — see
   *  {@link OpenAICompatServedModel}. */
  model?: string
  choices?: Array<{
    delta?: {
      content?: string | null
      /** Reasoning deltas — DeepSeek/router use `reasoning_content`; some proxies use `thinking`. */
      reasoning_content?: string | null
      thinking?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  /** Final-chunk token accounting (requires `stream_options.include_usage`). */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  } | null
}

interface PartialToolCall {
  id?: string
  name: string
  args: string
}

/**
 * Map an OpenAI-compat streaming chunk iterator to `LoopEvent`s: each content
 * delta → a `text` event; tool-call deltas are accumulated by index across
 * chunks and emitted as one complete `tool_call` event when the stream finishes
 * (arguments JSON-parsed; an empty/garbled args string yields `{}` rather than
 * throwing). Works for the Tangle Router, tcloud, or any OpenAI-compat source.
 */
export async function* toLoopEvents(chunks: AsyncIterable<OpenAIStreamChunk>): AsyncIterable<LoopEvent> {
  const calls = new Map<number, PartialToolCall>()
  for await (const chunk of chunks) {
    // Usage rides the final chunk, which has an empty choices array — handle
    // it before the choice guard.
    if (chunk.usage?.prompt_tokens != null || chunk.usage?.completion_tokens != null) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        },
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const content = choice.delta?.content
    if (content) yield { type: 'text', text: content }
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.thinking
    if (reasoning) yield { type: 'reasoning', text: reasoning }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(tc.index, cur)
    }
  }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue
    yield { type: 'tool_call', call: { toolCallId: c.id, toolName: c.name, args: safeParse(c.args) } satisfies LoopToolCall }
  }
}

function safeParse(s: string): Record<string, unknown> {
  if (!s.trim()) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Which model actually served one direct-router turn.
 *
 * The router substitutes models on purpose — a quota-walled primary comes back
 * `200` answered by a different model — and says so in response headers. This
 * lane used to drop the whole `Response` after taking `.body`, so a turn
 * requested as `claude-sonnet-4-6` and answered by `openai/gpt-5` was recorded
 * by its caller as Claude: per-model quality scoring blamed the wrong model and
 * cost used the wrong price basis.
 *
 * Map this onto the shell's existing attribution contract rather than inventing
 * a second channel — `ChatTurnRouteProducer.modelAttribution()` (`/chat-routes`):
 *
 *     modelAttribution: () => ({ requestedModel, servedModel, echoReceived: true })
 *
 * Leave that contract's `servedSource` unset: its union is sandbox
 * profile-resolution vocabulary with no router analogue.
 */
export interface OpenAICompatServedModel {
  /** The model id this turn asked for (`OpenAICompatStreamTurnOptions.model`). */
  requestedModel: string
  /** The model the router/provider reports having actually served. */
  servedModel: string
  /** Where `servedModel` was read from. The header is the router's own
   *  substitution signal; the body is the backstop that survives CORS. */
  source: 'router_header' | 'response_body'
  /** True when served differs from requested after id folding. Folded, not
   *  compared raw: the body reports a dated id on EVERY turn, so `!==` would
   *  claim a substitution every time. */
  substituted: boolean
  /** `x-tangle-failover` `trigger=` — why the router swapped. Absent when the
   *  router did not inject the substitute (a caller-supplied fallback chain
   *  sets the served-model header without the failover one). */
  trigger?: string
  /** `x-tangle-failover` `degraded=`. */
  degraded?: boolean
}

/** Parse `from=…; to=…; trigger=…; degraded=…` down to the fields we report.
 *  Absent/garbled segments are simply omitted — attribution is best-effort and
 *  must never fail a turn that is otherwise streaming fine. */
function parseFailoverHeader(raw: string | null): { trigger?: string; degraded?: boolean } {
  if (!raw) return {}
  const fields = new Map<string, string>()
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    fields.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim())
  }
  const trigger = fields.get('trigger')
  const degraded = fields.get('degraded')
  return {
    ...(trigger ? { trigger } : {}),
    ...(degraded != null ? { degraded: degraded === 'true' } : {}),
  }
}

/** Define options for configuring an OpenAI-compatible streaming chat turn including API details and tools */
export interface OpenAICompatStreamTurnOptions {
  /** OpenAI-compat base URL (e.g. the Tangle Router `https://router.tangle.tools/v1`). */
  baseUrl: string
  apiKey: string
  model: string
  /** OpenAI tool definitions — pass `buildAppToolOpenAITools(taxonomy)` so the
   *  model can call the app tools. Omit for a tool-free copilot. */
  tools?: unknown[]
  temperature?: number
  fetchImpl?: typeof fetch
  /** Extra body fields (e.g. `max_tokens`). */
  extraBody?: Record<string, unknown>
  /**
   * Called at most ONCE per turn, as soon as the serving model is
   * determinable, with what actually answered. Never called when neither the
   * header nor the body names a model — silence means "learned nothing", not
   * "nothing was substituted".
   *
   * `streamTurn` runs once per TOOL turn, so a multi-turn `runAppToolLoop`
   * fires this once per turn; take the last for row attribution.
   */
  onServedModel?: (served: OpenAICompatServedModel) => void
}

/**
 * Build a `streamTurn` that calls an OpenAI-compatible `/chat/completions`
 * endpoint (Tangle Router / tcloud / any compat provider) with `stream: true`
 * and yields `LoopEvent`s via {@link toLoopEvents}. Browser/edge/Node-safe —
 * just `fetch` + an SSE reader. Drop straight into `streamAppToolLoop`:
 *
 *   const cfg = resolveTangleModelConfig()                 // or { baseUrl, apiKey, model }
 *   streamAppToolLoop({ streamTurn: createOpenAICompatStreamTurn({ ...cfg, tools }), executeToolCall, ... })
 */
export function createOpenAICompatStreamTurn(
  opts: OpenAICompatStreamTurnOptions,
): (messages: LoopMessage[]) => AsyncIterable<LoopEvent> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  return (messages) =>
    toLoopEvents(
      streamChatCompletions(doFetch, `${base}/chat/completions`, opts.apiKey, {
        model: opts.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...opts.extraBody,
      }, opts.onServedModel ? { requestedModel: opts.model, report: opts.onServedModel } : undefined),
    )
}

/** Stream + parse an OpenAI-compat SSE response into chunks. Tolerates `data:`
 *  framing, multi-line buffers, and the terminal `[DONE]`. */
async function* streamChatCompletions(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  attribution?: { requestedModel: string; report: (served: OpenAICompatServedModel) => void },
): AsyncIterable<OpenAIStreamChunk> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text().catch(() => '') : ''
    const error = new Error(`OpenAI-compat stream failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
    // Stamp the NUMERIC status. `isUpstreamUnavailable` (`/model-resolution`)
    // reads a numeric field first and prose only as a backstop, and a
    // Cloudflare EDGE 502 gives it nothing else to read: `content-type:
    // text/plain`, a body of `error code: 502`, and none of the router's own
    // `x-tangle-*` headers, because the origin never ran. Carrying the status
    // as data keeps THIS path — the browser/edge copilot lane, which calls the
    // router directly — out of the string-matching business entirely.
    Object.assign(error, { status: res.status })
    throw error
  }
  // Served-model attribution, fired at most once, as early as it is knowable.
  //
  // The header comes first because it is the router's OWN substitution signal:
  // `X-Tangle-Served-Model` is set only when the served model differs from the
  // requested one, so its presence is authoritative and it arrives before the
  // first byte of content. `X-Tangle-Failover` rides along only when the router
  // itself picked the substitute (a caller-supplied fallback chain sets the
  // former without the latter), which is why `trigger`/`degraded` are optional.
  //
  // The body is the backstop for when the header cannot reach us. In a BROWSER,
  // headers are invisible to JS unless the server lists them in
  // `Access-Control-Expose-Headers` — tangle-router#324 added both, but that
  // only helps once it is DEPLOYED, and any other OpenAI-compat endpoint
  // pointed at this client exposes nothing. The chunk `model` field is not
  // subject to CORS, so it keeps the browser lane attributable regardless.
  let reported = false
  const report = (served: OpenAICompatServedModel): void => {
    if (reported || !attribution) return
    reported = true
    attribution.report(served)
  }
  if (attribution) {
    const servedHeader = res.headers.get('x-tangle-served-model')
    if (servedHeader) {
      report({
        requestedModel: attribution.requestedModel,
        servedModel: servedHeader,
        source: 'router_header',
        substituted: normalizeModelId(servedHeader) !== normalizeModelId(attribution.requestedModel),
        ...parseFailoverHeader(res.headers.get('x-tangle-failover')),
      })
    }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk
      } catch {
        continue /* skip a partial/garbled SSE frame */
      }
      // Body fallback: only when the header said nothing. Fold both ids before
      // comparing — the router reports the dated upstream id (`gpt-5-2025-08-07`)
      // for a request of `openai/gpt-5` even with NO substitution, so a raw
      // `!==` would report a swap on literally every turn.
      if (attribution && !reported && chunk.model) {
        report({
          requestedModel: attribution.requestedModel,
          servedModel: chunk.model,
          source: 'response_body',
          substituted: normalizeModelId(chunk.model) !== normalizeModelId(attribution.requestedModel),
        })
      }
      yield chunk
    }
  }
}
