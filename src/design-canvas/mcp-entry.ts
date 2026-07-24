/**
 * Profile entry for the design-canvas MCP server — what a product spreads
 * into its sandbox `AgentProfile.mcp` map so the in-sandbox agent gets the
 * live canvas channel. A thin wrapper over the shared `buildScopedMcpServerEntry`
 * mechanism (../tools/mcp): transport 'http', capability token in the
 * Authorization header (server-set, never a tool argument). The only
 * domain-specific values are this channel's default description and name.
 */

import { buildScopedMcpServerEntry } from '../tools/mcp'
import type { AppToolMcpServer, ScopedMcpServerEntryOptions } from '../tools/mcp'

/** Describe the live visual asset editor capabilities for the current design document using CSS pixel coordinates */
export const DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION =
  'Live visual asset editor for the current design document: read scene state, add/move/resize/delete elements, manage pages, bind template slots, apply data, and queue exports. All coordinates are CSS pixels.'

/** Build scoped MCP server entry options for the design canvas environment */
export type BuildDesignCanvasMcpServerEntryOptions = ScopedMcpServerEntryOptions

/** Build the `AgentProfileMcpServer`-shaped entry for the design-canvas channel. */
export function buildDesignCanvasMcpServerEntry(
  opts: BuildDesignCanvasMcpServerEntryOptions,
): AppToolMcpServer {
  return buildScopedMcpServerEntry({
    ...opts,
    label: 'buildDesignCanvasMcpServerEntry',
    defaultDescription: DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION,
  })
}
