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
        /** Provider-specific call data the next request must echo back. Gemini 3
         *  sends `{ google: { thought_signature } }` here and answers HTTP 400
         *  when a later request's assistant `tool_calls` entry lacks it. */
        extra_content?: unknown
      }>
    }
    finish_reason?: string | null
  }>
  /** A failure the service reports inside the stream (the Tangle Router's
   *  `empty_completion`, `reasoning_budget_exhausted`, `stream_idle_timeout`, …). */
  error?: { code?: string | null; message?: string | null; type?: string | null }
  /** Token accounting (requires `stream_options.include_usage`). Cumulative for
   *  the call: the Tangle Router can send it on more than one chunk. */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  } | null
}

interface PartialToolCall {
  id?: string
  name: string
  args: string
  extraContent?: unknown
  announced: boolean
}

/**
 * Map an OpenAI-compat streaming chunk iterator to `LoopEvent`s: each content
 * delta → a `text` event; tool-call deltas are accumulated by index across
 * chunks and emitted as one complete `tool_call` event when the stream finishes
 * (arguments JSON-parsed; an empty/garbled args string yields `{}` rather than
 * throwing). Works for the Tangle Router, tcloud, or any OpenAI-compat source.
 *
 * A call's `extra_content` is kept as `providerFields.extra_content`, which the
 * tool loop echoes on the call's assistant `tool_calls` entry in the next request.
 * Usage is cumulative per call and may arrive on several chunks, so it is
 * yielded once, the last value, when the stream ends.
 *
 * Each call also yields one `tool_call_start` as soon as its name arrives,
 * while its arguments are still streaming, so a caller can start work the call
 * will need. Providers send the whole name in the call's first delta.
 */
export async function* toLoopEvents(chunks: AsyncIterable<OpenAIStreamChunk>): AsyncIterable<LoopEvent> {
  const calls = new Map<number, PartialToolCall>()
  let usage: { promptTokens: number; completionTokens: number } | undefined
  for await (const chunk of chunks) {
    // Usage can ride a chunk with an empty choices array — read it before the
    // choice guard. Each report is cumulative, so the last one is the call's.
    if (chunk.usage?.prompt_tokens != null || chunk.usage?.completion_tokens != null) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const content = choice.delta?.content
    if (content) yield { type: 'text', text: content }
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.thinking
    if (reasoning) yield { type: 'reasoning', text: reasoning }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { name: '', args: '', announced: false }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      if (tc.extra_content !== undefined) cur.extraContent = tc.extra_content
      calls.set(tc.index, cur)
      if (!cur.announced && cur.name) {
        cur.announced = true
        yield { type: 'tool_call_start', ...(cur.id ? { toolCallId: cur.id } : {}), toolName: cur.name }
      }
    }
  }
  if (usage) yield { type: 'usage', usage }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue
    yield {
      type: 'tool_call',
      call: {
        toolCallId: c.id,
        toolName: c.name,
        args: safeParse(c.args),
        ...(c.extraContent !== undefined ? { providerFields: { extra_content: c.extraContent } } : {}),
      } satisfies LoopToolCall,
    }
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
  /** Extra request headers, e.g. a trace id the router records with the generation. */
  headers?: Record<string, string>
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
      }, opts.onServedModel ? { requestedModel: opts.model, report: opts.onServedModel } : undefined, opts.headers),
    )
}

/**
 * The buffered sibling of {@link createOpenAICompatStreamTurn}: one
 * `/chat/completions` request without `stream`, answered by one JSON
 * completion, yielded as the same `LoopEvent`s (the same tool-call assembly and
 * served-model attribution). For an endpoint or ledger that expects one buffered
 * completion per model call.
 */
export function createOpenAICompatCompletionTurn(
  opts: OpenAICompatStreamTurnOptions,
): (messages: LoopMessage[]) => AsyncIterable<LoopEvent> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  return (messages) =>
    toLoopEvents(
      completionAsChunk(doFetch, `${base}/chat/completions`, opts.apiKey, {
        model: opts.model,
        messages,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...opts.extraBody,
      }, opts.onServedModel ? { requestedModel: opts.model, report: opts.onServedModel } : undefined, opts.headers),
    )
}

/** One buffered OpenAI-compat completion (structural — no `openai` dep). */
interface OpenAICompletion {
  model?: string
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

async function* completionAsChunk(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  attribution?: { requestedModel: string; report: (served: OpenAICompatServedModel) => void },
  headers?: Record<string, string>,
): AsyncIterable<OpenAIStreamChunk> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await httpFailure(res, 'completion')
  const completion = await res.json() as OpenAICompletion
  if (attribution) {
    const served = servedFromHeader(res, attribution.requestedModel)
      ?? (completion.model ? servedFromBody(completion.model, attribution.requestedModel) : undefined)
    if (served) attribution.report(served)
  }
  const choice = completion.choices?.[0]
  const message = choice?.message
  // The whole completion as one chunk, so `toLoopEvents` assembles it exactly as a stream.
  yield {
    ...(completion.model ? { model: completion.model } : {}),
    choices: [{
      delta: {
        content: message?.content ?? null,
        reasoning_content: message?.reasoning_content ?? null,
        tool_calls: (message?.tool_calls ?? []).map((call, index) => ({
          index,
          ...(call.id ? { id: call.id } : {}),
          function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' },
          ...(call.extra_content !== undefined ? { extra_content: call.extra_content } : {}),
        })),
      },
      finish_reason: choice?.finish_reason ?? null,
    }],
    ...(completion.usage ? { usage: completion.usage } : {}),
  }
}

async function httpFailure(res: Response, kind: 'stream' | 'completion' | 'responses'): Promise<Error> {
  const text = res.body ? await res.text().catch(() => '') : ''
  const error = new Error(`OpenAI-compat ${kind} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 1000)}` : ''}`)
  // Stamp the NUMERIC status. `isUpstreamUnavailable` (`/model-resolution`)
  // reads a numeric field first and prose only as a backstop, and a
  // Cloudflare EDGE 502 gives it nothing else to read: `content-type:
  // text/plain`, a body of `error code: 502`, and none of the router's own
  // `x-tangle-*` headers, because the origin never ran. Carrying the status
  // as data keeps THIS path — the browser/edge copilot lane, which calls the
  // router directly — out of the string-matching business entirely.
  Object.assign(error, { status: res.status })
  return error
}

function servedFromHeader(res: Response, requestedModel: string): OpenAICompatServedModel | undefined {
  const servedHeader = res.headers.get('x-tangle-served-model')
  if (!servedHeader) return undefined
  return {
    requestedModel,
    servedModel: servedHeader,
    source: 'router_header',
    substituted: normalizeModelId(servedHeader) !== normalizeModelId(requestedModel),
    ...parseFailoverHeader(res.headers.get('x-tangle-failover')),
  }
}

function servedFromBody(model: string, requestedModel: string): OpenAICompatServedModel {
  return {
    requestedModel,
    servedModel: model,
    source: 'response_body',
    substituted: normalizeModelId(model) !== normalizeModelId(requestedModel),
  }
}

/** Stream + parse an OpenAI-compat SSE response into chunks. Tolerates `data:`
 *  framing, multi-line buffers, and the terminal `[DONE]`. */
async function* streamChatCompletions(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  attribution?: { requestedModel: string; report: (served: OpenAICompatServedModel) => void },
  headers?: Record<string, string>,
): AsyncIterable<OpenAIStreamChunk> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw await httpFailure(res, 'stream')
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
    const served = servedFromHeader(res, attribution.requestedModel)
    if (served) report(served)
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
      if (attribution && !reported && chunk.model) report(servedFromBody(chunk.model, attribution.requestedModel))
      // A failure inside a 200 stream ends the call by name instead of reading as a blank answer.
      if (chunk.error) throw streamFailure(chunk.error)
      yield chunk
    }
  }
}

/** The error a stream's own error frame becomes: its `code` and message, for the caller's failure categories. */
function streamFailure(failure: NonNullable<OpenAIStreamChunk['error']>): Error {
  const code = failure.code || failure.type || 'stream_error'
  return Object.assign(new Error(`OpenAI-compat stream failed: ${code}${failure.message ? `: ${failure.message.slice(0, 1000)}` : ''}`), { code, streamFailure: true })
}

/** OpenAI models answer reasoning summaries only on the Responses API; chat completions carry none. */
export function isOpenAIResponsesModel(model: string): boolean {
  return /^(?:openai\/)?(?:gpt-|o\d|chatgpt-)/i.test(model.trim())
}

/** The chat-completions history the tool loop keeps, as Responses `instructions` and `input` items. */
export function toResponsesInput(messages: LoopMessage[]): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructions: string[] = []
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : ''
    if (message.role === 'system') {
      if (content) instructions.push(content)
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: content })
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      if (content.trim()) input.push({ role: 'assistant', content })
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
    } else if (message.role === 'user' || message.role === 'assistant') {
      input.push({ role: message.role, content })
    }
  }
  return { ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), input }
}

/** Chat-completions tool definitions as Responses function tools. */
function toResponsesTools(tools: unknown[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).flatMap((tool) => {
    const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function
    return fn?.name ? [{ type: 'function', name: fn.name, ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters ?? { type: 'object', properties: {} } }] : []
  })
}

/**
 * Build a `streamTurn` on the OpenAI Responses API (`POST /responses`, streamed),
 * for OpenAI models whose reasoning reaches a caller only there, as
 * `response.reasoning_summary_text.delta` events. Each Responses event is
 * mapped onto the chat-completions chunk shape {@link toLoopEvents} reads, so
 * text, reasoning, fragmented function calls, usage and served-model
 * attribution behave exactly as on {@link createOpenAICompatStreamTurn}.
 *
 * `extraBody` keys from the chat path are translated: `max_tokens` and
 * `max_completion_tokens` become `max_output_tokens`, and `reasoning_effort`
 * becomes `reasoning.effort` with `summary: 'auto'`. Stateless: earlier tool
 * calls are replayed as `function_call` / `function_call_output` items.
 */
export function createOpenAIResponsesTurn(
  opts: OpenAICompatStreamTurnOptions,
): (messages: LoopMessage[]) => AsyncIterable<LoopEvent> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const { max_tokens: maxTokens, max_completion_tokens: maxCompletion, reasoning_effort: effort, ...rest } = opts.extraBody ?? {}
  const maxOutput = maxCompletion ?? maxTokens
  return (messages) => {
    const { instructions, input } = toResponsesInput(messages)
    const tools = toResponsesTools(opts.tools)
    return toLoopEvents(streamResponses(doFetch, `${base}/responses`, opts.apiKey, {
      model: opts.model,
      ...(instructions ? { instructions } : {}),
      input,
      stream: true,
      store: false,
      ...(tools.length ? { tools } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
      ...(effort !== undefined ? { reasoning: { effort, summary: 'auto' } } : {}),
      ...rest,
    }, opts.onServedModel ? { requestedModel: opts.model, report: opts.onServedModel } : undefined, opts.headers))
  }
}

interface ResponsesEvent {
  type?: string
  delta?: string
  output_index?: number
  summary_index?: number
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
  response?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } }
  error?: { code?: string; message?: string }
  message?: string
}

/** Stream a Responses API call as chat-completions chunks. A failed or errored response throws. */
async function* streamResponses(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  attribution?: { requestedModel: string; report: (served: OpenAICompatServedModel) => void },
  headers?: Record<string, string>,
): AsyncIterable<OpenAIStreamChunk> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw await httpFailure(res, 'responses')
  let reported = false
  const report = (served: OpenAICompatServedModel) => {
    if (reported || !attribution) return
    reported = true
    attribution.report(served)
  }
  if (attribution) {
    const served = servedFromHeader(res, attribution.requestedModel)
    if (served) report(served)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastSummary: string | null = null
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
      let event: ResponsesEvent
      try {
        event = JSON.parse(data) as ResponsesEvent
      } catch {
        continue
      }
      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) yield { choices: [{ delta: { content: event.delta } }] }
          break
        case 'response.reasoning_summary_text.delta': {
          if (!event.delta) break
          // Separate summary parts the way the model wrote them.
          const part = `${event.output_index ?? 0}:${event.summary_index ?? 0}`
          const lead = lastSummary !== null && lastSummary !== part ? '\n\n' : ''
          lastSummary = part
          yield { choices: [{ delta: { reasoning_content: lead + event.delta } }] }
          break
        }
        case 'response.output_item.added':
          if (event.item?.type === 'function_call' && event.item.name) {
            yield { choices: [{ delta: { tool_calls: [{ index: event.output_index ?? 0,
              ...(event.item.call_id ? { id: event.item.call_id } : {}),
              function: { name: event.item.name, arguments: event.item.arguments ?? '' } }] } }] }
          }
          break
        case 'response.function_call_arguments.delta':
          if (event.delta) yield { choices: [{ delta: { tool_calls: [{ index: event.output_index ?? 0, function: { arguments: event.delta } }] } }] }
          break
        case 'response.completed':
        case 'response.incomplete': {
          const model = event.response?.model
          if (attribution && !reported && model) report(servedFromBody(model, attribution.requestedModel))
          const usage = event.response?.usage
          yield { ...(model ? { model } : {}), choices: [],
            ...(usage ? { usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0 } } : {}) }
          return
        }
        case 'response.failed':
        case 'error': {
          const failure = event.response?.error ?? event.error ?? { message: event.message }
          throw new Error(`OpenAI-compat responses failed: ${(failure?.code ? `${failure.code}: ` : '') + (failure?.message ?? 'no detail')}`.slice(0, 300))
        }
        default:
          break
      }
    }
  }
}
