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
 *
 * Bounded paid lanes run this same engine inside a protected Router model grant
 * (`runProtectedRouterTurn` in `./protected-router-turn`, outside this entry so a
 * Worker bundle never pulls the grant client).
 */
import { streamAppToolLoop, type LoopEvent, type LoopMessage, type LoopToolCall, type ToolLoopStopReason } from './loop'
import { DEFAULT_TANGLE_ROUTER_BASE_URL } from './model'
import { createOpenAICompatCompletionTurn, createOpenAICompatStreamTurn } from './openai-stream'
import { turnKnowledgeInstructions, type TurnKnowledgeFile } from './turn-knowledge'
import { replyLanguageInstruction } from './reply-language'
import { placeExecution, type PlacementRecord, type VacuousAxis } from '@tangle-network/agent-runtime/placement'
export { DURABLE_HOP_BUDGET_MS, turnCheckpointPath, workspaceTurnCheckpoints, type CheckpointWorkspaceStore, type TurnCheckpointStore } from './turn-continuation'
export { budgetTurnKnowledge, turnKnowledgeInstructions, workspaceKnowledgeForTurn, type TurnKnowledgeBudget, type TurnKnowledgeFile } from './turn-knowledge'
export { asksForLanguage, replyLanguageInstruction } from './reply-language'

/** A tool the turn may call. Structurally an `McpToolDefinition` whose env is already bound. */
export interface RouterTurnTool {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, context: RouterTurnToolContext): Promise<unknown>
}

/** What a running tool gets besides its arguments. */
export interface RouterTurnToolContext {
  /**
   * Report a typed side event while the tool runs (a graph edit, a file written, a
   * progress step). It streams at once as a `tool_event` and is recorded in the
   * outcome's `toolEvents`. Events sent after the call settles are dropped.
   */
  emit(kind: string, data?: unknown): void
  /** The sender's message this turn answers, so a tool can act only on what was asked (see {@link asksForLanguage}). */
  userMessage: string
}

/** One side event a tool reported while it ran. */
export interface RouterTurnToolEvent {
  callId: string
  toolName: string
  kind: string
  data: unknown
  at: number
}

/** What the turn is doing, in the order it happens, for a live view. */
export type RouterTurnEvent =
  | { type: 'text'; segment: number; delta: string }
  | { type: 'tool'; callId: string; toolName: string; status: 'running'; input: Record<string, unknown>; startedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'completed'; output: unknown; startedAt: number; endedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'error'; error: { code: string; message: string }; startedAt: number; endedAt: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | ({ type: 'tool_event' } & RouterTurnToolEvent)

export interface RouterTurnFailure {
  /** `model_http_<status>`, `model_unavailable`, `model_empty`, `turn_<stopReason>`, `turn_aborted`,
   *  `turn_tool_limit` or `router_unconfigured`; under a protected grant also the `grant_*` and
   *  `settlement_*` codes of `./protected-router-turn`. */
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
  /** Every side event the turn's tools reported, in order (at most 500). */
  toolEvents: RouterTurnToolEvent[]
  failure?: RouterTurnFailure
  /**
   * Set instead of a failure when the turn reached its budget at a clean point
   * (every tool call answered). The turn is not over: persist this and call
   * `runRouterTurn` again with `continueFrom` in a durable process to finish it.
   * `text` holds everything the turn has written so far, across hops.
   */
  continuation?: RouterTurnContinuation
  /** Where the turn was placed, when the caller asked for placement. */
  placement?: PlacementRecord
}

/** A checkpointed Router turn: the conversation after the system prompt, ready to continue. JSON-safe. */
export interface RouterTurnContinuation {
  messages: LoopMessage[]
  /** Hops this turn has already run, including this one. */
  hops: number
  /** Reply text every hop so far wrote; the final hop's outcome `text` includes it. */
  text: string
}

/**
 * What placement reads for a Router turn: the resolved profile, the tools the
 * turn would hold, and a model the sender chose. Declared data only.
 */
export interface RouterTurnPlacementInput {
  profile: object
  toolNames?: readonly string[]
  /** A model other than the profile's needs the sandbox to choose between them. */
  requestedModel?: string
  /** Deny-only permissions grant nothing a Router turn lacks. Default: ['permissions']. */
  vacuousAxes?: readonly VacuousAxis[]
  /** The app inlines the profile's skill text into the prompt. */
  inlineSkills?: boolean
}

/**
 * Where one conversational turn runs: `inference` or `loop` run here in
 * `runRouterTurn`; `sandbox` means the profile or request needs a computer
 * (a harness, files, MCP servers, skills that are not inlined, another model).
 * Throws `PlacementRefusedError` when no tier can meet every requirement.
 */
export function placeRouterTurn(input: RouterTurnPlacementInput): PlacementRecord {
  return placeExecution({
    profile: input.profile,
    requirements: {
      ...(input.toolNames?.length ? { tools: [...input.toolNames] } : {}),
      ...(input.requestedModel ? { model: input.requestedModel } : {}),
    },
    context: { interactive: false, inferenceAvailable: true, loopAvailable: true },
    vacuousAxes: input.vacuousAxes ?? ['permissions'],
    ...(input.inlineSkills ? { inlineSkills: true } : {}),
  })
}

/** One tool call's result as the model reads it. */
export type RouterTurnToolOutcome = { ok: true; result: unknown } | { ok: false; code: string; message: string }

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
  /** Wall-clock budget in ms for this hop. Default 90 s. At the budget the outcome carries a
   *  `continuation` instead of failing; the model call or tool already running finishes first. */
  budgetMs?: number
  /** Continue a checkpointed turn; `userMessage` and `history` are ignored. */
  continueFrom?: RouterTurnContinuation
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
  /** Default true: one repeat of a model call that failed before any word or tool, and of a blank
   *  answer. Pass false when a second billable call needs the caller's own decision; the failure is
   *  then returned as it happened. */
  repeat?: boolean
  /** Default true. False takes each model call as one buffered completion instead of a stream. */
  stream?: boolean
  /** Sent as `reasoning_effort`. */
  reasoningEffort?: string
  /** Sent as `max_completion_tokens`: one model call's visible and reasoning tokens together. */
  maxCompletionTokens?: number
  /** At most this many tool calls run. The next one is refused before it runs and the turn ends
   *  with `turn_tool_limit`. */
  maxToolCalls?: number
  /** Replace the text the model reads for one tool result. `toolName` is the app's name. */
  renderToolResult?: (toolName: string, outcome: RouterTurnToolOutcome) => string
  /**
   * Place the turn before any model call. A turn placed in the sandbox returns at once
   * with `placement` and failure `placement_sandbox`, so the app runs it there instead.
   */
  placement?: Omit<RouterTurnPlacementInput, 'toolNames'>
}

const DEFAULT_BUDGET_MS = 90_000
const TOOL_EVENT_LIMIT = 500
/** Marks a tool's typed event inside a loop progress update. */
const TOOL_EVENT = '__routerTurnToolEvent'
const TOOL_RESULT_LIMIT = 12_000

/** OpenAI-compatible function names allow only `[A-Za-z0-9_-]{1,64}`; app tool names often use dots. */
export function routerFunctionName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/**
 * The lean system prompt for a Router turn: the profile's system prompt and
 * instructions, the turn's knowledge files, then caller context, with tool names rewritten to the function
 * names the model actually calls.
 */
export function composeRouterTurnPrompt(
  profile: { prompt?: { systemPrompt?: string; instructions?: readonly string[] } },
  options: {
    context?: readonly string[]
    toolNames?: readonly string[]
    /** Knowledge files every turn carries; see {@link turnKnowledgeInstructions}. */
    knowledge?: { files: readonly TurnKnowledgeFile[]; readTool?: string }
  } = {},
): string {
  const knowledge = options.knowledge ? turnKnowledgeInstructions(options.knowledge.files, { readTool: options.knowledge.readTool }) : []
  const text = [profile.prompt?.systemPrompt ?? '', ...(profile.prompt?.instructions ?? []), ...knowledge,
    replyLanguageInstruction(), ...(options.context ?? [])]
    .filter(part => part.trim()).join('\n\n')
  return [...(options.toolNames ?? [])].sort((a, b) => b.length - a.length)
    .reduce((out, name) => out.split(name).join(routerFunctionName(name)), text)
}

const joinText = (parts: string[]) => parts.map(part => part.trim()).filter(Boolean).join('\n\n')

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

function renderResult(outcome: RouterTurnToolOutcome): string {
  if (!outcome.ok) return `Error (${outcome.code}): ${outcome.message}`
  let text: string
  try { text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null) }
  catch { text = String(outcome.result) }
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…` : text
}

export async function runRouterTurn(options: RouterTurnOptions): Promise<RouterTurnOutcome> {
  // A continued turn answers the last user message in its checkpoint.
  const lastUser = options.continueFrom?.messages.filter(message => message.role === 'user').at(-1)?.content
  const currentUserMessage = options.continueFrom ? (typeof lastUser === 'string' ? lastUser : '') : options.userMessage
  const placement = options.placement
    ? placeRouterTurn({ ...options.placement, toolNames: (options.tools ?? []).map(tool => tool.name) })
    : undefined
  if (placement?.chosen === 'sandbox') {
    return { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [], placement,
      failure: { code: 'placement_sandbox', message: placement.reason } }
  }
  const { apiKey } = options
  if (!apiKey) {
    return { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [],
      failure: { code: 'router_unconfigured', message: 'The model credential is not configured.' } }
  }
  const emit = options.onEvent ?? (() => {})
  const { signal } = options
  // A cancelled turn sends nothing more, whatever the injected fetch does with the signal.
  const fetchImpl: typeof fetch | undefined = signal
    ? async (input, init) => {
      signal.throwIfAborted()
      return (options.fetchImpl ?? fetch)(input, { ...init, signal })
    }
    : options.fetchImpl
  const extraBody = {
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.maxCompletionTokens ? { max_completion_tokens: options.maxCompletionTokens } : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
  }
  const byFunction = new Map<string, RouterTurnTool>()
  for (const tool of options.tools ?? []) {
    const fn = routerFunctionName(tool.name)
    if (!byFunction.has(fn)) byFunction.set(fn, tool)
  }
  let servedModel: string | null = null
  const streamTurn = (options.stream === false ? createOpenAICompatCompletionTurn : createOpenAICompatStreamTurn)({
    baseUrl: options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL,
    apiKey,
    model: options.model,
    tools: [...byFunction.entries()].map(([name, tool]) => ({
      type: 'function', function: { name, description: tool.description, parameters: tool.inputSchema },
    })),
    ...(Object.keys(extraBody).length ? { extraBody } : {}),
    ...(options.traceId ? { headers: { 'x-tangle-trace-id': options.traceId } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    onServedModel: served => { servedModel = served.servedModel },
  })
  const segments: string[] = []
  const usage = { promptTokens: 0, completionTokens: 0, modelCalls: 0 }
  const toolCalls: RouterTurnOutcome['toolCalls'] = []
  const toolEvents: RouterTurnToolEvent[] = []
  const started = new Map<string, number>()
  let segmentOpen = false
  let toolsRan = 0
  let checkpoint: LoopMessage[] | null = null
  let toolLimitReached = false
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const callIdOf = (id: string | undefined, toolName: string) => id ?? `${toolName}-${started.size}`

  const run = async (): Promise<ToolLoopStopReason | 'tool_limit'> => {
    for await (const step of streamAppToolLoop<LoopEvent>({
      systemPrompt: options.systemPrompt,
      ...(options.continueFrom
        ? { priorMessages: options.continueFrom.messages }
        : { userMessage: options.userMessage, priorMessages: (options.history ?? []) as LoopMessage[] }),
      streamTurn,
      extractText: event => event.type === 'text' ? event.text : '',
      extractToolCall: event => event.type === 'tool_call' ? event.call : null,
      isExecutableTool: name => byFunction.has(name),
      deadlineMs: deadline,
      maxToolTurns: options.maxToolTurns ?? 12,
      labelFor: call => byFunction.get(call.toolName)?.name ?? call.toolName,
      renderResult: (label, outcome) => options.renderToolResult ? options.renderToolResult(label, outcome) : renderResult(outcome),
      executeToolCall: async (call: LoopToolCall, context) => {
        const tool = byFunction.get(call.toolName)
        if (!tool) return { ok: false, code: 'unknown_tool', message: `No tool named ${call.toolName}` }
        if (signal?.aborted) return { ok: false, code: 'aborted', message: 'The turn was cancelled before this tool ran.' }
        if (options.maxToolCalls !== undefined && toolsRan >= options.maxToolCalls) {
          toolLimitReached = true
          return { ok: false, code: 'tool_limit', message: 'The turn reached its tool-call limit.' }
        }
        toolsRan++
        // A tool's typed event rides the loop's progress channel, so it streams in order before the result.
        const emitEvent = (kind: string, data?: unknown) => context?.progress({ data: { [TOOL_EVENT]: kind, data } })
        try {
          return { ok: true, result: await tool.run(call.args, { emit: emitEvent, userMessage: currentUserMessage }) }
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
      } else if (step.kind === 'tool_progress') {
        const tool = byFunction.get(step.toolName)
        const marked = step.update.data as { [TOOL_EVENT]?: unknown; data?: unknown } | undefined
        // A tool's own emit carries its kind; plain loop progress (a step count, a message) is kind `progress`.
        const typed = typeof marked?.[TOOL_EVENT] === 'string'
        const event: RouterTurnToolEvent = {
          callId: callIdOf(step.toolCallId, step.toolName), toolName: tool?.name ?? step.toolName,
          kind: typed ? marked![TOOL_EVENT] as string : 'progress',
          data: typed ? marked!.data ?? null : step.update, at: Date.now(),
        }
        if (toolEvents.length < TOOL_EVENT_LIMIT) toolEvents.push(event)
        emit({ type: 'tool_event', ...event })
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
        // The refused call never ran; the turn ends here rather than asking the model again.
        if (toolLimitReached) return 'tool_limit'
      } else if (step.kind === 'capped') {
        if (step.stopReason === 'deadline' && step.messages) checkpoint = step.messages
        return step.stopReason
      }
    }
    return 'completed'
  }

  const outcome = (failure?: RouterTurnFailure): RouterTurnOutcome => ({
    text: joinText([options.continueFrom?.text ?? '', ...segments]),
    servedModel, toolCalls, usage: { ...usage }, toolEvents: [...toolEvents], ...(placement ? { placement } : {}), ...(failure ? { failure } : {}),
  })
  const repeat = options.repeat !== false
  let stop: ToolLoopStopReason | 'tool_limit'
  try {
    try {
      stop = await run()
    } catch (error) {
      // Safe to repeat only while nothing was said and no tool ran.
      if (!repeat || signal?.aborted || toolsRan > 0 || segments.length > 0) throw error
      stop = await run()
    }
  } catch (error) {
    if (signal?.aborted) return outcome({ code: 'turn_aborted', message: 'The turn was cancelled.' })
    const status = (error as { status?: unknown }).status
    return outcome(typeof status === 'number'
      ? { code: `model_http_${status}`, status, message: 'The model service did not answer.' }
      : { code: 'model_unavailable', message: 'The model service did not answer.' })
  }
  if (stop === 'deadline' && checkpoint) {
    return { ...outcome(), continuation: { messages: checkpoint,
      hops: (options.continueFrom?.hops ?? 0) + 1,
      text: outcome().text } }
  }
  if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
  // A model can end its turn with neither a word nor a tool call (gemini-2.5-flash did on 8 of
  // 53 "remember" turns, 2026-10-11). Nothing was said and nothing ran, so one repeat is safe;
  // an answer still blank is a typed failure, never a successful empty reply.
  if (!segments.some(part => part.trim()) && !options.continueFrom?.text.trim()) {
    if (toolsRan === 0 && repeat) {
      try { stop = await run() } catch { stop = 'completed' }
      if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
    }
    if (!segments.some(part => part.trim())) {
      return outcome({ code: 'model_empty', message: 'The model finished without writing a reply.' })
    }
  }
  return outcome()
}
