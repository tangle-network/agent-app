/**
 * Streamable-HTTP MCP server for one sequence — the live agent→timeline
 * channel. JSON-RPC 2.0 over POST, stateless per request (Workers-compatible:
 * no session table, no SSE — a tools-only server answers every request with a
 * single `application/json` body, which the streamable-HTTP transport
 * explicitly permits).
 *
 * Trust boundary: the PRODUCT authenticates the request (capability token,
 * workspace RBAC) BEFORE constructing the scoped {@link SequenceStore} and
 * calling this handler — the handler trusts its store completely. Tool
 * execution failures (argument shape, validation, store throws) become
 * `isError` tool results carrying the thrown message verbatim so the model can
 * read WHY and retry; only protocol-level misuse becomes a JSON-RPC error.
 *
 * The envelope (JSON-RPC framing, initialize/ping/tools/list/tools/call,
 * notification 202, -32601) lives in {@link createMcpToolHandler}; this module
 * is a thin adapter wiring the sequences tool list + playhead env.
 */

import type { SequenceStore } from './store'
import { SEQUENCE_MCP_TOOLS } from './mcp-tools'
import type { SequenceMcpToolEnv } from './mcp-tools'
import { createMcpToolHandler } from '../tools/mcp-rpc'
import type { McpToolDefinition } from '../tools/mcp-rpc'

/** The supported MCP protocol versions are an envelope-level (engine) concern
 *  owned by the shared `createMcpToolHandler`. Re-exported under the historical
 *  name to keep the public surface stable without a second source of truth. */
export { MCP_PROTOCOL_VERSIONS as SEQUENCES_MCP_PROTOCOL_VERSIONS } from '../tools/mcp-rpc'

export interface SequencesMcpServerInfo {
  name: string
  version: string
}

export interface CreateSequencesMcpHandlerOptions {
  /** Already scoped + authorized for one (workspace, sequence, actor). */
  store: SequenceStore
  /** Editor playhead at request time, in frames; anchors auto-placed captions.
   *  Default 0 (sequence start) for headless callers. */
  playheadFrame?: number
  serverInfo?: SequencesMcpServerInfo
}

export function createSequencesMcpHandler(
  opts: CreateSequencesMcpHandlerOptions,
): (request: Request) => Promise<Response> {
  const playheadFrame = opts.playheadFrame ?? 0
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error('playheadFrame must be a non-negative integer (frames at the sequence fps)')
  }
  const serverInfo = opts.serverInfo ?? { name: 'sequences', version: '1.0.0' }

  return createMcpToolHandler<SequenceMcpToolEnv>({
    serverInfo,
    tools: SEQUENCE_MCP_TOOLS as McpToolDefinition<SequenceMcpToolEnv>[],
    buildEnv: (_request) => ({ store: opts.store, playheadFrame }),
  })
}
