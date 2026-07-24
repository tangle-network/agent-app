import { dispatchAppTool, type DispatchOptions } from './dispatch'
import type { AppToolContext, AppToolOutcome } from './types'

/** Executes an app-tool call the model emits on the agent-runtime chat path.
 *  Plug into `runChatThroughRuntime({ appToolExecutor })` (or any loop that
 *  dispatches function tool_calls). */
export type AppToolRuntimeExecutor = (call: {
  toolName: string
  args: Record<string, unknown>
}) => Promise<AppToolOutcome>

/** Define options for executing runtime tasks with a trusted per-turn context */
export interface RuntimeExecutorOptions extends DispatchOptions {
  /** The trusted per-turn context — supplied directly (not from headers), since
   *  the runtime path has no HTTP request. */
  ctx: AppToolContext
}

/**
 * Build the runtime executor for one turn. The agent-runtime backend must also
 * advertise the tools (`buildAppToolOpenAITools(taxonomy)` on the backend's
 * `tools`) for the model to call them; this executor fulfils each call against
 * the product's handlers and emits produced events via `opts.onProduced`.
 */
export function createAppToolRuntimeExecutor(opts: RuntimeExecutorOptions): AppToolRuntimeExecutor {
  return ({ toolName, args }) => dispatchAppTool(toolName, args, opts.ctx, opts)
}
