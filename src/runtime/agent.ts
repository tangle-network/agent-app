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
} from './loop'
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

/** The agent's resolved profile surfaces for one turn — the things a delivered
 *  / certified `AgentProfile` can change. Profile-WIDE on purpose: certified
 *  delivery folds prompt-surface + skills into `systemPrompt` AND can add
 *  certified `tool` artifacts to `extraTools` (the model's advertised tools is
 *  rebuilt when these change). MCP servers / memory / RAG that materialize as
 *  files or servers deliver through the sandbox-provisioning seam, not here. */
export interface ResolvedAgentProfile {
  systemPrompt: string
  extraTools: unknown[]
}

/** Define options for creating an agent runtime including model config and optional profile transformation */
export interface CreateAgentRuntimeOptions {
  /** The model endpoint the turns stream from. */
  model: AgentRuntimeModelConfig
  /**
   * Optional transform applied to the resolved profile surfaces each turn —
   * the seam for certified-artifact delivery (`createCertifiedDelivery`). It is
   * profile-WIDE (not prompt-only): it returns the effective `systemPrompt` +
   * advertised `extraTools`. Kept generic + injected so this substrate-free core
   * never imports `@tangle-network/agent-runtime`. Fail-closed by contract: an
   * impl that can't reach the plane returns the base surfaces unchanged.
   */
  composeProfile?: (base: ResolvedAgentProfile) => ResolvedAgentProfile | Promise<ResolvedAgentProfile>
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

/** Define options for configuring a single agent turn including context, prior messages, prompts, and event handlers */
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

/** Resolve and stream tool execution loops with final results and intermediate events for agent runtime */
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
  const m = opts.model
  const buildStreamTurn = (extraTools: unknown[]) =>
    createOpenAICompatStreamTurn({
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      model: m.model,
      tools: [...buildAppToolOpenAITools(opts.taxonomy), ...extraTools],
      temperature: m.temperature,
      fetchImpl: m.fetchImpl,
      extraBody: m.extraBody,
    })

  // The advertised tool set is stable across turns UNLESS a delivered profile
  // changes `extraTools` (certified-tool delivery, on the cache-refresh cadence
  // — not per turn). Memoize the streamTurn by the active extraTools identity so
  // it rebuilds only when the certified tools actually change.
  const baseExtraTools = opts.extraTools ?? []
  let activeExtraTools = baseExtraTools
  let activeStreamTurn = buildStreamTurn(baseExtraTools)
  const streamTurnFor = (extraTools: unknown[]) => {
    if (extraTools !== activeExtraTools) {
      activeExtraTools = extraTools
      activeStreamTurn = buildStreamTurn(extraTools)
    }
    return activeStreamTurn
  }

  // Resolve the per-turn profile surfaces, applying the optional profile
  // transform (certified-artifact delivery). Profile-wide: system prompt +
  // advertised tools.
  const resolveProfile = async (turn: AgentTurnOptions): Promise<ResolvedAgentProfile> => {
    const base: ResolvedAgentProfile = {
      systemPrompt: turn.systemPrompt ?? opts.systemPrompt,
      extraTools: baseExtraTools,
    }
    return opts.composeProfile ? opts.composeProfile(base) : base
  }

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
    async run(userMessage, turn) {
      const profile = await resolveProfile(turn)
      return runAppToolLoop({
        systemPrompt: profile.systemPrompt,
        userMessage,
        priorMessages: turn.priorMessages,
        // The awaitable loop consumes only text + tool_call; the app's UI-only
        // reasoning/usage events ride the substrate's `other` channel.
        streamTurn: narrowToToolLoopEvents(streamTurnFor(profile.extraTools)),
        executeToolCall: buildExecutor(turn),
        isExecutableTool,
        maxToolTurns: opts.maxToolTurns,
      })
    },
    async *stream(userMessage, turn) {
      const profile = await resolveProfile(turn)
      yield* streamAppToolLoop<LoopEvent>({
        systemPrompt: profile.systemPrompt,
        userMessage,
        priorMessages: turn.priorMessages,
        streamTurn: streamTurnFor(profile.extraTools),
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
