import { authenticateToolRequest, type ToolHeaderNames } from './auth'
import { dispatchAppTool, outcomeStatus, type DispatchOptions } from './dispatch'
import { buildAppToolOpenAITools, type AppToolName } from './openai'
import type { AppToolDefinition } from './registry'
import { createMcpToolHandler, type McpToolCallContent } from './mcp-rpc'
import type { AppToolOutcome } from './types'

/** Define options for handling tool requests including tool identification and token verification */
export interface HandleToolRequestOptions extends DispatchOptions {
  /** Which app tool this route serves — a built-in name or a product-registered
   *  {@link AppToolDefinition} (auto-added to `customTools` for dispatch). */
  tool: AppToolName | AppToolDefinition
  /** Verify the bearer capability token belongs to the header user. */
  verifyToken: (userId: string, bearer: string) => Promise<boolean>
  headerNames?: ToolHeaderNames
  /** Optional model-facing description used by the MCP tools/list response. */
  description?: string
  /** Optional success-message builder for a friendlier tool result. */
  message?: (result: unknown) => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcRequest(value: unknown): value is Record<string, unknown> & { jsonrpc: unknown } {
  // Treat any body declaring `jsonrpc` as protocol traffic, including a bad
  // version, so it receives the shared JSON-RPC invalid-request response
  // instead of being mistaken for direct tool arguments.
  return isRecord(value) && 'jsonrpc' in value
}

function toolName(tool: AppToolName | AppToolDefinition): string {
  return typeof tool === 'string' ? tool : tool.name
}

function dispatchOptions(opts: HandleToolRequestOptions): DispatchOptions {
  return {
    ...opts,
    customTools:
      typeof opts.tool === 'string' ? opts.customTools : [...(opts.customTools ?? []), opts.tool],
  }
}

function mcpToolManifest(opts: HandleToolRequestOptions): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
} {
  const name = toolName(opts.tool)
  const tools = buildAppToolOpenAITools(opts.taxonomy, {
    ...(opts.description && typeof opts.tool === 'string'
      ? { descriptions: { [opts.tool]: opts.description } }
      : {}),
    ...(typeof opts.tool === 'string' ? {} : { customTools: [opts.tool] }),
  })
  const definition = tools.find((entry) => entry.function.name === name)
  if (!definition) {
    throw new Error(`No MCP manifest exists for app tool ${name}`)
  }
  return {
    name,
    description: definition.function.description,
    inputSchema: definition.function.parameters,
  }
}

function mcpToolResult(outcome: AppToolOutcome, opts: HandleToolRequestOptions): McpToolCallContent {
  if (!outcome.ok) {
    return {
      content: [{ type: 'text', text: `${outcome.code}: ${outcome.message}` }],
      isError: true,
    }
  }

  const value = outcome.result
  const payload = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ok: true, ...value }
    : { ok: true, value }
  return {
    content: [{ type: 'text', text: JSON.stringify({
      ...payload,
      ...(opts.message ? { message: opts.message(value) } : {}),
    }) }],
  }
}

function createAppToolMcpHandler(
  authContext: Parameters<DispatchOptions['handlers']['submitProposal']>[1],
  opts: HandleToolRequestOptions,
): (request: Request) => Promise<Response> {
  const manifest = mcpToolManifest(opts)
  return createMcpToolHandler({
    serverInfo: { name: 'agent-app-tool', version: '1' },
    tools: [{
      ...manifest,
      run: (args) => dispatchAppTool(manifest.name, args, authContext, dispatchOptions(opts)),
    }],
    buildEnv: () => ({}),
    formatResult: (result) => mcpToolResult(result as AppToolOutcome, opts),
  })
}

/**
 * Handle one app-tool HTTP request end to end — the sandbox MCP path. The
 * agent's per-turn HTTP MCP server POSTs here; this authenticates (header user
 * + capability token), reads the args (MCP-alias tolerant), dispatches to the
 * product handler, and returns a JSON Response. A product's route file becomes
 * a one-liner: `export const action = ({ request }) => handleAppToolRequest(request, cfg)`.
 */
export async function handleAppToolRequest(request: Request, opts: HandleToolRequestOptions): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

  const auth = await authenticateToolRequest(request, { verifyToken: opts.verifyToken, headerNames: opts.headerNames })
  if (!auth.ok) return auth.response

  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // The same route supports the direct app-tool HTTP shape used by the
  // OpenAI/runtime surfaces and stateless Streamable HTTP MCP JSON-RPC used by
  // OpenCode. Keeping both at this boundary prevents every consumer from
  // writing a second route just to translate protocol envelopes.
  if (isJsonRpcRequest(body)) {
    return createAppToolMcpHandler(auth.ctx, opts)(request)
  }

  if (!isRecord(body)) return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  const args = (body.args ?? body.arguments ?? body) as Record<string, unknown>

  // A custom tool passed as `tool` is registered for this dispatch so the route
  // file stays a one-liner (no separate customTools wiring needed).
  const toolName = typeof opts.tool === 'string' ? opts.tool : opts.tool.name
  const outcome = await dispatchAppTool(toolName, args, auth.ctx, dispatchOptions(opts))
  if (!outcome.ok) {
    return Response.json({ error: outcome.code, message: outcome.message }, { status: outcomeStatus(outcome) })
  }
  const payload = outcome.result as Record<string, unknown>
  return Response.json({ ok: true, ...payload, ...(opts.message ? { message: opts.message(outcome.result) } : {}) })
}
