/**
 * `createAgentRuntime` — the in-process agent core, assembled.
 *
 * The bricks to run an agent turn WITHOUT a sandbox already exist in this
 * package, but a consumer must hand-wire five of them every time: resolve the
 * model config, build the OpenAI tool schemas from the taxonomy, build a
 * `streamTurn` over the model endpoint, build an `executeToolCall` over the
 * product's handlers, and drive `runAppToolLoop` / `streamAppToolLoop` with an
 * `isExecutableTool` predicate. That boilerplate is identical across every
 * sandbox-free surface (an edge/browser copilot, an eval harness, a Node CLI),
 * and getting it subtly wrong — e.g. NOT advertising the tools, so the model
 * never emits a `tool_call` and no side effect ever fires — is exactly the
 * failure that makes a tool-driven agent score zero off-sandbox.
 *
 * This factory bundles those five into one object configured for ONE agent:
 *
 *   const runtime = createAgentRuntime({ model, taxonomy, handlers, systemPrompt })
 *   const result = await runtime.run(userMessage, { ctx })            // awaitable
 *   for await (const y of runtime.stream(userMessage, { ctx })) {…}   // streaming
 *
 * The model is advertised the app tools (so it CAN call them); each call is
 * dispatched against the product's `handlers` (so the side effect is real); the
 * `onProduced` hook fires at the real side-effect site (so an eval/UI credits a
 * persisted proposal or artifact). Substrate-free: no `@tangle-network/sandbox`,
 * no Durable Object, no `@tangle-network/agent-runtime` import. The SAME core
 * the Cloudflare Worker runs, runnable anywhere a `fetch` to an OpenAI-compatible
 * endpoint works.
 *
 * Domain stays out: the proposal taxonomy, the handlers, and the system prompt
 * are all injected — the factory knows nothing about insurance, law, tax, etc.
 */
import {
  type AppToolHandlers,
  type AppToolContext,
  type AppToolOutcome,
  type AppToolProducedEvent,
  type AppToolTaxonomy,
} from '../tools/types'
import { buildAppToolOpenAITools, isAppToolName } from '../tools/openai'
import { createAppToolRuntimeExecutor } from '../tools/runtime'
import {
  runAppToolLoop,
  streamAppToolLoop,
  type LoopEvent,
  type LoopMessage,
  type LoopToolCall,
  type StreamLoopYield,
  type ToolLoopEvent,
  type ToolLoopResult,
} from './index'
import { createOpenAICompatStreamTurn } from './openai-stream'

/** OpenAI-compatible model endpoint (Tangle Router / tcloud / any compat
 *  provider). Build from {@link resolveTangleModelConfig} or pass literals. */
export interface AgentRuntimeModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  fetchImpl?: typeof fetch
  /** Extra request-body fields (e.g. `max_tokens`, a `reasoning` block). */
  extraBody?: Record<string, unknown>
}

export interface CreateAgentRuntimeOptions {
  /** The model endpoint the turns stream from. */
  model: AgentRuntimeModelConfig
  /** The product's proposal taxonomy — advertises `submit_proposal`'s `type`
   *  enum to the model and labels the regulated subset on the result. */
  taxonomy: AppToolTaxonomy
  /** Domain handlers persisting each tool to the product's store/vault. */
  handlers: AppToolHandlers
  /** Default agent identity / system prompt. A turn may override it. */
  systemPrompt: string
  /** Runaway-backstop cap. Default 200 — set far above any legitimate workflow.
   *  For per-workflow limits use `deadlineMs` or `maxCostUsd` on the loop options. */
  maxToolTurns?: number
  /** Extra OpenAI tool definitions advertised ALONGSIDE the four app tools
   *  (e.g. `integration_invoke`). Pair with {@link executeOtherTool}. */
  extraTools?: unknown[]
  /** Execute a tool that is NOT one of the four app tools (e.g. an integration
   *  action). Only consulted for names {@link isOtherExecutableTool} accepts. */
  executeOtherTool?: (call: LoopToolCall, ctx: AppToolContext) => Promise<AppToolOutcome>
  /** Which non-app tool names are executable here. Required if {@link executeOtherTool} is set. */
  isOtherExecutableTool?: (toolName: string) => boolean
}

export interface AgentTurnOptions {
  /** The trusted per-turn context (who/where the turn runs as). */
  ctx: AppToolContext
  /** Prior conversation turns, in order. */
  priorMessages?: Array<{ role: string; content: string }>
  /** Override the factory's default system prompt for this turn. */
  systemPrompt?: string
  /** Fires at the real side-effect site for each produced proposal/artifact. */
  onProduced?: (event: AppToolProducedEvent) => void
}

export interface AgentRuntime {
  /** Run the bounded tool loop to completion; resolve with final text + every
   *  executed tool outcome. */
  run(userMessage: string, turn: AgentTurnOptions): Promise<ToolLoopResult>
  /** Stream the bounded tool loop: yields each raw model event and each executed
   *  tool result as it happens (for SSE re-emission + telemetry). */
  stream(userMessage: string, turn: AgentTurnOptions): AsyncGenerator<StreamLoopYield<LoopEvent>, void, unknown>
}

/**
 * Create an in-process agent runtime for one agent. See the module doc for the
 * full rationale; the short version: it advertises the app tools to the model,
 * dispatches each emitted call against `handlers`, and drives the bounded loop —
 * the whole agent core, sandbox-free.
 */
export function createAgentRuntime(opts: CreateAgentRuntimeOptions): AgentRuntime {
  if (opts.executeOtherTool && !opts.isOtherExecutableTool) {
    throw new Error('createAgentRuntime: isOtherExecutableTool is required when executeOtherTool is set')
  }

  // Tool schemas + the streamTurn are stable across turns — build once. The
  // model MUST be advertised the tools or it never emits a tool_call (the exact
  // failure that scores a tool-driven agent zero off-sandbox).
  const tools = [...buildAppToolOpenAITools(opts.taxonomy), ...(opts.extraTools ?? [])]
  const m = opts.model
  const streamTurn = createOpenAICompatStreamTurn({
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    tools,
    temperature: m.temperature,
    fetchImpl: m.fetchImpl,
    extraBody: m.extraBody,
  })

  const isExecutableTool = (name: string): boolean =>
    isAppToolName(name) || (opts.isOtherExecutableTool?.(name) ?? false)

  const buildExecutor = (turn: AgentTurnOptions) => {
    const appExecutor = createAppToolRuntimeExecutor({
      handlers: opts.handlers,
      taxonomy: opts.taxonomy,
      ctx: turn.ctx,
      onProduced: turn.onProduced,
    })
    return async (call: LoopToolCall): Promise<AppToolOutcome> => {
      if (isAppToolName(call.toolName)) return appExecutor({ toolName: call.toolName, args: call.args })
      if (opts.executeOtherTool && opts.isOtherExecutableTool?.(call.toolName)) {
        return opts.executeOtherTool(call, turn.ctx)
      }
      return { ok: false, code: 'unknown_tool', message: `No executor for tool: ${call.toolName}` }
    }
  }

  return {
    run(userMessage, turn) {
      return runAppToolLoop({
        systemPrompt: turn.systemPrompt ?? opts.systemPrompt,
        userMessage,
        priorMessages: turn.priorMessages,
        // The awaitable loop consumes only text + tool_call; the app's UI-only
        // reasoning/usage events ride the substrate's `other` channel.
        streamTurn: narrowToToolLoopEvents(streamTurn),
        executeToolCall: buildExecutor(turn),
        isExecutableTool,
        maxToolTurns: opts.maxToolTurns,
      })
    },
    stream(userMessage, turn) {
      return streamAppToolLoop<LoopEvent>({
        systemPrompt: turn.systemPrompt ?? opts.systemPrompt,
        userMessage,
        priorMessages: turn.priorMessages,
        streamTurn,
        extractText: (ev) => (ev.type === 'text' ? ev.text : ''),
        extractToolCall: (ev) => (ev.type === 'tool_call' ? ev.call : null),
        isExecutableTool,
        executeToolCall: buildExecutor(turn),
        maxToolTurns: opts.maxToolTurns,
      })
    },
  }
}

/**
 * Adapt the app's rich {@link LoopEvent} stream to the substrate awaitable
 * loop's `ToolLoopEvent` contract. The loop reads only `text` (accumulated into
 * the answer) and `tool_call` (dispatched); the app's UI-only `reasoning` /
 * `usage` events have no awaitable meaning, so they collapse onto the
 * substrate's `other` channel and are ignored by the loop.
 */
function narrowToToolLoopEvents(
  streamTurn: (messages: LoopMessage[]) => AsyncIterable<LoopEvent>,
): (messages: LoopMessage[]) => AsyncIterable<ToolLoopEvent> {
  return (messages) =>
    (async function* () {
      for await (const ev of streamTurn(messages)) {
        if (ev.type === 'text') yield { type: 'text', text: ev.text }
        else if (ev.type === 'tool_call') yield { type: 'tool_call', call: ev.call }
        else yield { type: 'other', event: ev }
      }
    })()
}
