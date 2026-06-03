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
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
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
