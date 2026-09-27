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
export declare const MCP_PROTOCOL_VERSIONS: readonly ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Resolve a valid protocol version from the predefined MCP_PROTOCOL_VERSIONS array */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
/** Describe the structure of server information including name and version */
export interface McpServerInfo {
    name: string;
    version: string;
}
/** One tool entry in the registry the handler owns. */
export interface McpToolDefinition<TEnv = Record<string, never>> {
    name: string;
    description: string;
    /** JSON Schema for the `params.arguments` object. */
    inputSchema: Record<string, unknown>;
    /** Receive validated (Record) args + the env the handler threaded; throw to
     *  surface an isError result — never throw for protocol/framing issues. */
    run(args: Record<string, unknown>, env: TEnv): Promise<unknown>;
}
/** Define options for creating a handler that manages MCP tools with environment support */
export interface CreateMcpToolHandlerOptions<TEnv = Record<string, never>> {
    serverInfo: McpServerInfo;
    /** Full tool list; order IS the tools/list order. */
    tools: McpToolDefinition<TEnv>[];
    /** Per-request environment threaded into every `run` call. If your tools are
     *  stateless (or carry state through closure) pass an empty builder:
     *  `() => ({} as TEnv)`. */
    buildEnv(request: Request): TEnv | Promise<TEnv>;
    /** Optional result formatter for callers that need structured tool errors. */
    formatResult?: (result: unknown, tool: McpToolDefinition<TEnv>) => McpToolCallContent;
}
export interface McpToolCallContent {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: true;
}
/**
 * Build a request handler for a tools-only MCP server. The returned function
 * accepts a standard `Request` and resolves to a `Response` — mount it on any
 * Cloudflare Worker route or Remix `loader`.
 *
 * The handler calls `buildEnv` exactly ONCE per `tools/call` request (after
 * the tool is found, before `run`) — non-`tools/call` paths skip it entirely
 * so metadata requests do not pay env-build cost.
 */
export declare function createMcpToolHandler<TEnv = Record<string, never>>(opts: CreateMcpToolHandlerOptions<TEnv>): (request: Request) => Promise<Response>;
