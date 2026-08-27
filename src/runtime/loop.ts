/**
 * The bounded agent tool-loop — owned by `@tangle-network/agent-runtime`.
 *
 * A model turn may emit tool calls (integration-hub actions, the app tools from
 * `../tools`, delegation). The loop streams a turn, collects the executable tool
 * calls, dispatches each, appends the results to history in OpenAI
 * function-calling shape, and re-runs so the model reads them — bounded by
 * `maxToolTurns`, a wall-clock `deadlineMs`, and a `maxCostUsd` budget.
 *
 * The history shape is the OpenAI function-calling contract: the assistant turn
 * that emitted tool calls is preserved as an `assistant` message carrying its
 * `tool_calls` array, and each result is its own `{ role: 'tool', tool_call_id,
 * content }` message keyed to the call. A strict model (Claude, and any
 * OpenAI-compatible provider that validates tool history) needs this to read its
 * own tool use back; folding results into a `user` message makes such models
 * re-issue the same call in a loop.
 *
 * The loop is substrate-owned (`runToolLoop` / `streamToolLoop`); the app
 * supplies `streamTurn` (wrapping its model endpoint) and `executeToolCall`
 * (routing to its integration + app-tool executors). The app-facing names below
 * are 1:1 aliases of the canonical symbols, kept so this package's consumers and
 * the in-package `createAgentRuntime` read against a single, stable vocabulary.
 *
 * This is the LEAF the runtime barrel and its children both import — keeping the
 * tool-loop vocabulary out of any import cycle. The barrel re-exports it.
 */

export {
  runToolLoop as runAppToolLoop,
  streamToolLoop as streamAppToolLoop,
} from '@tangle-network/agent-runtime'
export type {
  ToolLoopCall as LoopToolCall,
  ToolLoopAssistantToolCall as LoopAssistantToolCall,
  ToolLoopMessage as LoopMessage,
  ToolLoopEvent,
  ToolLoopStopReason,
  ToolLoopResult,
  RunToolLoopOptions as AppToolLoopOptions,
  StreamToolLoopOptions as StreamAppToolLoopOptions,
  StreamToolLoopYield as StreamLoopYield,
} from '@tangle-network/agent-runtime'

/**
 * Events the app's OpenAI-compat stream adapter ({@link toLoopEvents}) yields.
 *
 * This is the app's own `Raw` event type for the streaming loop — the canonical
 * `streamToolLoop<Raw>` is generic over it. It widens the substrate's
 * tool-loop event with `reasoning` (DeepSeek/router `reasoning_content` /
 * `thinking` deltas, rendered as thinking sections) and `usage` (per-message
 * token accounting) — neither belongs in the substrate's loop contract, so they
 * stay here. The adapter maps each into the `streamTurn` seam; `text` and
 * `tool_call` drive the loop, `reasoning` / `usage` pass through to the UI.
 */
export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: import('@tangle-network/agent-runtime').ToolLoopCall }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number } }
  | { type: 'other'; event: unknown }
