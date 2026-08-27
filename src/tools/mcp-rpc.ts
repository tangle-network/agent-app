/**
 * Generic streamable-HTTP JSON-RPC 2.0 envelope for a tools-only MCP server.
 * Stateless, Workers-compatible: no session table, no SSE — every request gets
 * a single `application/json` response, which the streamable-HTTP transport
 * explicitly permits for tools-only servers.
 *
 * Protocol surface:
 *   initialize   → echo client's protocolVersion if supported, else latest
 *   ping         → empty result {}
 *   notifications/* (no `id`)  → 202 with no body
 *   tools/list   → tool manifest
 *   tools/call   → run + surface execution failures as isError text results
 *   anything else → -32601
 *
 * Execution failures (argument shape, validation, store throws) become `isError`
 * tool results carrying the thrown message verbatim — the model reads WHY and
 * retries. Protocol misuse becomes a JSON-RPC error object.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
/** Resolve a valid protocol version from the predefined MCP_PROTOCOL_VERSIONS array */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number]

const LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0]

/** Describe the structure of server information including name and version */
export interface McpServerInfo {
  name: string
  version: string
}

/** One tool entry in the registry the handler owns. */
export interface McpToolDefinition<TEnv = Record<string, never>> {
  name: string
  description: string
  /** JSON Schema for the `params.arguments` object. */
  inputSchema: Record<string, unknown>
  /** Receive validated (Record) args + the env the handler threaded; throw to
   *  surface an isError result — never throw for protocol/framing issues. */
  run(args: Record<string, unknown>, env: TEnv): Promise<unknown>
}

/** Define options for creating a handler that manages MCP tools with environment support */
export interface CreateMcpToolHandlerOptions<TEnv = Record<string, never>> {
  serverInfo: McpServerInfo
  /** Full tool list; order IS the tools/list order. */
  tools: McpToolDefinition<TEnv>[]
  /** Per-request environment threaded into every `run` call. If your tools are
   *  stateless (or carry state through closure) pass an empty builder:
   *  `() => ({} as TEnv)`. */
  buildEnv(request: Request): TEnv | Promise<TEnv>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null

interface ToolCallContent {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a request handler for a tools-only MCP server. The returned function
 * accepts a standard `Request` and resolves to a `Response` — mount it on any
 * Cloudflare Worker route or Remix `loader`.
 *
 * The handler calls `buildEnv` exactly ONCE per `tools/call` request (after
 * the tool is found, before `run`) — non-`tools/call` paths skip it entirely
 * so metadata requests do not pay env-build cost.
 */
export function createMcpToolHandler<TEnv = Record<string, never>>(
  opts: CreateMcpToolHandlerOptions<TEnv>,
): (request: Request) => Promise<Response> {
  const toolMap = new Map<string, McpToolDefinition<TEnv>>()
  for (const tool of opts.tools) {
    if (toolMap.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`)
    toolMap.set(tool.name, tool)
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('MCP server accepts JSON-RPC 2.0 over POST only', {
        status: 405,
        headers: { Allow: 'POST' },
      })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return rpcError(null, -32700, 'Parse error: request body is not valid JSON', 400)
    }

    if (Array.isArray(body)) {
      return rpcError(null, -32600, 'Invalid request: JSON-RPC batching is not supported', 400)
    }
    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return rpcError(
        null,
        -32600,
        'Invalid request: expected a JSON-RPC 2.0 object with jsonrpc "2.0" and a string method',
        400,
      )
    }

    const method = body.method
    const params = isRecord(body.params) ? body.params : {}

    // Notifications have no `id` — acknowledge without a JSON-RPC body.
    if (!('id' in body) || body.id === undefined) {
      return new Response(null, { status: 202 })
    }
    const id = body.id as JsonRpcId

    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
        const protocolVersion =
          requested !== undefined && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: opts.serverInfo,
        })
      }

      case 'ping':
        return rpcResult(id, {})

      case 'tools/list':
        return rpcResult(id, {
          tools: opts.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })

      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string' || name.length === 0) {
          return rpcError(id, -32602, 'tools/call requires params.name (string)')
        }
        const tool = toolMap.get(name)
        if (!tool) {
          return rpcError(
            id,
            -32602,
            `Unknown tool: ${name}. Available tools: ${opts.tools.map((t) => t.name).join(', ')}`,
          )
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
          return rpcError(id, -32602, 'tools/call params.arguments must be an object when provided')
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        let env: TEnv
        try {
          env = await opts.buildEnv(request)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const payload: ToolCallContent = {
            content: [{ type: 'text', text: `${name} failed to build env: ${message}` }],
            isError: true,
          }
          return rpcResult(id, payload)
        }
        try {
          const result = await tool.run(args, env)
          const payload: ToolCallContent = { content: [{ type: 'text', text: JSON.stringify(result) }] }
          return rpcResult(id, payload)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const payload: ToolCallContent = {
            content: [{ type: 'text', text: `${name} failed: ${message}` }],
            isError: true,
          }
          return rpcResult(id, payload)
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}
