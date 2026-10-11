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
  | { type: 'tool'; callId: string; toolName: string; status: 'running'; input: Record<string, unknown>; startedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'completed'; output: unknown; startedAt: number; endedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'error'; error: { code: string; message: string }; startedAt: number; endedAt: number }

export interface RouterTurnFailure {
  /** `model_http_<status>`, `model_unavailable`, `turn_<stopReason>` or `router_unconfigured`. */
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
  failure?: RouterTurnFailure
}

export interface RouterTurnOptions {
  apiKey: string
  model: string
  /** Defaults to the Tangle Router. */
  baseUrl?: string
  systemPrompt: string
  userMessage: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
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
}

const DEFAULT_BUDGET_MS = 90_000
const TOOL_RESULT_LIMIT = 12_000

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

function renderResult(outcome: { ok: true; result: unknown } | { ok: false; code: string; message: string }): string {
  if (!outcome.ok) return `Error (${outcome.code}): ${outcome.message}`
  let text: string
  try { text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null) }
  catch { text = String(outcome.result) }
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…` : text
}

export async function runRouterTurn(options: RouterTurnOptions): Promise<RouterTurnOutcome> {
  if (!options.apiKey) {
    return { text: '', servedModel: null, toolCalls: [],
      failure: { code: 'router_unconfigured', message: 'The model credential is not configured.' } }
  }
  const emit = options.onEvent ?? (() => {})
  const byFunction = new Map<string, RouterTurnTool>()
  for (const tool of options.tools ?? []) {
    const fn = routerFunctionName(tool.name)
    if (!byFunction.has(fn)) byFunction.set(fn, tool)
  }
  let servedModel: string | null = null
  const streamTurn = createOpenAICompatStreamTurn({
    baseUrl: options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL,
    apiKey: options.apiKey,
    model: options.model,
    tools: [...byFunction.entries()].map(([name, tool]) => ({
      type: 'function', function: { name, description: tool.description, parameters: tool.inputSchema },
    })),
    ...(options.maxTokens ? { extraBody: { max_tokens: options.maxTokens } } : {}),
    ...(options.traceId ? { headers: { 'x-tangle-trace-id': options.traceId } } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onServedModel: served => { servedModel = served.servedModel },
  })
  const segments: string[] = []
  const toolCalls: RouterTurnOutcome['toolCalls'] = []
  const started = new Map<string, number>()
  let segmentOpen = false
  let toolsRan = 0
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const callIdOf = (id: string | undefined, toolName: string) => id ?? `${toolName}-${started.size}`

  const run = async (): Promise<ToolLoopStopReason> => {
    for await (const step of streamAppToolLoop<LoopEvent>({
      systemPrompt: options.systemPrompt,
      userMessage: options.userMessage,
      priorMessages: (options.history ?? []) as LoopMessage[],
      streamTurn,
      extractText: event => event.type === 'text' ? event.text : '',
      extractToolCall: event => event.type === 'tool_call' ? event.call : null,
      isExecutableTool: name => byFunction.has(name),
      deadlineMs: deadline,
      maxToolTurns: options.maxToolTurns ?? 12,
      renderResult: (_label, outcome) => renderResult(outcome),
      executeToolCall: async (call: LoopToolCall) => {
        const tool = byFunction.get(call.toolName)
        if (!tool) return { ok: false, code: 'unknown_tool', message: `No tool named ${call.toolName}` }
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
    servedModel, toolCalls, ...(failure ? { failure } : {}),
  })
  let stop: ToolLoopStopReason
  try {
    try {
      stop = await run()
    } catch (error) {
      // Safe to repeat only while nothing was said and no tool ran.
      if (toolsRan > 0 || segments.length > 0) throw error
      stop = await run()
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status
    return outcome(typeof status === 'number'
      ? { code: `model_http_${status}`, status, message: 'The model service did not answer.' }
      : { code: 'model_unavailable', message: 'The model service did not answer.' })
  }
  if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
  return outcome()
}
