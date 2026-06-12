/**
 * Profile entry for the sequences MCP server — what a product spreads into its
 * sandbox `AgentProfile.mcp` map so the in-sandbox agent gets the live
 * timeline channel. Same shape and conventions as the app-tool bridges in
 * ../tools/mcp: transport 'http', capability token in the Authorization
 * header (server-set, never a tool argument), identity headers when the
 * product recovers the user via `authenticateToolRequest`.
 */

import { DEFAULT_HEADER_NAMES } from '../tools/auth'
import type { ToolHeaderNames } from '../tools/auth'
import { buildHttpMcpServer } from '../tools/mcp'
import type { AppToolMcpServer } from '../tools/mcp'
import type { AppToolContext } from '../tools/types'

export const DEFAULT_SEQUENCES_MCP_DESCRIPTION =
  'Live timeline editor for the current video sequence: read timeline state, place/move/trim/split clips, add captions, manage tracks, and queue exports. All times are seconds.'

export interface BuildSequencesMcpServerEntryOptions {
  /** App base URL the sandbox reaches back to (trailing slash tolerated). */
  baseUrl: string
  /** Product route serving `createSequencesMcpHandler` for ONE sequence —
   *  the sequence id is part of the path, never a tool argument. */
  path: string
  /** Capability token the product minted for this (user, sequence) scope.
   *  With no token there is no entry to build — omit the server instead. */
  token: string
  description?: string
  /** Identity headers for products whose route recovers the user via
   *  `authenticateToolRequest`. Omit when the bearer token is self-contained. */
  ctx?: AppToolContext
  headerNames?: ToolHeaderNames
}

/** Build the `AgentProfileMcpServer`-shaped entry for the sequences channel. */
export function buildSequencesMcpServerEntry(opts: BuildSequencesMcpServerEntryOptions): AppToolMcpServer {
  if (opts.token.trim().length === 0) {
    throw new Error('buildSequencesMcpServerEntry requires a capability token — omit the sequences MCP server when none is available')
  }
  if (!opts.path.startsWith('/')) {
    throw new Error(`buildSequencesMcpServerEntry path must start with "/" (got "${opts.path}")`)
  }
  const description = opts.description ?? DEFAULT_SEQUENCES_MCP_DESCRIPTION

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
