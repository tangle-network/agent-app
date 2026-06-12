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
 */

import type { SequenceStore } from './store'
import { SEQUENCE_MCP_TOOLS, findSequenceMcpTool } from './mcp-tools'

/** Newest first. The handler echoes the client's requested version when
 *  supported, else answers with the newest it speaks (per MCP negotiation the
 *  client then disconnects if it cannot use it). */
export const SEQUENCES_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

const LATEST_PROTOCOL_VERSION = SEQUENCES_MCP_PROTOCOL_VERSIONS[0]

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

export function createSequencesMcpHandler(
  opts: CreateSequencesMcpHandlerOptions,
): (request: Request) => Promise<Response> {
  const playheadFrame = opts.playheadFrame ?? 0
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error('playheadFrame must be a non-negative integer (frames at the sequence fps)')
  }
  const serverInfo = opts.serverInfo ?? { name: 'sequences', version: '1.0.0' }

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      // Tools-only server: no GET/SSE stream to open, no DELETE session to end.
      return new Response('sequences MCP accepts JSON-RPC 2.0 over POST only', {
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
      return rpcError(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 object with jsonrpc "2.0" and a string method', 400)
    }

    const method = body.method
    const params = isRecord(body.params) ? body.params : {}

    // A request without an `id` member is a notification (e.g.
    // notifications/initialized) — acknowledge with 202 and no JSON-RPC body.
    if (!('id' in body) || body.id === undefined) {
      return new Response(null, { status: 202 })
    }
    const id = body.id as JsonRpcId

    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
        const protocolVersion =
          requested !== undefined && (SEQUENCES_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        })
      }

      case 'ping':
        return rpcResult(id, {})

      case 'tools/list':
        return rpcResult(id, {
          tools: SEQUENCE_MCP_TOOLS.map((tool) => ({
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
        const tool = findSequenceMcpTool(name)
        if (!tool) {
          return rpcError(
            id,
            -32602,
            `Unknown tool: ${name}. Available tools: ${SEQUENCE_MCP_TOOLS.map((t) => t.name).join(', ')}`,
          )
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
          return rpcError(id, -32602, 'tools/call params.arguments must be an object when provided')
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        try {
          const result = await tool.run(args, { store: opts.store, playheadFrame })
          const payload: ToolCallContent = { content: [{ type: 'text', text: JSON.stringify(result) }] }
          return rpcResult(id, payload)
        } catch (err) {
          // The model reads this text to correct its call — keep the thrown
          // reason verbatim, prefixed with the tool so multi-call turns stay
          // attributable.
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
