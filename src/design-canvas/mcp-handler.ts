/**
 * Streamable-HTTP MCP server for one design-canvas document — the live
 * agent→canvas channel. JSON-RPC 2.0 over POST, stateless per request
 * (Workers-compatible: no session table, no SSE).
 *
 * Trust boundary: the product authenticates the request (capability token,
 * workspace RBAC) BEFORE constructing the scoped {@link SceneStore} and
 * calling this handler — the handler trusts its store completely. Tool
 * execution failures (argument shape, validation, stale rev) become `isError`
 * tool results carrying the thrown message verbatim so the model can read WHY
 * and retry.
 *
 * The JSON-RPC envelope (initialize/ping/tools/list/tools/call, -32601) lives
 * in {@link createMcpToolHandler}; this module wires the canvas tool list +
 * the caller-supplied id-minting function.
 */

import type { SceneStore } from './store'
import { CANVAS_MCP_TOOLS } from './mcp-tools'
import type { DesignCanvasMcpToolEnv } from './mcp-tools'
import { createMcpToolHandler } from '../tools/mcp-rpc'

export interface DesignCanvasMcpServerInfo {
  name: string
  version: string
}

export interface CreateDesignCanvasMcpHandlerOptions {
  /** Already scoped + authorized for one (workspace, document, actor). */
  store: SceneStore
  /** Id-minting function threaded into every mutating tool. Must return
   *  a string unique within the document scope — use crypto.randomUUID()
   *  in production; a deterministic counter in tests. */
  mintId: () => string
  serverInfo?: DesignCanvasMcpServerInfo
}

export function createDesignCanvasMcpHandler(
  opts: CreateDesignCanvasMcpHandlerOptions,
): (request: Request) => Promise<Response> {
  const serverInfo = opts.serverInfo ?? { name: 'design-canvas', version: '1.0.0' }

  return createMcpToolHandler<DesignCanvasMcpToolEnv>({
    serverInfo,
    tools: CANVAS_MCP_TOOLS,
    buildEnv: (_request) => ({ store: opts.store, mintId: opts.mintId }),
  })
}
