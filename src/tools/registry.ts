import { isAppToolName } from './openai'
import type { AppToolContext } from './types'
import type { OpenAIFunctionTool } from './openai'

/**
 * A product-defined app tool — the open registration seam.
 *
 * The four built-ins (`submit_proposal`/`schedule_followup`/`render_ui`/
 * `add_citation`) are mechanism and stay hard-typed. This is how a product adds
 * a fifth+ tool (e.g. gtm-agent's `set_config`) WITHOUT forking the shell: the
 * `name` + JSON-Schema `parameters` are what the model sees, and `execute` is
 * dispatched through the SAME validation/outcome path as the built-ins — a
 * thrown {@link ToolInputError} becomes a correctable 4xx, any other throw an
 * internal error, and a tool call never silently "succeeds" without its effect.
 */
export interface AppToolDefinition<Args = Record<string, unknown>> {
  /** Stable identifier the model calls (and the MCP server name). Must not
   *  collide with a built-in app tool. */
  name: string
  /** Model-facing description. */
  description: string
  /** JSON-Schema for the parameters (the OpenAI `function.parameters` object). */
  parameters: Record<string, unknown>
  /** Default route path the per-turn MCP server / HTTP handler is mounted at.
   *  Overridable per call via `paths`/`buildHttpMcpServer`. */
  path?: string
  /** Fulfil the call; the return value is the tool result the model sees.
   *  `ctx` is the trusted per-turn identity (never from tool args). */
  execute: (args: Args, ctx: AppToolContext) => Promise<unknown> | unknown
}

/**
 * Validate + brand a product tool definition. Throws when the name is empty or
 * collides with a built-in (those are reserved mechanism). Identity otherwise —
 * call it at module scope so a bad definition fails at boot, not first use.
 */
export function defineAppTool<Args = Record<string, unknown>>(def: AppToolDefinition<Args>): AppToolDefinition<Args> {
  const name = def.name?.trim()
  if (!name) throw new Error('defineAppTool: name is required')
  if (isAppToolName(name)) throw new Error(`defineAppTool: "${name}" is a built-in app tool — choose a different name`)
  if (typeof def.execute !== 'function') throw new Error(`defineAppTool: "${name}" needs an execute() handler`)
  return def
}

/** The OpenAI function-tool def for a custom tool — appended to the built-ins by
 *  `buildAppToolOpenAITools`. */
export function customToolToOpenAI(def: AppToolDefinition): OpenAIFunctionTool {
  return { type: 'function', function: { name: def.name, description: def.description, parameters: def.parameters } }
}

/** Find a registered custom tool by the name the model called. */
export function findCustomTool(
  name: string,
  tools: readonly AppToolDefinition[] | undefined,
): AppToolDefinition | undefined {
  return tools?.find((t) => t.name === name)
}
