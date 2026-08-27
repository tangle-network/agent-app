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

/** Minimal OpenAI Chat Completions streaming chunk (structural — no `openai` dep). */
export interface OpenAIStreamChunk {
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
      }),
    )
}

/** Stream + parse an OpenAI-compat SSE response into chunks. Tolerates `data:`
 *  framing, multi-line buffers, and the terminal `[DONE]`. */
async function* streamChatCompletions(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): AsyncIterable<OpenAIStreamChunk> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text().catch(() => '') : ''
    throw new Error(`OpenAI-compat stream failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
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
      try {
        yield JSON.parse(data) as OpenAIStreamChunk
      } catch {
        /* skip a partial/garbled SSE frame */
      }
    }
  }
}
