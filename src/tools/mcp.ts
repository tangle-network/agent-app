import type { AppToolContext } from './types'
import type { AppToolName } from './openai'
import type { ToolHeaderNames } from './auth'
import { DEFAULT_HEADER_NAMES } from './auth'

/** Default route path each app tool is served at. A product mounts its routes
 *  at these paths (or supplies its own via {@link BuildMcpServerOptions.paths}). */
export const DEFAULT_APP_TOOL_PATHS: Record<AppToolName, string> = {
  submit_proposal: '/api/tools/propose',
  schedule_followup: '/api/tools/followup',
  render_ui: '/api/tools/render-ui',
  add_citation: '/api/tools/citation',
}

/** The portable MCP server entry the sandbox SDK accepts (transport + url +
 *  headers). Matches `AgentProfileMcpServer` structurally without importing the
 *  sandbox SDK — products spread it into their profile's `mcp` map. */
export interface AppToolMcpServer {
  transport: 'http'
  url: string
  headers: Record<string, string>
  enabled: true
  metadata: { description: string }
}

export interface BuildMcpServerOptions {
  tool: AppToolName
  /** App base URL the sandbox reaches back to (no trailing slash required). */
  baseUrl: string
  /** Per-user capability token, baked into the Authorization header. */
  token: string
  ctx: AppToolContext
  /** Tool description the model sees. */
  description: string
  headerNames?: ToolHeaderNames
  paths?: Partial<Record<AppToolName, string>>
}

/**
 * Build one app-tool MCP server entry for a turn. The capability token + the
 * user/workspace/thread ids ride in server-set headers (never tool args), so
 * the model can't forge identity or target another workspace. The `ctx`'s
 * `threadId` is omitted from headers when null.
 */
export function buildAppToolMcpServer(opts: BuildMcpServerOptions): AppToolMcpServer {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const path = opts.paths?.[opts.tool] ?? DEFAULT_APP_TOOL_PATHS[opts.tool]
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES
  return {
    transport: 'http',
    url: `${base}${path}`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      [h.userId]: opts.ctx.userId,
      [h.workspaceId]: opts.ctx.workspaceId,
      ...(opts.ctx.threadId ? { [h.threadId]: opts.ctx.threadId } : {}),
      'Content-Type': 'application/json',
    },
    enabled: true,
    metadata: { description: opts.description },
  }
}
