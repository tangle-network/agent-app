export * from './model'
export * from './openai-stream'
export * from './agent'
/**
 * The bounded agent tool-loop — the mechanism every app's chat runtime
 * hand-rolls on top of `@tangle-network/agent-runtime`.
 *
 * A model turn may emit tool calls (integration-hub actions, the app tools from
 * `../tools`, delegation). The loop: stream a turn, collect the executable tool
 * calls, stop if there are none / no executor / the turn cap is hit, otherwise
 * execute each, fold the results back as a message, and re-run so the model
 * reads them. Bounded by `maxToolTurns` so a model looping on a failing action
 * can't run forever.
 *
 * Substrate-free by design: the app supplies `streamTurn` (wrapping whatever
 * backend / `runAgentTaskStream` it uses) and `executeToolCall` (routing to its
 * integration + app-tool executors). This package owns the LOOP; the app owns
 * the model and the executors.
 *
 * LAYERING NOTE: this turn-level tool-dispatch loop is a generic RUNTIME
 * capability. It has been CONTRIBUTED DOWN and MERGED into
 * `@tangle-network/agent-runtime` as `runToolLoop` / `streamToolLoop` (PR #137),
 * but is not yet PUBLISHED (agent-runtime main is ahead of its last npm release;
 * cutting that release is the agent-runtime maintainer's call). TERMINAL STATE:
 * the moment agent-runtime publishes a version carrying #137, bump the
 * `@tangle-network/agent-runtime` peer-dep here and replace the bodies below with
 * a thin re-export — `streamAppToolLoop = streamToolLoop`, `runAppToolLoop =
 * runToolLoop` (types alias 1:1; `AppToolOutcome` ≡ `ToolCallOutcome`). Kept
 * substrate-free + shipping until then so consumers aren't blocked on the release.
 */
import type { AppToolOutcome } from '../tools/types'

export interface LoopToolCall {
  toolCallId?: string
  toolName: string
  args: Record<string, unknown>
}

/** Events a turn stream yields. `text` accumulates into the final answer;
 *  `tool_call` is collected for dispatch. Extra event types pass through
 *  untouched (the caller re-emits them to its own UI stream). */
export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: LoopToolCall }
  | { type: 'other'; event: unknown }

export interface ToolLoopResult {
  /** The model's final text across the loop. */
  finalText: string
  /** Every tool call executed, with its outcome, in order. */
  toolResults: Array<{ call: LoopToolCall; label: string; outcome: AppToolOutcome }>
  /** Number of model turns run (1 + tool-driven re-runs). */
  turns: number
  /** True when the loop stopped because it hit `maxToolTurns` with calls still pending. */
  cappedOut: boolean
}

export interface AppToolLoopOptions {
  systemPrompt: string
  userMessage: string
  priorMessages?: Array<{ role: string; content: string }>
  /** Stream one model turn over the running message list. The app wraps its
   *  backend here. */
  streamTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<LoopEvent>
  /** Execute one tool call. The app routes to its integration executor / app-tool
   *  executor and returns the outcome. */
  executeToolCall: (call: LoopToolCall) => Promise<AppToolOutcome>
  /** Which emitted tool names are executable (others are ignored — e.g. a UI-only
   *  tool the app renders but doesn't run here). */
  isExecutableTool: (toolName: string) => boolean
  /** Max tool-driven re-runs. Default 8. */
  maxToolTurns?: number
  /** Render one tool outcome as a line the next turn's message carries. Default
   *  is a compact `- <label> → ok/failed: …`. */
  renderResult?: (label: string, outcome: AppToolOutcome) => string
  /** Map a tool call to the label its result is keyed under (default: toolName). */
  labelFor?: (call: LoopToolCall) => string
}

const DEFAULT_MAX_TOOL_TURNS = 8

function defaultRender(label: string, outcome: AppToolOutcome): string {
  if (outcome.ok) return `- ${label} → ok: ${JSON.stringify(outcome.result)}`
  return `- ${label} → failed (${outcome.code}): ${outcome.message}`
}

/**
 * Run the bounded tool loop and return the final text + every executed tool
 * outcome. Yields nothing — it's an awaitable driver; callers that need to
 * re-emit events to a UI stream should do so inside `streamTurn`. (A streaming
 * variant can wrap this later; keeping the core awaitable makes it trivially
 * testable.)
 */
export async function runAppToolLoop(opts: AppToolLoopOptions): Promise<ToolLoopResult> {
  const maxTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
  const render = opts.renderResult ?? defaultRender
  const labelFor = opts.labelFor ?? ((c: LoopToolCall) => c.toolName)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.priorMessages ?? []),
    { role: 'user', content: opts.userMessage },
  ]

  const toolResults: ToolLoopResult['toolResults'] = []
  let finalText = ''
  let turns = 0

  for (let toolTurn = 0; ; toolTurn++) {
    turns++
    let turnText = ''
    const pending: LoopToolCall[] = []

    for await (const ev of opts.streamTurn([...messages])) {
      if (ev.type === 'text') {
        turnText += ev.text
        finalText += ev.text
      } else if (ev.type === 'tool_call' && opts.isExecutableTool(ev.call.toolName)) {
        pending.push(ev.call)
      }
    }

    if (pending.length === 0) break
    if (toolTurn >= maxTurns) {
      return { finalText, toolResults, turns, cappedOut: true }
    }

    // Record the assistant's tool-calling turn so the next turn has its context.
    if (turnText.trim()) messages.push({ role: 'assistant', content: turnText })

    const lines: string[] = []
    for (const call of pending) {
      let outcome: AppToolOutcome
      try {
        outcome = await opts.executeToolCall(call)
      } catch (err) {
        outcome = { ok: false, code: 'executor_error', message: err instanceof Error ? err.message : String(err) }
      }
      const label = labelFor(call)
      toolResults.push({ call, label, outcome })
      lines.push(render(label, outcome))
    }
    // Fold every outcome back as one user-role message so the model reads them.
    messages.push({ role: 'user', content: `Tool results:\n${lines.join('\n')}` })
  }

  return { finalText, toolResults, turns, cappedOut: false }
}

// ── Streaming variant ──────────────────────────────────────────────────────
//
// `runAppToolLoop` is awaitable — perfect for tests and drain-only callers. A
// real chat runtime instead needs to STREAM each model event to the client (SSE)
// AND record telemetry per event as it happens. `streamAppToolLoop` is the same
// bounded loop as an async generator: it yields every raw turn event (the app
// maps + telemetries + re-emits it) and every executed tool result (same), while
// owning the loop control flow (collect → stop/dispatch → fold → re-run, capped).
// `Raw` is the app's own runtime-event type — this package stays substrate-free.

export type StreamLoopYield<Raw> =
  | { kind: 'event'; event: Raw }
  | { kind: 'tool_result'; toolName: string; toolCallId?: string; label: string; outcome: AppToolOutcome }
  | { kind: 'capped'; pending: number }

export interface StreamAppToolLoopOptions<Raw> {
  systemPrompt: string
  userMessage: string
  priorMessages?: Array<{ role: string; content: string }>
  /** Stream one model turn (the app wraps its backend / runAgentTaskStream). */
  streamTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<Raw>
  /** Text contribution of a raw event, '' if none — used to record the
   *  assistant's turn so the next turn has its context. */
  extractText: (event: Raw) => string
  /** The tool call a raw event represents, or null. */
  extractToolCall: (event: Raw) => LoopToolCall | null
  /** Which tool names are executable here (others pass through, unexecuted). */
  isExecutableTool: (toolName: string) => boolean
  /** Execute one call — the app routes to its integration / app-tool executor. */
  executeToolCall: (call: LoopToolCall) => Promise<AppToolOutcome>
  maxToolTurns?: number
  renderResult?: (label: string, outcome: AppToolOutcome) => string
  labelFor?: (call: LoopToolCall) => string
}

/**
 * The streaming bounded tool loop. Yields `event` for each raw turn event and
 * `tool_result` for each executed tool; emits a single `capped` when it stops at
 * the turn limit with calls still pending. The app drives telemetry + UI
 * emission off the yielded items.
 */
export async function* streamAppToolLoop<Raw>(opts: StreamAppToolLoopOptions<Raw>): AsyncGenerator<StreamLoopYield<Raw>, void, unknown> {
  const maxTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
  const render = opts.renderResult ?? defaultRender
  const labelFor = opts.labelFor ?? ((c: LoopToolCall) => c.toolName)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.priorMessages ?? []),
    { role: 'user', content: opts.userMessage },
  ]

  for (let toolTurn = 0; ; toolTurn++) {
    let turnText = ''
    const pending: LoopToolCall[] = []

    for await (const event of opts.streamTurn([...messages])) {
      yield { kind: 'event', event }
      turnText += opts.extractText(event)
      const call = opts.extractToolCall(event)
      if (call && opts.isExecutableTool(call.toolName)) pending.push(call)
    }

    if (pending.length === 0) return
    if (toolTurn >= maxTurns) {
      yield { kind: 'capped', pending: pending.length }
      return
    }

    if (turnText.trim()) messages.push({ role: 'assistant', content: turnText })

    const lines: string[] = []
    for (const call of pending) {
      let outcome: AppToolOutcome
      try {
        outcome = await opts.executeToolCall(call)
      } catch (err) {
        outcome = { ok: false, code: 'executor_error', message: err instanceof Error ? err.message : String(err) }
      }
      const label = labelFor(call)
      yield { kind: 'tool_result', toolName: call.toolName, toolCallId: call.toolCallId, label, outcome }
      lines.push(render(label, outcome))
    }
    messages.push({ role: 'user', content: `Tool results:\n${lines.join('\n')}` })
  }
}
