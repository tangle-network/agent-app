/**
 * One conversational turn answered by a model through the Tangle Router, with
 * the app's own tools executed in-process — no sandbox in the path.
 *
 * This is the default runtime for conversational turns in an agent app: the
 * product supplies the principal's tools, the profile prompt and the
 * conversation; the engine streams words as the model writes them, runs tool
 * calls through the bounded `streamAppToolLoop`, and returns one outcome.
 * Long, file or code work belongs to the sandbox, reached through a tool the
 * product adds to `tools`.
 *
 * Every failure is an outcome, never a throw. A durable turn owner retries
 * thrown errors, and a retry after a tool ran would repeat that tool's effect
 * ("never re-run a turn automatically", docs/agent-app-lessons.md). The only
 * automatic repeat is one model call that failed before any word or tool.
 */
import { streamAppToolLoop, type LoopEvent, type LoopMessage, type LoopToolCall, type ToolLoopStopReason } from './loop'
import { DEFAULT_TANGLE_ROUTER_BASE_URL } from './model'
import { createOpenAICompatStreamTurn } from './openai-stream'

/** A tool the turn may call. Structurally an `McpToolDefinition` whose env is already bound. */
export interface RouterTurnTool {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<unknown>
}

/** What the turn is doing, in the order it happens, for a live view. */
export type RouterTurnEvent =
  | { type: 'text'; segment: number; delta: string }
  /** Hidden reasoning the model streamed (`reasoning_content` / `thinking`), for a thinking view. */
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; callId: string; toolName: string; status: 'running'; input: Record<string, unknown>; startedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'completed'; output: unknown; startedAt: number; endedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'error'; error: { code: string; message: string }; startedAt: number; endedAt: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number }

export interface RouterTurnFailure {
  /** `model_http_<status>`, `model_unavailable`, `model_empty`, `turn_<stopReason>`, `turn_aborted`
   *  or `router_unconfigured`. */
  code: string
  status?: number
  message: string
}

export interface RouterTurnOutcome {
  /** Every text segment the model wrote, joined by blank lines. */
  text: string
  /** The model the router reports having served, when it said. */
  servedModel: string | null
  toolCalls: Array<{ callId: string; toolName: string; ok: boolean }>
  /** Token use summed over every model call in the turn, as the router reported it. */
  usage: { promptTokens: number; completionTokens: number; modelCalls: number }
  failure?: RouterTurnFailure
}

export interface RouterTurnOptions {
  apiKey: string
  model: string
  /** Defaults to the Tangle Router. */
  baseUrl?: string
  systemPrompt: string
  userMessage: string
  /** Earlier turns. Plain text messages, or OpenAI function-calling history (an assistant message
   *  carrying `tool_calls` and the `tool` messages answering them) so the model sees what it did. */
  history?: Array<{ role: 'user' | 'assistant'; content: string } | LoopMessage>
  tools?: RouterTurnTool[]
  /** Wall-clock budget in ms. Default 90 s. A caller whose retry window is shorter passes less. */
  budgetMs?: number
  /** Runaway backstop on model turns. Default 12. */
  maxToolTurns?: number
  maxTokens?: number
  /** Sent as `x-tangle-trace-id` so the router's generation joins the app's trace. */
  traceId?: string
  fetchImpl?: typeof fetch
  onEvent?: (event: RouterTurnEvent) => void
  /** Map a thrown tool error to what the model reads. Default: an error carrying string `code`
   *  (and numeric `status`) is reported with its message; anything else is a generic failure. */
  toolError?: (error: unknown) => { code: string; message: string; status?: number } | null
  /** Called for a tool failure the default mapping hides from the model, for the app's logs. */
  onToolFailure?: (toolName: string, error: unknown) => void
  /** Cancels the turn: the model call in flight is aborted, no further tool starts, and the
   *  outcome carries `turn_aborted`. Effects of tools that already ran are kept. */
  signal?: AbortSignal
  temperature?: number
  /** Models tried in order when a model call fails before any word or tool, or answers blank.
   *  Without it, that safe repeat uses `model` again. */
  fallbackModels?: readonly string[]
  /** Default true: one repeat of a model call that failed before any word or tool, and of a
   *  blank answer, on the next model in the chain. Pass false when a second billable call
   *  needs the caller's own decision; the failure is then returned as it happened. */
  repeat?: boolean
  /** Resend one model request that answered 408, 425, 429 or 5xx, or failed to connect, with
   *  exponential backoff. Nothing has streamed yet, so a resend repeats no word and no tool.
   *  `attempts` counts the first send (default 1, no resend); `timeoutMs` bounds each attempt,
   *  stream included. */
  retry?: { attempts?: number; timeoutMs?: number; baseDelayMs?: number }
  /** Characters of one tool result the model reads. Default 12 000. */
  toolResultLimit?: number
  /** Replace the text the model reads for one tool result (the app's own wording for an
   *  approval or refusal). `toolName` is the app's name, not the function name. */
  renderToolResult?: (toolName: string, outcome: { ok: true; result: unknown } | { ok: false; code: string; message: string }) => string
}

const DEFAULT_BUDGET_MS = 90_000
const TOOL_RESULT_LIMIT = 12_000
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_RETRY_DELAY_MS = 8_000

/** OpenAI-compatible function names allow only `[A-Za-z0-9_-]{1,64}`; app tool names often use dots. */
export function routerFunctionName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/**
 * The lean system prompt for a Router turn: the profile's system prompt and
 * instructions, then caller context, with tool names rewritten to the function
 * names the model actually calls.
 */
export function composeRouterTurnPrompt(
  profile: { prompt?: { systemPrompt?: string; instructions?: readonly string[] } },
  options: { context?: readonly string[]; toolNames?: readonly string[] } = {},
): string {
  const text = [profile.prompt?.systemPrompt ?? '', ...(profile.prompt?.instructions ?? []), ...(options.context ?? [])]
    .filter(part => part.trim()).join('\n\n')
  return [...(options.toolNames ?? [])].sort((a, b) => b.length - a.length)
    .reduce((out, name) => out.split(name).join(routerFunctionName(name)), text)
}

function defaultToolError(error: unknown): { code: string; message: string; status?: number } | null {
  const value = error as { code?: unknown; status?: unknown; message?: unknown; issues?: unknown }
  if (Array.isArray(value?.issues)) {
    return { code: 'invalid_arguments', message: JSON.stringify(value.issues).slice(0, 600) }
  }
  if (typeof value?.code === 'string' && typeof value.message === 'string') {
    return { code: value.code, message: value.message, ...(typeof value.status === 'number' ? { status: value.status } : {}) }
  }
  return null
}

function renderResult(outcome: { ok: true; result: unknown } | { ok: false; code: string; message: string }, limit: number): string {
  if (!outcome.ok) return `Error (${outcome.code}): ${outcome.message}`
  let text: string
  try { text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null) }
  catch { text = String(outcome.result) }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

/** The caller's fetch with the turn's abort signal, a per-attempt timeout and resends of a
 *  request that failed before its stream began. */
function turnFetch(options: RouterTurnOptions): typeof fetch {
  const base = options.fetchImpl ?? fetch
  const attempts = Math.max(1, Math.floor(options.retry?.attempts ?? 1))
  const timeoutMs = options.retry?.timeoutMs
  const baseDelayMs = options.retry?.baseDelayMs ?? 500
  if (attempts === 1 && !timeoutMs && !options.signal) return base
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted()
      const signals = [init?.signal, options.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined]
        .filter((signal): signal is AbortSignal => Boolean(signal))
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      const backoff = () => Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)
      let response: Response
      try {
        response = await base(input, { ...init, ...(signal ? { signal } : {}) })
      } catch (error) {
        if (options.signal?.aborted || attempt >= attempts) throw error
        await sleep(backoff(), options.signal)
        continue
      }
      if (attempt >= attempts || !RETRY_STATUS.has(response.status)) return response
      const retryAfter = Number(response.headers.get('retry-after'))
      await response.body?.cancel().catch(() => {})
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS) : backoff(),
        options.signal)
    }
  }
}

export async function runRouterTurn(options: RouterTurnOptions): Promise<RouterTurnOutcome> {
  if (!options.apiKey) {
    return { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 },
      failure: { code: 'router_unconfigured', message: 'The model credential is not configured.' } }
  }
  const emit = options.onEvent ?? (() => {})
  const byFunction = new Map<string, RouterTurnTool>()
  for (const tool of options.tools ?? []) {
    const fn = routerFunctionName(tool.name)
    if (!byFunction.has(fn)) byFunction.set(fn, tool)
  }
  let servedModel: string | null = null
  const fetchImpl = turnFetch(options)
  const functions = [...byFunction.entries()].map(([name, tool]) => ({
    type: 'function', function: { name, description: tool.description, parameters: tool.inputSchema },
  }))
  const streamTurnFor = (model: string) => createOpenAICompatStreamTurn({
    baseUrl: options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL,
    apiKey: options.apiKey,
    model,
    tools: functions,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens ? { extraBody: { max_tokens: options.maxTokens } } : {}),
    ...(options.traceId ? { headers: { 'x-tangle-trace-id': options.traceId } } : {}),
    fetchImpl,
    onServedModel: served => { servedModel = served.servedModel },
  })
  // The safe repeat walks this chain: the next fallback model, or the same model once.
  const repeats = options.repeat === false ? []
    : options.fallbackModels?.length ? [...options.fallbackModels] : [options.model]
  const limit = options.toolResultLimit ?? TOOL_RESULT_LIMIT
  const toolNameOf = (fn: string) => byFunction.get(fn)?.name ?? fn
  const segments: string[] = []
  const usage = { promptTokens: 0, completionTokens: 0, modelCalls: 0 }
  const toolCalls: RouterTurnOutcome['toolCalls'] = []
  const started = new Map<string, number>()
  let segmentOpen = false
  let toolsRan = 0
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const callIdOf = (id: string | undefined, toolName: string) => id ?? `${toolName}-${started.size}`

  const run = async (model: string): Promise<ToolLoopStopReason> => {
    for await (const step of streamAppToolLoop<LoopEvent>({
      systemPrompt: options.systemPrompt,
      userMessage: options.userMessage,
      priorMessages: (options.history ?? []) as LoopMessage[],
      streamTurn: streamTurnFor(model),
      extractText: event => event.type === 'text' ? event.text : '',
      extractToolCall: event => event.type === 'tool_call' ? event.call : null,
      isExecutableTool: name => byFunction.has(name),
      deadlineMs: deadline,
      maxToolTurns: options.maxToolTurns ?? 12,
      labelFor: call => toolNameOf(call.toolName),
      renderResult: (label, outcome) => options.renderToolResult
        ? options.renderToolResult(label, outcome)
        : renderResult(outcome, limit),
      executeToolCall: async (call: LoopToolCall) => {
        const tool = byFunction.get(call.toolName)
        if (!tool) return { ok: false, code: 'unknown_tool', message: `No tool named ${call.toolName}` }
        if (options.signal?.aborted) return { ok: false, code: 'aborted', message: 'The turn was cancelled before this tool ran.' }
        toolsRan++
        try {
          return { ok: true, result: await tool.run(call.args) }
        } catch (error) {
          const mapped = (options.toolError ?? defaultToolError)(error)
          if (mapped) return { ok: false, ...mapped }
          options.onToolFailure?.(tool.name, error)
          return { ok: false, code: 'tool_failed', message: 'The tool failed; tell the user what could not be completed.' }
        }
      },
    })) {
      if (step.kind === 'event') {
        const event = step.event
        if (event.type === 'text' && event.text) {
          if (!segmentOpen) { segments.push(''); segmentOpen = true }
          segments[segments.length - 1] += event.text
          emit({ type: 'text', segment: segments.length, delta: event.text })
        } else if (event.type === 'reasoning' && event.text) {
          emit({ type: 'reasoning', delta: event.text })
        } else if (event.type === 'usage') {
          usage.promptTokens += event.usage.promptTokens
          usage.completionTokens += event.usage.completionTokens
          usage.modelCalls++
          emit({ type: 'usage', ...event.usage })
        } else if (event.type === 'tool_call') {
          segmentOpen = false
          const tool = byFunction.get(event.call.toolName)
          const callId = callIdOf(event.call.toolCallId, event.call.toolName)
          started.set(callId, Date.now())
          emit({ type: 'tool', callId, toolName: tool?.name ?? event.call.toolName, status: 'running',
            input: event.call.args, startedAt: started.get(callId)! })
        }
      } else if (step.kind === 'tool_result') {
        const tool = byFunction.get(step.toolName)
        const callId = callIdOf(step.toolCallId, step.toolName)
        const startedAt = started.get(callId) ?? Date.now()
        const toolName = tool?.name ?? step.toolName
        toolCalls.push({ callId, toolName, ok: step.outcome.ok })
        emit(step.outcome.ok
          ? { type: 'tool', callId, toolName, status: 'completed', output: step.outcome.result, startedAt, endedAt: Date.now() }
          : { type: 'tool', callId, toolName, status: 'error', startedAt, endedAt: Date.now(),
            error: { code: step.outcome.code, message: step.outcome.message } })
      } else if (step.kind === 'capped') {
        return step.stopReason
      }
    }
    return 'completed'
  }

  const outcome = (failure?: RouterTurnFailure): RouterTurnOutcome => ({
    text: segments.map(part => part.trim()).filter(Boolean).join('\n\n'),
    servedModel, toolCalls, usage: { ...usage }, ...(failure ? { failure } : {}),
  })
  const aborted = () => outcome({ code: 'turn_aborted', message: 'The turn was cancelled.' })
  const said = () => segments.some(part => part.trim())
  let stop: ToolLoopStopReason
  try {
    try {
      stop = await run(options.model)
    } catch (error) {
      // Safe to repeat only while nothing was said and no tool ran.
      const next = repeats.shift()
      if (options.signal?.aborted || next === undefined || toolsRan > 0 || segments.length > 0) throw error
      stop = await run(next)
    }
  } catch (error) {
    if (options.signal?.aborted) return aborted()
    const status = (error as { status?: unknown }).status
    return outcome(typeof status === 'number'
      ? { code: `model_http_${status}`, status, message: 'The model service did not answer.' }
      : { code: 'model_unavailable', message: 'The model service did not answer.' })
  }
  if (options.signal?.aborted) return aborted()
  if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
  // A model can end its turn with neither a word nor a tool call (gemini-2.5-flash did on 8 of
  // 53 "remember" turns, 2026-10-11). Nothing was said and nothing ran, so one repeat is safe;
  // an answer still blank is a typed failure, never a successful empty reply.
  if (!said()) {
    const next = repeats.shift()
    if (toolsRan === 0 && next !== undefined) {
      try { stop = await run(next) } catch { stop = 'completed' }
      if (options.signal?.aborted) return aborted()
      if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
    }
    if (!said()) return outcome({ code: 'model_empty', message: 'The model finished without writing a reply.' })
  }
  return outcome()
}
