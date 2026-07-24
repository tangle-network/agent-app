/**
 * Profile entry for the sequences MCP server — what a product spreads into its
 * sandbox `AgentProfile.mcp` map so the in-sandbox agent gets the live
 * timeline channel. A thin wrapper over the shared `buildScopedMcpServerEntry`
 * mechanism (../tools/mcp): transport 'http', capability token in the
 * Authorization header (server-set, never a tool argument). The only
 * domain-specific values are this channel's default description and name.
 */

import { buildScopedMcpServerEntry } from '../tools/mcp'
import type { AppToolMcpServer, ScopedMcpServerEntryOptions } from '../tools/mcp'

/** Describe live timeline editor features for current video sequence including clip and caption management */
export const DEFAULT_SEQUENCES_MCP_DESCRIPTION =
  'Live timeline editor for the current video sequence: read timeline state, place/move/trim/split clips, add captions, manage tracks, and queue exports. All times are seconds.'

/** Extend ScopedMcpServerEntryOptions to configure MCP server entry options for sequence building */
export type BuildSequencesMcpServerEntryOptions = ScopedMcpServerEntryOptions

/** Build the `AgentProfileMcpServer`-shaped entry for the sequences channel. */
export function buildSequencesMcpServerEntry(
  opts: BuildSequencesMcpServerEntryOptions,
): AppToolMcpServer {
  return buildScopedMcpServerEntry({
    ...opts,
    label: 'buildSequencesMcpServerEntry',
    defaultDescription: DEFAULT_SEQUENCES_MCP_DESCRIPTION,
  })
}
