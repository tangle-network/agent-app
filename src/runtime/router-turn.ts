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
import { gzipRequestBodies } from './gzip-request'
import { createOpenAICompatCompletionTurn, createOpenAICompatStreamTurn, createOpenAIResponsesTurn, isOpenAIResponsesModel } from './openai-stream'
import { turnKnowledgeInstructions, type TurnKnowledgeFile } from './turn-knowledge'
import { replyLanguageInstruction } from './reply-language'
import { placeExecution, type PlacementRecord, type VacuousAxis } from '@tangle-network/agent-runtime/placement'
import { turnTraceId, type TurnSpan, type TurnTrace } from '../turn-trace/recorder'
import { nextCallIndex, tracedModelFetch } from '../turn-trace/traced-fetch'
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
  /** This call's identity, shared by streamed parts, tool history and a native child execution. */
  callId?: string
  /** The effective turn cancellation signal. Tools must pass it to cancellable I/O. */
  signal?: AbortSignal
  /**
   * Report a typed side event while the tool runs (a graph edit, a file written, a
   * progress step). It streams at once as a `tool_event` and is recorded in the
   * outcome's `toolEvents`. Events sent after the call settles are dropped.
   */
  emit(kind: string, data?: unknown): void
  /** The sender's message this turn answers, so a tool can act only on what was asked (see {@link asksForLanguage}). */
  userMessage: string
  /** The turn's trace, when the turn records one. A tool that waits on a box or a service adds its own child spans under {@link span}. */
  trace?: TurnTrace
  /** This tool call's `tool.call` span; the parent of any span the tool records. */
  span?: TurnSpan
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
  /** Hidden reasoning the model streamed (`reasoning_content` / `thinking`), for a thinking view. Never part of the answer. */
  | { type: 'reasoning'; delta: string }
  /** The safe repeat is starting a fresh model call on `model`; what the failed call reasoned is finished. */
  | { type: 'repeat'; model: string }
  /** The model named a tool; its arguments are still streaming. Lets a caller start slow work the call will need
   *  (the box `sandbox_run` runs in) seconds before the call itself. `toolName` is the app's name. */
  | { type: 'tool_start'; toolName: string }
  | { type: 'tool'; callId: string; toolName: string; status: 'running'; input: Record<string, unknown>; startedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'completed'; output: unknown; startedAt: number; endedAt: number }
  | { type: 'tool'; callId: string; toolName: string; status: 'error'; error: { code: string; message: string }; startedAt: number; endedAt: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedPromptTokens?: number }
  | ({ type: 'tool_event' } & RouterTurnToolEvent)

export interface RouterTurnFailure {
  /** `model_http_<status>`, `model_stream_<code>` (an error frame inside the stream, e.g. `model_stream_empty_completion`),
   *  `model_unavailable`, `model_empty`, `turn_<stopReason>`, `turn_aborted`,
   *  `turn_tool_limit`, `router_unconfigured` or `placement_fallback_refused`; under a protected grant also the `grant_*` and
   *  `settlement_*` codes of `./protected-router-turn`. */
  code: string
  status?: number
  message: string
  /** The model service's own error text, at most 1000 characters (e.g. `key_budget_exhausted`), so an app can
   *  tell a spend cap from a missing balance. Never a credential. */
  detail?: string
}

export interface RouterTurnOutcome {
  /** Every text segment the model wrote, joined by blank lines. */
  text: string
  /** The model the router reports having served, when it said. */
  servedModel: string | null
  toolCalls: Array<{ callId: string; toolName: string; ok: boolean }>
  /** Token use summed over every model call in the turn, as the router reported it. `cachedPromptTokens` are the
   *  prompt tokens the provider served from its prompt cache; absent when no call reported them. */
  usage: { promptTokens: number; completionTokens: number; modelCalls: number; cachedPromptTokens?: number }
  /** Reasoning the turn streamed (deltas and characters). Zero when the model sent none; absent when no model was called. */
  reasoning?: { deltas: number; chars: number }
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
  /** Runaway watchdog on model turns. Default: the tool loop's own watchdog, far above any legitimate turn, so
   *  `budgetMs` bounds the turn. A fixed 12 failed Legal's formation turns, which need 12 tools in 13 model calls
   *  (2026-10-20, turn_backstop on 2 of 6). */
  maxToolTurns?: number
  maxTokens?: number
  /** Sent as `x-tangle-trace-id` so the router's generation joins the app's trace. Characters the Router
   *  refuses in that header (the `:` of an execution id) become `_`; see {@link turnTraceId}. Default: the
   *  `trace`'s id. */
  traceId?: string
  /**
   * The turn's trace (`@tangle-network/agent-app/turn-trace`). Every model request is recorded as a
   * `model.call` span with the Router's `Server-Timing` split into network and server time, and every tool
   * call as a `tool.call` span that tool-side spans hang from. Without it nothing is recorded.
   */
  trace?: TurnTrace
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
  /**
   * The caller shows the model's reasoning as it streams (`onEvent` `reasoning` events). With `onEvent`, a
   * streamed chat call and the safe repeat on, the Router then releases the stream at the first reasoning frame
   * instead of holding it for the first word, and returns Gemini's thought summaries (gateway
   * `streamReasoningImmediately`). Default false; `createRouterTurnProducer` turns it on.
   */
  showReasoning?: boolean
  /** Sent as `max_completion_tokens`: one model call's visible and reasoning tokens together. */
  maxCompletionTokens?: number
  /** At most this many tool calls run. The next one is refused before it runs and the turn ends
   *  with `turn_tool_limit`. */
  maxToolCalls?: number
  /** Replace a domain-specific tool result; return undefined to use the shared serialization and limit. */
  renderToolResult?: (toolName: string, outcome: RouterTurnToolOutcome) => string | undefined
  /**
   * Place the turn before any model call, using `model` as the executed model rather than
   * the optional `requestedModel` hint. A turn placed in the sandbox returns at once
   * with `placement` and failure `placement_sandbox`, so the app runs it there instead.
   */
  placement?: Omit<RouterTurnPlacementInput, 'toolNames'>
  temperature?: number
  /** Models tried in order when a model call fails before any word or tool, or answers blank. Without it,
   *  that safe repeat uses `model` again. `repeat: false` turns both off. */
  fallbackModels?: readonly string[]
  /** Resend one model request that answered 408, 425, 429 or 5xx, or failed to connect, before its stream
   *  began, with exponential backoff (a `retry-after` up to 8 s is honoured). `attempts` counts the first
   *  send (default 1, no resend). With more than one, resends go on past `attempts` until 45 s have passed
   *  since the first send, so an outage of that length costs the turn a pause instead of the turn.
   *  `timeoutMs` bounds each attempt, stream included. */
  retry?: { attempts?: number; timeoutMs?: number; baseDelayMs?: number }
  /** Characters of one tool result the model reads when no `renderToolResult` is given. Default 12 000. */
  toolResultLimit?: number
  /**
   * Which model API carries the turn. `auto` (default) uses the Responses API for an OpenAI model asked to
   * reason (`reasoningEffort` other than `none`), since OpenAI returns reasoning summaries only there, or given
   * tools, since GPT-6.1 Sol and GPT-6 Astra take function tools only there (the Router refuses them on chat
   * completions with `model_requires_responses_for_tools`), and chat completions otherwise. A buffered turn
   * (`stream: false`) always uses chat completions.
   */
  api?: 'auto' | 'chat' | 'responses'
  /**
   * Gzip a model request body of at least this many bytes (`Content-Encoding: gzip`), so a large system prompt
   * uploads in fewer round trips. Unset defaults to 32 KiB for the origin of DEFAULT_TANGLE_ROUTER_BASE_URL;
   * other origins send bodies as they are. An explicit threshold wins; a negative value disables gzip.
   */
  gzipRequestAboveBytes?: number
}

const DEFAULT_BUDGET_MS = 90_000
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
// The Router names a refusal no resend of the same model can fix: every
// credential for it is out of quota, rejected or suspended (tangle-router
// `X-Tangle-Failure-Category`). The turn moves to its next fallback model at once.
const DEAD_CREDENTIAL_CATEGORIES = new Set(['provider_quota_exhausted', 'provider_key_invalid', 'provider_account_suspended'])
const MAX_RETRY_DELAY_MS = 8_000
// How long a request that may resend keeps resending a retryable answer. The Router answers 503 without calling a
// model while Platform cannot verify the turn's key: on 2026-10-20 Platform's event loop stalled 16 s (10:30) and a
// Platform deploy restarted it (11:36), and three sends inside 1 to 16 s failed two Legal turns that 45 s
// would have carried through.
const RETRY_WINDOW_MS = 45_000
const TOOL_EVENT_LIMIT = 500
/** Marks a tool's typed event inside a loop progress update. */
const TOOL_EVENT = '__routerTurnToolEvent'
const TOOL_RESULT_LIMIT = 12_000

/** OpenAI-compatible function names allow only `[A-Za-z0-9_-]{1,64}`; app tool names often use dots. */
export function routerFunctionName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

export interface RouterTurnPromptSections {
  /** Every section that is the same on each turn of a workspace, first, so the bytes repeat turn after turn. */
  prefix: string
  /** What this turn adds: its `context`. Empty when there is none. */
  tail: string
  /** `prefix` then `tail`: the system prompt the model reads. */
  text: string
}

export interface RouterTurnPromptOptions {
  /** Sections the same on every turn of a workspace (skills, tool guidance, catalogs, references). They go in the
   *  prefix, after the profile's prompt, so a provider's prompt cache serves them. */
  stable?: readonly string[]
  /** This turn's own sections (the clock, the board, what changed, ids). They go last, after every stable byte. */
  context?: readonly string[]
  toolNames?: readonly string[]
  /** Knowledge files every turn carries; see {@link turnKnowledgeInstructions}. They change only when the workspace
   *  edits them, so they close the prefix. */
  knowledge?: { files: readonly TurnKnowledgeFile[]; readTool?: string }
  /** Under a test runner (Vitest, Jest, `NODE_ENV=test`) the composition throws when the prefix carries a per-turn
   *  byte ({@link perTurnPrefixBytes}), so an app's own tests fail before a timestamp costs every turn its prompt
   *  cache. It never runs outside a test runner. `false` turns the check off for a prefix that is meant to vary. */
  checkStablePrefix?: boolean
}

// A clock to the minute is per-turn by construction: ISO (`2026-10-22T08:15`, `2026-10-22 08:15`), `Date#toString`
// (`Wed Oct 22 2026 08:15:00`) and `Date#toUTCString` (`Wed, 22 Oct 2026 08:15:00`).
const PER_TURN_CLOCKS = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}/,
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}/,
]
/** A turn section shorter than this may repeat a stable phrase; only longer ones are looked for in the prefix. */
const MIN_REPEATED_CONTEXT = 24

/**
 * The per-turn bytes in a prompt prefix: a clock to the minute, and any of this turn's `context` sections (or the
 * caller's own per-turn values: ids, the member's message) that also appear there. Empty for a cacheable prefix.
 */
export function perTurnPrefixBytes(prefix: string, perTurn: readonly string[] = []): string[] {
  const found = PER_TURN_CLOCKS.flatMap(pattern => prefix.match(pattern)?.[0] ?? [])
  for (const value of perTurn) {
    const trimmed = value.trim()
    if (trimmed.length >= MIN_REPEATED_CONTEXT && prefix.includes(trimmed)) found.push(trimmed.slice(0, 80))
  }
  return found
}

function underTestRunner(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return Boolean(env && (env.VITEST || env.JEST_WORKER_ID || env.NODE_ENV === 'test'))
}

/**
 * The lean system prompt for a Router turn, split where its bytes stop repeating. The prefix holds the profile's
 * system prompt, appended prompt and instructions, the reply-language rule, the caller's `stable` sections and the
 * knowledge files; the tail holds the turn's `context`. Tool names are rewritten to the function names the model
 * actually calls.
 *
 * A provider serves a repeated prompt prefix from its cache: through the Router, Gemini served 38,685 of
 * 40,734 prompt tokens from cache on each repeat of a stable 150 kB prefix, and none when a timestamp came first
 * (2026-10-22). One per-turn byte early in the prompt therefore costs the whole prompt on every turn, so nothing
 * per-turn belongs in `stable` or the profile's prompt; under a test runner a clock or a repeated `context` section in
 * the prefix throws (`checkStablePrefix`).
 */
export function composeRouterTurnPromptSections(
  profile: { prompt?: { systemPrompt?: string; appendSystemPrompt?: string; instructions?: readonly string[] } },
  options: RouterTurnPromptOptions = {},
): RouterTurnPromptSections {
  const knowledge = options.knowledge ? turnKnowledgeInstructions(options.knowledge.files, { readTool: options.knowledge.readTool }) : []
  const names = [...(options.toolNames ?? [])].sort((a, b) => b.length - a.length)
  const render = (parts: readonly string[]) => names.reduce((out, name) => out.split(name).join(routerFunctionName(name)),
    parts.filter(part => part.trim()).join('\n\n'))
  const authored = [profile.prompt?.systemPrompt ?? '', profile.prompt?.appendSystemPrompt ?? '', ...(profile.prompt?.instructions ?? []),
    replyLanguageInstruction(), ...(options.stable ?? [])]
  const prefix = render([...authored, ...knowledge])
  const tail = render(options.context ?? [])
  // The workspace's knowledge files are its own text and may quote a time; the check reads what the app authored.
  if (options.checkStablePrefix !== false && underTestRunner()) {
    const perTurn = perTurnPrefixBytes(render(authored), (options.context ?? []).map(section => render([section])))
    if (perTurn.length) {
      throw new Error(`composeRouterTurnPromptSections: the stable prefix carries per-turn bytes (${perTurn.map(value => JSON.stringify(value)).join(', ')}); `
        + 'move them to `context` so the prompt cache serves the prefix, or pass `checkStablePrefix: false`.')
    }
  }
  return { prefix, tail, text: [prefix, tail].filter(Boolean).join('\n\n') }
}

/** The system prompt {@link composeRouterTurnPromptSections} composes, as one string. */
export function composeRouterTurnPrompt(
  profile: { prompt?: { systemPrompt?: string; appendSystemPrompt?: string; instructions?: readonly string[] } },
  options: RouterTurnPromptOptions = {},
): string {
  return composeRouterTurnPromptSections(profile, options).text
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

function renderResult(outcome: RouterTurnToolOutcome, limit = TOOL_RESULT_LIMIT): string {
  if (!outcome.ok) return `Error (${outcome.code}): ${outcome.message}`
  let text: string
  try { text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null) }
  catch { text = String(outcome.result) }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Add one model call's usage to the turn's totals and to that call's span. */
function addCallUsage(
  usage: RouterTurnOutcome['usage'],
  call: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number },
  span: TurnSpan | undefined,
): void {
  usage.promptTokens += call.promptTokens
  usage.completionTokens += call.completionTokens
  usage.modelCalls++
  const cached = call.cachedPromptTokens
  if (cached !== undefined) usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + cached
  span?.set({
    'gen_ai.usage.input_tokens': call.promptTokens,
    'gen_ai.usage.output_tokens': call.completionTokens,
    ...(cached !== undefined ? { 'gen_ai.usage.cache_read.input_tokens': cached } : {}),
  })
}

export async function runRouterTurn(options: RouterTurnOptions): Promise<RouterTurnOutcome> {
  // A continued turn answers the last user message in its checkpoint.
  const lastUser = options.continueFrom?.messages.filter(message => message.role === 'user').at(-1)?.content
  const currentUserMessage = options.continueFrom ? (typeof lastUser === 'string' ? lastUser : '') : options.userMessage
  const placement = options.placement
    ? placeRouterTurn({ ...options.placement, requestedModel: options.model, toolNames: (options.tools ?? []).map(tool => tool.name) })
    : undefined
  if (placement?.chosen === 'sandbox') {
    return { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [], placement,
      failure: { code: 'placement_sandbox', message: placement.reason } }
  }
  const { apiKey } = options
  if (!apiKey) {
    return { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 }, toolEvents: [],
      ...(placement ? { placement } : {}),
      failure: { code: 'router_unconfigured', message: 'The model credential is not configured.' } }
  }
  const emit = options.onEvent ?? (() => {})
  const { signal } = options
  // A cancelled turn sends nothing more, whatever the injected fetch does with the signal.
  const attempts = Math.max(1, Math.floor(options.retry?.attempts ?? 1))
  const attemptTimeoutMs = options.retry?.timeoutMs
  const baseDelayMs = options.retry?.baseDelayMs ?? 500
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
  const traceId = options.traceId !== undefined ? turnTraceId(options.traceId) : options.trace?.traceId
  const { trace } = options
  const transportState = { currentModel: options.model, lastModelSpan: undefined as TurnSpan | undefined }
  const { fetchImpl } = createRouterTurnTransport(options, trace, transportState, signal, attempts, attemptTimeoutMs, baseDelayMs, pause)

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
  const reasoningAsked = Boolean(options.reasoningEffort) && options.reasoningEffort !== 'none'
  // Legal 2026-10-19/20: the Router refused the gpt-6.1-sol fallback's tool turn on chat completions with a 400 in 2
  // of 2 fallbacks, so the fallback that should have saved those turns failed them.
  const responsesForTools = byFunction.size > 0
  const useResponses = (model: string) => options.stream !== false &&
    (options.api === 'responses' || ((options.api ?? 'auto') === 'auto' && (reasoningAsked || responsesForTools) &&
      isOpenAIResponsesModel(model)))
  // A caller that shows reasoning asks the Router to release a streamed chat call at the first reasoning frame
  // rather than hold it for the first word, which also makes it return Gemini's thought summaries (tangle-router
  // gateway option `streamReasoningImmediately`). The cost: once reasoning has been shown the Router no longer
  // switches models silently. A reasoning-only finish or a stall arrives as an error frame (`empty_completion`,
  // `stream_idle_timeout`), which ends the call by name and takes the safe repeat on the next fallback model, so
  // the option is sent only while that repeat is on. The stall timer stays the Router's own (120 s): Gemini sends a
  // tool call whole, so a stream is silent while the model writes the call. On Legal (2026-10-20) healthy calls went
  // up to 44.6 s from their last word to their tool call and 66 s from their first frame to it, and a 45 s timer cut
  // 2 of 30 turns after their first sentence.
  const bodyFor = (model: string) => options.showReasoning && options.onEvent && options.repeat !== false &&
    options.stream !== false && !useResponses(model)
    ? { ...extraBody, gateway: { streamReasoningImmediately: true } }
    : extraBody
  const streamTurnFor = (model: string) => (options.stream === false ? createOpenAICompatCompletionTurn
    : useResponses(model) ? createOpenAIResponsesTurn : createOpenAICompatStreamTurn)({
    baseUrl: options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL,
    apiKey,
    model,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    tools: [...byFunction.entries()].map(([name, tool]) => ({
      type: 'function', function: { name, description: tool.description, parameters: tool.inputSchema },
    })),
    ...(Object.keys(bodyFor(model)).length ? { extraBody: bodyFor(model) } : {}),
    ...(traceId ? { headers: { 'x-tangle-trace-id': traceId } } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    onServedModel: served => {
      servedModel = served.servedModel
      if (served.servedModel) transportState.lastModelSpan?.set({ 'gen_ai.response.model': served.servedModel })
    },
  })
  const segments: string[] = []
  const usage: RouterTurnOutcome['usage'] = { promptTokens: 0, completionTokens: 0, modelCalls: 0 }
  // How much reasoning the turn streamed: the number an app logs to measure reasoning coverage.
  const reasoning = { deltas: 0, chars: 0 }
  const toolCalls: RouterTurnOutcome['toolCalls'] = []
  const toolEvents: RouterTurnToolEvent[] = []
  const started = new Map<string, number>()
  const priorCallIds = new Set((options.continueFrom?.messages ?? options.history ?? []).flatMap(message => [
    ...('tool_calls' in message ? (message.tool_calls ?? []).map(call => call.id) : []),
    ...('tool_call_id' in message && message.tool_call_id ? [message.tool_call_id] : []),
  ]))
  let segmentOpen = false
  let toolsRan = 0
  let checkpoint: LoopMessage[] | null = null
  let toolLimitReached = false
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const callIdOf = (id: string | undefined, toolName: string) => {
    if (id) return id
    let fallback = `${toolName}-${started.size}`
    while (started.has(fallback) || priorCallIds.has(fallback)) fallback += '_'
    return fallback
  }

  let placementFailure: RouterTurnFailure | undefined
  const run = async (model: string): Promise<ToolLoopStopReason | 'tool_limit' | 'placement_refused'> => {
    // A safe model retry still cannot change execution tier after this turn began.
    if (placement && options.placement && model !== options.model) {
      const next = placeRouterTurn({ ...options.placement, requestedModel: model,
        toolNames: (options.tools ?? []).map(tool => tool.name) })
      if (next.chosen !== placement.chosen) {
        placementFailure = { code: 'placement_fallback_refused', message: `The fallback model cannot run in this turn's placement: ${next.reason}` }
        return 'placement_refused'
      }
    }
    transportState.currentModel = model
    const streamTurn = streamTurnFor(model)
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
      ...(options.maxToolTurns !== undefined ? { maxToolTurns: options.maxToolTurns } : {}),
      labelFor: call => byFunction.get(call.toolName)?.name ?? call.toolName,
      renderResult: (label, outcome) => options.renderToolResult?.(label, outcome) ?? renderResult(outcome, options.toolResultLimit),
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
        const toolSpan = trace?.start('tool.call', 'tool', {
          'gen_ai.tool.name': tool.name,
          'tool.call_id': call.toolCallId ?? '',
          'call.index': nextCallIndex(trace, 'tool.call'),
        })
        try {
          const result = await tool.run(call.args, {
            ...(call.toolCallId ? { callId: call.toolCallId } : {}),
            emit: emitEvent,
            userMessage: currentUserMessage,
            ...(signal ? { signal } : {}),
            ...(trace && toolSpan ? { trace, span: toolSpan } : {}),
          })
          toolSpan?.end({ 'tool.ok': true })
          return { ok: true, result }
        } catch (error) {
          const mapped = (options.toolError ?? defaultToolError)(error)
          // The span names the failure by its code; a thrown message can carry customer text.
          toolSpan?.end({ 'tool.ok': false }, mapped?.code ?? 'tool_failed')
          if (mapped) return { ok: false, ...mapped }
          options.onToolFailure?.(tool.name, error)
          return { ok: false, code: 'tool_failed', message: 'The tool failed; tell the user what could not be completed.' }
        }
      },
    })) {
      if (step.kind === 'event') {
        const event = step.event
        if (event.type === 'text' && event.text) {
          // A turn that owns its trace outside createChatTurnRoutes (a Durable Object turn) gets first_text_ms here.
          trace?.markFirstText()
          if (!segmentOpen) { segments.push(''); segmentOpen = true }
          segments[segments.length - 1] += event.text
          emit({ type: 'text', segment: segments.length, delta: event.text })
        } else if (event.type === 'reasoning' && event.text) {
          reasoning.deltas++
          reasoning.chars += event.text.length
          emit({ type: 'reasoning', delta: event.text })
        } else if (event.type === 'usage') {
          addCallUsage(usage, event.usage, transportState.lastModelSpan)
          emit({ type: 'usage', ...event.usage })
        } else if (event.type === 'tool_call_start') {
          emit({ type: 'tool_start', toolName: byFunction.get(event.toolName)?.name ?? event.toolName })
        } else if (event.type === 'tool_call') {
          segmentOpen = false
          const tool = byFunction.get(event.call.toolName)
          // The loop yields this event before extracting its call. Normalize a missing id once,
          // so execution, progress, result and replay history reuse the displayed identity.
          event.call.toolCallId ||= callIdOf(undefined, event.call.toolName)
          const callId = event.call.toolCallId
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
    servedModel, toolCalls, usage: { ...usage }, reasoning: { ...reasoning }, toolEvents: [...toolEvents], ...(placement ? { placement } : {}), ...(failure ? { failure } : {}),
  })
  const repeat = options.repeat !== false
  // The safe repeat walks this chain: the next fallback model, or the same model once.
  const repeats = !repeat ? [] : options.fallbackModels?.length ? [...options.fallbackModels] : [options.model]
  let stop: ToolLoopStopReason | 'tool_limit' | 'placement_refused'
  try {
    try {
      stop = await run(options.model)
    } catch (error) {
      // Safe to repeat only while nothing was said and no tool ran.
      const next = repeats.shift()
      if (next === undefined || signal?.aborted || toolsRan > 0 || segments.length > 0) throw error
      emit({ type: 'repeat', model: next })
      stop = await run(next)
    }
  } catch (error) {
    if (signal?.aborted) return outcome({ code: 'turn_aborted', message: 'The turn was cancelled.' })
    const status = (error as { status?: unknown }).status
    // An error frame inside a 200 stream (`openai-stream`'s stream failure) keeps the service's code.
    const streamCode = (error as { streamFailure?: unknown; code?: unknown }).streamFailure === true ? (error as { code?: unknown }).code : undefined
    if (typeof streamCode === 'string' && /^[\w.-]{1,80}$/.test(streamCode)) {
      return outcome({ code: `model_stream_${streamCode}`, message: 'The model service ended the reply with an error.',
        detail: error instanceof Error ? error.message.slice(0, 1000) : streamCode })
    }
    // The stream adapter puts the service's own text after the status; keep it, short, for the app's error categories.
    const detail = error instanceof Error ? error.message.match(/\(HTTP \d+\): ([\s\S]*)$/)?.[1]?.slice(0, 1000) : undefined
    return outcome(typeof status === 'number'
      ? { code: `model_http_${status}`, status, message: 'The model service did not answer.', ...(detail ? { detail } : {}) }
      : { code: 'model_unavailable', message: 'The model service did not answer.' })
  }
  if (placementFailure) return outcome(placementFailure)
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
    const next = repeats.shift()
    if (toolsRan === 0 && next !== undefined) {
      emit({ type: 'repeat', model: next })
      try { stop = await run(next) } catch { stop = 'completed' }
      if (placementFailure) return outcome(placementFailure)
      if (stop !== 'completed') return outcome({ code: `turn_${stop}`, message: 'The reply was stopped before it finished.' })
    }
    if (!segments.some(part => part.trim())) {
      return outcome({ code: 'model_empty', message: 'The model finished without writing a reply.' })
    }
  }
  return outcome()
}

function createRouterTurnTransport(
  options: RouterTurnOptions,
  trace: RouterTurnOptions['trace'],
  transportState: { currentModel: string; lastModelSpan: TurnSpan | undefined },
  signal: RouterTurnOptions['signal'],
  attempts: number,
  attemptTimeoutMs: number | undefined,
  baseDelayMs: number,
  pause: (ms: number) => Promise<void>,
) {
  const gzipAbove = options.gzipRequestAboveBytes ?? (
    URL.canParse(options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL) &&
      new URL(options.baseUrl ?? DEFAULT_TANGLE_ROUTER_BASE_URL).origin === new URL(DEFAULT_TANGLE_ROUTER_BASE_URL).origin
      ? 32 * 1024 : undefined
  )
  const baseFetch: typeof fetch | undefined = gzipAbove !== undefined && gzipAbove >= 0
    ? gzipRequestBodies(options.fetchImpl ?? fetch, gzipAbove)
    : options.fetchImpl
  // Each HTTP send is its own `model.call` span, so a retried 503 is visible beside the send that answered.
  const sendOnce: typeof fetch | undefined = trace
    ? tracedModelFetch(trace, baseFetch ?? fetch, {
      onSpan: span => { transportState.lastModelSpan = span; span.set({ 'gen_ai.request.model': transportState.currentModel }) },
    })
    : baseFetch
  const fetchImpl: typeof fetch | undefined = signal || attempts > 1 || attemptTimeoutMs
    ? async (input, init) => {
      const firstSentAt = Date.now()
      // Resending stops once the attempts and the retry window are both spent; one attempt never resends.
      const spent = (attempt: number) => attempts === 1 || (attempt >= attempts && Date.now() - firstSentAt >= RETRY_WINDOW_MS)
      for (let attempt = 1;;attempt++) {
        signal?.throwIfAborted()
        const signals = [signal, attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined]
          .filter((value): value is AbortSignal => Boolean(value))
        const attemptSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
        const backoff = () => Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)
        // The wait before a resend is its own span, so the time between two sends is named, not a gap.
        const wait = (ms: number, reason: string) => trace
          ? trace.measure('model.retry_wait', 'other', () => pause(ms), { 'retry.attempt': attempt, 'retry.reason': reason, 'retry.wait_ms': Math.round(ms) })
          : pause(ms)
        let response: Response
        try {
          // A cancelled turn sends nothing more, whatever the injected fetch does with the signal.
          response = await (sendOnce ?? fetch)(input, { ...init, ...(attemptSignal ? { signal: attemptSignal } : {}) })
        } catch (error) {
          if (signal?.aborted || spent(attempt)) throw error
          await wait(backoff(), 'send_failed')
          continue
        }
        // Nothing has streamed yet, so a resend repeats no word and no tool.
        if (spent(attempt) || !RETRY_STATUS.has(response.status)) return response
        if (DEAD_CREDENTIAL_CATEGORIES.has(response.headers.get('x-tangle-failure-category') ?? '')) return response
        const retryAfter = Number(response.headers.get('retry-after'))
        await response.body?.cancel().catch(() => { })
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS) : backoff(), `http_${response.status}`)
      }
    }
    : sendOnce
  return { fetchImpl }
}
