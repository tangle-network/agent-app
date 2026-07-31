/**
 * The tagged-configuration contract for every MCP server this package emits.
 *
 * An `AgentProfile` is digested, diffed, stored, and logged, so a credential
 * that rides it as plain text is a leak by construction. `@tangle-network/
 * agent-interface` closed that at **0.38.0**: `args`, `env`, and `headers` on
 * an `AgentProfileMcpServer` no longer take strings. Every value is either
 * deliberately public profile material (`defineAgentProfilePublicConfig`) or an
 * opaque reference to a credential (`defineAgentProfileSecretRef`) resolved
 * privately at materialization, validated by a `z.discriminatedUnion('kind')`.
 *
 * The schema also refuses to let a secret hide as public material: a `public`
 * value under a credential-bearing key name (`Authorization`, `*_TOKEN`,
 * `*_API_KEY`, `*_SECRET`, `Cookie`, …) is rejected with "credential-bearing
 * config names require a secret-ref", and any value whose bytes look like a
 * credential (`Bearer …`, `sk-…`, `ghp_…`) is rejected outright. So the
 * capability token this package used to inline as `Bearer <token>` cannot be
 * expressed at all — it must become a reference.
 *
 * **A reference resolves ONLY from an environment variable present on the box,
 * named by `key`.** That is why the builders below take a `tokenEnvKey` (the
 * box-env variable NAME) instead of a token VALUE: agent-app cannot guess the
 * name, and a reference to a key nothing places fails the turn at
 * materialization rather than running credential-less. The box env is what
 * `SandboxRuntimeConfig.env` (and the platform secret store via
 * `SandboxRuntimeConfig.secrets`) writes at sandbox creation, so the key must
 * name a variable one of those places — and it must therefore be a real
 * environment-variable name, which this module enforces.
 *
 * A per-request credential is only referenceable when the value written at box
 * creation is byte-identical to the one every later turn would mint (a
 * deterministic derivation such as an HMAC over the workspace id). A token
 * scoped narrower than the box — per-user, per-document — cannot be referenced
 * at all; {@link unresolvableSurfaceCredential} names that blocker instead of
 * emitting a reference that resolves to nothing.
 */
import {
  agentProfileMcpServerSchema,
  defineAgentProfilePublicConfig,
  defineAgentProfileSecretRef,
  type AgentProfileConfigValue,
} from '@tangle-network/agent-interface'
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
 *  tagged headers). Assignable to `AgentProfileMcpServer` without a cast —
 *  products spread it into their profile's `mcp` map. */
export interface AppToolMcpServer {
  transport: 'http'
  url: string
  headers: Record<string, AgentProfileConfigValue>
  enabled: true
  metadata: { description: string }
}

/** POSIX environment-variable name — the same shape `agent-interface`'s
 *  `environmentNameSchema` accepts for an env key. A secret reference resolves
 *  from the box environment, so a key outside this shape can never resolve. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reject a secret-reference key that names nothing the box can hold.
 *
 * `agent-interface` accepts any non-credential string as a reference key, so a
 * typo or a token VALUE passed where a key belongs validates against the
 * profile schema and fails much later, inside materialization, as an opaque
 * missing-secret error. Failing here names the parameter.
 */
function assertSecretEnvKey(key: string, label: string): string {
  if (!ENV_NAME_PATTERN.test(key)) {
    throw new Error(
      `${label}: tokenEnvKey must be an environment-variable NAME the sandbox box carries ` +
        `(e.g. 'APP_CAPABILITY_TOKEN'), not a token value — got ${JSON.stringify(key)}. ` +
        'A profile may only REFERENCE a credential; the value is placed on the box by ' +
        'SandboxRuntimeConfig.env or the platform secret store.',
    )
  }
  return key
}

/**
 * Validate one emitted entry against the REAL `agentProfileMcpServerSchema`.
 *
 * The contract's rules (which key names demand a reference, which byte patterns
 * read as a credential) live in `agent-interface`. Re-implementing them here
 * would drift the moment that package moves — which it does: 0.36.0 → 0.40.0 in
 * three days. Running the shipped validator instead means a product that passes
 * a credential-bearing custom header name, a relative base URL, or a URL with
 * embedded credentials fails at the builder with the contract's own message.
 *
 * It is also the loud failure for a version skew: if the resolved
 * `@tangle-network/agent-interface` predates 0.38.0, its schema rejects the
 * tagged shape this package now emits, and that surfaces here instead of as a
 * sandbox provisioning error.
 */
function assertProfileMcpServer<T extends AppToolMcpServer>(server: T, label: string): T {
  const result = agentProfileMcpServerSchema.safeParse(server)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(
      `${label} produced an MCP server the AgentProfile contract rejects: ${issues}. ` +
        'Requires @tangle-network/agent-interface >= 0.38.0 (tagged MCP config values).',
    )
  }
  return server
}

/**
 * Refuse to mount a surface whose credential is scoped narrower than the box.
 *
 * A per-user or per-resource capability token is minted per request. The box
 * environment is written once at sandbox creation and shared by every turn and
 * every member of the workspace, so such a token can neither be placed there
 * ahead of time nor referenced from a per-turn profile. Widening the channel to
 * a workspace-bound token is not a substitute when the route authenticates the
 * CALLER: the agent can read its own box env, so it could forge that identity.
 *
 * Mounting the surface anyway would emit a plain-string `Authorization` header
 * (rejected by the schema) or a reference to a key nothing places (rejected at
 * materialization). Throwing here names the actual blocker. Exported because
 * every product with per-document MCP surfaces hits it and was writing this
 * message itself.
 */
export function unresolvableSurfaceCredential(surface: string): never {
  throw new Error(
    `The ${surface} MCP surface cannot be mounted: its capability token is scoped to a single ` +
      'user and resource, and an AgentProfile may only reference a credential the sandbox can ' +
      'resolve from the box environment, which is workspace-wide and fixed at sandbox creation. ' +
      'Mounting it needs a per-session secret channel on the sandbox API, or a route that ' +
      'authenticates the workspace rather than the caller.',
  )
}

/** Define configuration options for building an HTTP MCP server including path, baseUrl, token env key, context, and description */
export interface BuildHttpMcpServerOptions {
  /** Route path on the app the sandbox POSTs to (e.g. `/api/tools/propose`). */
  path: string
  /** App base URL the sandbox reaches back to (no trailing slash required). */
  baseUrl: string
  /**
   * NAME of the box-environment variable holding the capability token — never
   * the token itself. The emitted `Authorization` header is a `secret-ref` to
   * this key with `format: 'bearer'`, so the sandbox resolves the value
   * privately and the profile carries only the name.
   *
   * The key MUST name a variable the box actually carries (placed by
   * `SandboxRuntimeConfig.env` at creation, or injected from the platform
   * secret store via `SandboxRuntimeConfig.secrets`), and the value written
   * there must be the token this route will accept for every turn — which in
   * practice means a deterministic derivation (e.g. an HMAC over the workspace
   * id), not a freshly-random per-request mint. A token scoped narrower than
   * the box is not referenceable: see {@link unresolvableSurfaceCredential}.
   */
  tokenEnvKey: string
  ctx: AppToolContext
  /** Tool description the model sees. */
  description: string
  headerNames?: ToolHeaderNames
}

/**
 * Build ONE HTTP MCP server entry — the generic agent→app bridge. The
 * capability token (as a secret reference) + the user/workspace/thread ids ride
 * in server-set headers (never tool args), so the model can't forge identity or
 * target another workspace. Workspace/thread headers are omitted when their
 * `ctx` value is empty/null (e.g. an integration-invoke bridge that's
 * user-scoped only). Used directly for non-app-tool bridges
 * (integration_invoke) and via {@link buildAppToolMcpServer} for the four app
 * tools.
 */
export function buildHttpMcpServer(opts: BuildHttpMcpServerOptions): AppToolMcpServer {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES
  return assertProfileMcpServer(
    {
      transport: 'http',
      url: `${base}${opts.path}`,
      headers: {
        Authorization: defineAgentProfileSecretRef(
          assertSecretEnvKey(opts.tokenEnvKey, 'buildHttpMcpServer'),
          'bearer',
        ),
        [h.userId]: defineAgentProfilePublicConfig(opts.ctx.userId),
        ...(opts.ctx.workspaceId
          ? { [h.workspaceId]: defineAgentProfilePublicConfig(opts.ctx.workspaceId) }
          : {}),
        ...(opts.ctx.threadId
          ? { [h.threadId]: defineAgentProfilePublicConfig(opts.ctx.threadId) }
          : {}),
        'Content-Type': defineAgentProfilePublicConfig('application/json'),
      },
      enabled: true,
      metadata: { description: opts.description },
    },
    'buildHttpMcpServer',
  )
}

/** Options for a per-document/scoped MCP channel entry (design-canvas,
 *  sequences, …). The capability token + path scope ONE resource; the document
 *  id lives in the path, never a tool argument. */
export interface ScopedMcpServerEntryOptions {
  /** App base URL the sandbox reaches back to (trailing slash tolerated). */
  baseUrl: string
  /** Product route serving the resource's MCP handler — id is part of the path. */
  path: string
  /**
   * NAME of the box-environment variable holding this channel's capability
   * token — never the token itself. See
   * {@link BuildHttpMcpServerOptions.tokenEnvKey}.
   *
   * A per-(user, resource) token cannot satisfy this: the box environment is
   * workspace-wide and fixed at sandbox creation. A product whose channel needs
   * one calls {@link unresolvableSurfaceCredential} rather than mounting an
   * entry that cannot resolve.
   */
  tokenEnvKey: string
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
  if (opts.tokenEnvKey.trim().length === 0) {
    throw new Error(`${opts.label} requires a capability token env key — omit the MCP server when none is available`)
  }
  if (!opts.path.startsWith('/')) {
    throw new Error(`${opts.label} path must start with "/" (got "${opts.path}")`)
  }
  const description = opts.description ?? opts.defaultDescription

  if (opts.ctx) {
    return buildHttpMcpServer({
      path: opts.path,
      baseUrl: opts.baseUrl,
      tokenEnvKey: opts.tokenEnvKey,
      ctx: opts.ctx,
      description,
      headerNames: opts.headerNames ?? DEFAULT_HEADER_NAMES,
    })
  }

  return assertProfileMcpServer(
    {
      transport: 'http',
      url: `${opts.baseUrl.replace(/\/+$/, '')}${opts.path}`,
      headers: {
        Authorization: defineAgentProfileSecretRef(
          assertSecretEnvKey(opts.tokenEnvKey, opts.label),
          'bearer',
        ),
        'Content-Type': defineAgentProfilePublicConfig('application/json'),
      },
      enabled: true,
      metadata: { description },
    },
    opts.label,
  )
}

/** Define configuration options required to build an MCP server including tool, baseUrl, token, and context */
export interface BuildMcpServerOptions {
  /** A built-in app tool name, or a product-registered {@link AppToolDefinition}.
   *  A custom tool supplies its route via `AppToolDefinition.path` (or `paths`). */
  tool: AppToolName | AppToolDefinition
  baseUrl: string
  /** NAME of the box-environment variable holding the capability token — see
   *  {@link BuildHttpMcpServerOptions.tokenEnvKey}. */
  tokenEnvKey: string
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
    tokenEnvKey: opts.tokenEnvKey,
    ctx: opts.ctx,
    description: opts.description,
    headerNames: opts.headerNames,
  })
}
