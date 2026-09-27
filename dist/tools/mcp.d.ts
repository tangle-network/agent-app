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
 * `SandboxRuntimeConfig.secrets`) writes at sandbox creation.
 * `SandboxRuntimeConfig.runtimeEnv` can also supply expiring workspace
 * credentials at creation and refresh them on retained boxes before
 * bootstrap. The key must name a variable one of those places — and it must
 * therefore be a real environment-variable name, which this module enforces.
 *
 * A workspace credential may be renewed through `runtimeEnv`; it still has
 * workspace-wide authority because every member and turn shares the box. A
 * token scoped narrower than the box — per-user, per-document — cannot be
 * referenced safely; {@link unresolvableSurfaceCredential} names that blocker
 * instead of emitting a reference that resolves to nothing.
 */
import { type AgentProfileConfigValue } from '@tangle-network/agent-interface';
import type { AppToolContext } from './types';
import type { AppToolName } from './openai';
import type { AppToolDefinition } from './registry';
import type { ToolHeaderNames } from './auth';
/** Default route path each app tool is served at. A product mounts its routes
 *  at these paths (or supplies its own via {@link BuildMcpServerOptions.paths}). */
export declare const DEFAULT_APP_TOOL_PATHS: Record<AppToolName, string>;
/** The portable MCP server entry the sandbox SDK accepts (transport + url +
 *  tagged headers). Assignable to `AgentProfileMcpServer` without a cast —
 *  products spread it into their profile's `mcp` map. */
export interface AppToolMcpServer {
    transport: 'http';
    url: string;
    headers: Record<string, AgentProfileConfigValue>;
    enabled: true;
    metadata: {
        description: string;
    };
}
/**
 * Refuse to mount a surface whose credential is scoped narrower than the box.
 *
 * A per-user or per-resource capability token is minted per request. The box
 * environment is shared by every turn and every member of the workspace;
 * `env` writes at creation and `runtimeEnv` refreshes workspace-scoped values
 * on retained boxes. Neither path provides a per-turn secret channel, so a
 * narrower token cannot be referenced safely. Widening the channel to a
 * workspace-bound token is not a substitute when the route authenticates the
 * CALLER: the agent can read its own box env, so it could forge that identity.
 *
 * Mounting the surface anyway would emit a plain-string `Authorization` header
 * (rejected by the schema) or a reference to a key nothing places (rejected at
 * materialization). Throwing here names the actual blocker. Exported because
 * every product with per-document MCP surfaces hits it and was writing this
 * message itself.
 */
export declare function unresolvableSurfaceCredential(surface: string): never;
/** Define configuration options for building an HTTP MCP server including path, baseUrl, token env key, context, and description */
export interface BuildHttpMcpServerOptions {
    /** Route path on the app the sandbox POSTs to (e.g. `/api/tools/propose`). */
    path: string;
    /** App base URL the sandbox reaches back to (no trailing slash required). */
    baseUrl: string;
    /**
     * NAME of the box-environment variable holding the capability token — never
     * the token itself. The emitted `Authorization` header is a `secret-ref` to
     * this key with `format: 'bearer'`, so the sandbox resolves the value
     * privately and the profile carries only the name.
     *
     * The key MUST name a variable the box actually carries (placed by
     * `SandboxRuntimeConfig.env` at creation, refreshed by
     * `SandboxRuntimeConfig.runtimeEnv` before retained-box bootstrap, or
     * injected from the platform secret store via
     * `SandboxRuntimeConfig.secrets`). The value must be a workspace-scoped token
     * this route accepts for the active box; a per-user or per-resource token is
     * not referenceable: see {@link unresolvableSurfaceCredential}.
     */
    tokenEnvKey: string;
    ctx: AppToolContext;
    /** Tool description the model sees. */
    description: string;
    headerNames?: ToolHeaderNames;
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
export declare function buildHttpMcpServer(opts: BuildHttpMcpServerOptions): AppToolMcpServer;
/** Options for a per-document/scoped MCP channel entry (design-canvas,
 *  sequences, …). The capability token + path scope ONE resource; the document
 *  id lives in the path, never a tool argument. */
export interface ScopedMcpServerEntryOptions {
    /** App base URL the sandbox reaches back to (trailing slash tolerated). */
    baseUrl: string;
    /** Product route serving the resource's MCP handler — id is part of the path. */
    path: string;
    /**
     * NAME of the box-environment variable holding this channel's capability
     * token — never the token itself. See
     * {@link BuildHttpMcpServerOptions.tokenEnvKey}.
     *
     * A per-(user, resource) token cannot satisfy this: the box environment is
     * workspace-wide; `env` writes at creation and `runtimeEnv` refreshes
     * workspace-scoped values on retained boxes. A product whose channel needs
     * a narrower token calls {@link unresolvableSurfaceCredential} rather than
     * mounting an entry that cannot resolve safely.
     */
    tokenEnvKey: string;
    /** Override the channel's default tool-server description. */
    description?: string;
    /** Identity headers for products whose route recovers the user via
     *  `authenticateToolRequest`. Omit when the bearer token is self-contained. */
    ctx?: AppToolContext;
    headerNames?: ToolHeaderNames;
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
export declare function buildScopedMcpServerEntry(opts: ScopedMcpServerEntryOptions & {
    label: string;
    defaultDescription: string;
}): AppToolMcpServer;
/** Define configuration options required to build an MCP server including tool, baseUrl, token, and context */
export interface BuildMcpServerOptions {
    /** A built-in app tool name, or a product-registered {@link AppToolDefinition}.
     *  A custom tool supplies its route via `AppToolDefinition.path` (or `paths`). */
    tool: AppToolName | AppToolDefinition;
    baseUrl: string;
    /** NAME of the box-environment variable holding the capability token — see
     *  {@link BuildHttpMcpServerOptions.tokenEnvKey}. */
    tokenEnvKey: string;
    ctx: AppToolContext;
    description: string;
    headerNames?: ToolHeaderNames;
    paths?: Partial<Record<string, string>>;
}
/** Build one app-tool MCP server entry — a thin wrapper over
 *  {@link buildHttpMcpServer} that resolves the tool's route path. Built-ins map
 *  through {@link DEFAULT_APP_TOOL_PATHS}; a custom tool uses its own `path`
 *  (or a `paths` override). */
export declare function buildAppToolMcpServer(opts: BuildMcpServerOptions): AppToolMcpServer;
