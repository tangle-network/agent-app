/**
 * Delegated looped work — the agent-runtime "driven loop" MCP.
 *
 * For multi-step research or document generation, the agent dispatches a loop
 * that runs to completion in its OWN sandbox (via @tangle-network/agent-runtime's
 * stdio MCP, executed in the agent-driver) and returns the artifact. This is
 * how an app's main agent "programs / delegates" without doing long mechanical
 * work inline. It is an OPTIONAL module — an app opts in by spreading the
 * server into its profile's `mcp` map.
 *
 * The shape is the portable `AgentProfileMcpServer` the sandbox SDK accepts
 * (transport: 'stdio' → the orchestrator derives `{ type:'local', command }`).
 * Kept structural here so this package needs no sandbox-SDK dependency.
 */

export const DELEGATION_MCP_SERVER_KEY = 'agent-runtime-delegation'

export const DELEGATION_TOOLS = [
  'delegate_code',
  'delegate_research',
  'delegate_feedback',
  'delegation_status',
  'delegation_history',
] as const

/** The stdio MCP server entry — structurally an `AgentProfileMcpServer`. */
export interface DelegationMcpServer {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  enabled: true
  metadata: { surface: string; tools: readonly string[] }
}

export interface BuildDelegationOptions {
  /** Platform API key the delegated loop authenticates with (required — the
   *  loop runs in its own sandbox and bills against this key). Omit/empty →
   *  returns undefined (fail-closed: no key, no delegation). */
  apiKey?: string
  /** Extra env to forward into the delegated loop (sandbox base URL, OTel trace
   *  propagation, etc.). Only defined values are forwarded. */
  forwardEnv?: Record<string, string | undefined>
  /** npm spec for the runtime MCP. Defaults to the published agent-runtime. */
  packageSpec?: string
}

/**
 * Build the delegation MCP server entry, keyed under
 * {@link DELEGATION_MCP_SERVER_KEY}, or `undefined` when no platform API key is
 * available. Spread the result into the profile's `mcp` map:
 *
 *   const delegation = buildDelegationMcpServer({ apiKey: env.TANGLE_API_KEY, forwardEnv: env })
 *   const mcp = { ...(delegation ? { [DELEGATION_MCP_SERVER_KEY]: delegation } : {}) }
 */
export function buildDelegationMcpServer(opts: BuildDelegationOptions): DelegationMcpServer | undefined {
  if (!opts.apiKey) return undefined
  const env: Record<string, string> = { TANGLE_API_KEY: opts.apiKey }
  const forward = opts.forwardEnv ?? {}
  for (const key of ['SANDBOX_BASE_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'TRACE_ID', 'PARENT_SPAN_ID']) {
    const value = forward[key]
    if (value) env[key] = value
  }
  return {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', opts.packageSpec ?? '@tangle-network/agent-runtime', 'mcp'],
    env,
    enabled: true,
    metadata: { surface: 'delegation:dispatch', tools: DELEGATION_TOOLS },
  }
}
