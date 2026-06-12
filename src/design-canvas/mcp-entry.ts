/**
 * Profile entry for the design-canvas MCP server — what a product spreads
 * into its sandbox `AgentProfile.mcp` map so the in-sandbox agent gets the
 * live canvas channel. Same shape and conventions as the sequences entry in
 * ../sequences/mcp-entry: transport 'http', capability token in the
 * Authorization header (server-set, never a tool argument).
 */

import { DEFAULT_HEADER_NAMES } from '../tools/auth'
import type { ToolHeaderNames } from '../tools/auth'
import { buildHttpMcpServer } from '../tools/mcp'
import type { AppToolMcpServer } from '../tools/mcp'
import type { AppToolContext } from '../tools/types'

export const DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION =
  'Live visual asset editor for the current design document: read scene state, add/move/resize/delete elements, manage pages, bind template slots, apply data, and queue exports. All coordinates are CSS pixels.'

export interface BuildDesignCanvasMcpServerEntryOptions {
  /** App base URL the sandbox reaches back to (trailing slash tolerated). */
  baseUrl: string
  /** Product route serving `createDesignCanvasMcpHandler` for ONE document —
   *  the document id is part of the path, never a tool argument. */
  path: string
  /** Capability token the product minted for this (user, document) scope.
   *  With no token there is no entry to build — omit the server instead. */
  token: string
  description?: string
  /** Identity headers for products whose route recovers the user via
   *  `authenticateToolRequest`. Omit when the bearer token is self-contained. */
  ctx?: AppToolContext
  headerNames?: ToolHeaderNames
}

/** Build the `AgentProfileMcpServer`-shaped entry for the design-canvas channel. */
export function buildDesignCanvasMcpServerEntry(
  opts: BuildDesignCanvasMcpServerEntryOptions,
): AppToolMcpServer {
  if (opts.token.trim().length === 0) {
    throw new Error(
      'buildDesignCanvasMcpServerEntry requires a capability token — omit the design-canvas MCP server when none is available',
    )
  }
  if (!opts.path.startsWith('/')) {
    throw new Error(
      `buildDesignCanvasMcpServerEntry path must start with "/" (got "${opts.path}")`,
    )
  }
  const description = opts.description ?? DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION

  if (opts.ctx) {
    return buildHttpMcpServer({
      path: opts.path,
      baseUrl: opts.baseUrl,
      token: opts.token,
      ctx: opts.ctx,
      description,
      headerNames: opts.headerNames ?? DEFAULT_HEADER_NAMES,
    })
  }

  return {
    transport: 'http',
    url: `${opts.baseUrl.replace(/\/+$/, '')}${opts.path}`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    enabled: true,
    metadata: { description },
  }
}
