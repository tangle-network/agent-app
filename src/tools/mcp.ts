import type { AppToolContext } from './types'
import type { AppToolName } from './openai'
import type { AppToolDefinition } from './registry'
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

export interface BuildHttpMcpServerOptions {
  /** Route path on the app the sandbox POSTs to (e.g. `/api/tools/propose`). */
  path: string
  /** App base URL the sandbox reaches back to (no trailing slash required). */
  baseUrl: string
  /** Per-user capability token, baked into the Authorization header. */
  token: string
  ctx: AppToolContext
  /** Tool description the model sees. */
  description: string
  headerNames?: ToolHeaderNames
}

/**
 * Build ONE HTTP MCP server entry — the generic agent→app bridge. The
 * capability token + the user/workspace/thread ids ride in server-set headers
 * (never tool args), so the model can't forge identity or target another
 * workspace. Workspace/thread headers are omitted when their `ctx` value is
 * empty/null (e.g. an integration-invoke bridge that's user-scoped only). Used
 * directly for non-app-tool bridges (integration_invoke) and via
 * {@link buildAppToolMcpServer} for the four app tools.
 */
export function buildHttpMcpServer(opts: BuildHttpMcpServerOptions): AppToolMcpServer {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES
  return {
    transport: 'http',
    url: `${base}${opts.path}`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      [h.userId]: opts.ctx.userId,
      ...(opts.ctx.workspaceId ? { [h.workspaceId]: opts.ctx.workspaceId } : {}),
      ...(opts.ctx.threadId ? { [h.threadId]: opts.ctx.threadId } : {}),
      'Content-Type': 'application/json',
    },
    enabled: true,
    metadata: { description: opts.description },
  }
}

/** Options for a per-document/scoped MCP channel entry (design-canvas,
 *  sequences, …). The capability token + path scope ONE resource; the document
 *  id lives in the path, never a tool argument. */
export interface ScopedMcpServerEntryOptions {
  /** App base URL the sandbox reaches back to (trailing slash tolerated). */
  baseUrl: string
  /** Product route serving the resource's MCP handler — id is part of the path. */
  path: string
  /** Capability token the product minted for this (user, resource) scope. With
   *  no token there is no entry to build — omit the server instead. */
  token: string
  /** Override the channel's default tool-server description. */
  description?: string
  /** Identity headers for products whose route recovers the user via
   *  `authenticateToolRequest`. Omit when the bearer token is self-contained. */
  ctx?: AppToolContext
  headerNames?: ToolHeaderNames
}

/**
 * Build the `AgentProfileMcpServer`-shaped entry for a scoped, per-resource MCP
 * channel. The shared mechanism behind the per-domain entry builders
 * (`buildDesignCanvasMcpServerEntry`, `buildSequencesMcpServerEntry`): same
 * token/path guards, same description default, same ctx-vs-self-contained-token
 * branching. The domain is two parameters — `label` (for guard messages) and
 * `defaultDescription` — never baked.
 *
 * The no-`ctx` branch is a GENUINE behavioral path, not a shortcut: it emits a
 * self-contained-token entry with ONLY `Authorization` + `Content-Type`.
 * Routing it through {@link buildHttpMcpServer} would unconditionally write a
 * `userId` identity header (here `undefined`), so it stays a distinct branch.
 */
export function buildScopedMcpServerEntry(
  opts: ScopedMcpServerEntryOptions & { label: string; defaultDescription: string },
): AppToolMcpServer {
  if (opts.token.trim().length === 0) {
    throw new Error(`${opts.label} requires a capability token — omit the MCP server when none is available`)
  }
  if (!opts.path.startsWith('/')) {
    throw new Error(`${opts.label} path must start with "/" (got "${opts.path}")`)
  }
  const description = opts.description ?? opts.defaultDescription

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

export interface BuildMcpServerOptions {
  /** A built-in app tool name, or a product-registered {@link AppToolDefinition}.
   *  A custom tool supplies its route via `AppToolDefinition.path` (or `paths`). */
  tool: AppToolName | AppToolDefinition
  baseUrl: string
  token: string
  ctx: AppToolContext
  description: string
  headerNames?: ToolHeaderNames
  paths?: Partial<Record<string, string>>
}

/** Build one app-tool MCP server entry — a thin wrapper over
 *  {@link buildHttpMcpServer} that resolves the tool's route path. Built-ins map
 *  through {@link DEFAULT_APP_TOOL_PATHS}; a custom tool uses its own `path`
 *  (or a `paths` override). */
export function buildAppToolMcpServer(opts: BuildMcpServerOptions): AppToolMcpServer {
  const path =
    typeof opts.tool === 'string'
      ? opts.paths?.[opts.tool] ?? DEFAULT_APP_TOOL_PATHS[opts.tool]
      : opts.paths?.[opts.tool.name] ?? opts.tool.path
  if (!path) {
    const name = typeof opts.tool === 'string' ? opts.tool : opts.tool.name
    throw new Error(`buildAppToolMcpServer: tool "${name}" has no route path — set AppToolDefinition.path or pass it via opts.paths`)
  }
  return buildHttpMcpServer({
    path,
    baseUrl: opts.baseUrl,
    token: opts.token,
    ctx: opts.ctx,
    description: opts.description,
    headerNames: opts.headerNames,
  })
}
