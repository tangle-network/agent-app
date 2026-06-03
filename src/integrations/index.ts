/**
 * Integration-hub WIRING — the agent→hub invocation path every Tangle agent app
 * forks. The integration ENGINE (catalog, connectors, OAuth, policy) is
 * `@tangle-network/agent-integrations` (a peer dependency); this module is the
 * thin app-side wiring on top: a typed client over the platform hub's
 * `POST /v1/hub/exec`, MCP-tool-name → hub-action-path resolution, and the
 * per-turn invoke flow the `integration_invoke` tool calls.
 *
 * The product supplies its own catalog (which connectors it uses) and its own
 * per-user api-key resolver (the `apiKeyResolver` seam) — this module owns
 * neither credentials nor the action catalog.
 */
import { parseIntegrationToolName } from '@tangle-network/agent-integrations/catalog'

/** `{ success: false }` codes the hub returns on `/exec`. */
export type HubExecErrorCode =
  | 'HUB_APPROVAL_REQUIRED'
  | 'HUB_POLICY_DENIED'
  | 'HUB_CONNECTION_MISSING'
  | 'HUB_CONNECTION_REVOKED'
  | 'HUB_CONFIG_MISSING'
  | 'HUB_NOT_FOUND'
  | string

/** Outcome of a hub `/exec` call. Callers MUST inspect `succeeded` before
 *  reading `result` — a denied or approval-gated write resolves with
 *  `succeeded: false` and a populated `code`, never a thrown silent failure. */
export type HubExecResult =
  | { succeeded: true; result: unknown }
  | { succeeded: false; code: HubExecErrorCode; message: string; approval?: unknown }

export interface HubExecClientOptions {
  /** Platform base URL (e.g. `TANGLE_PLATFORM_URL`). */
  baseUrl: string
  /** Calling user's Tangle API key — the hub principal bearer. */
  bearer: string
  /** Test seam. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** The provider/connector/action a hub action path addresses, plus the dotted
 *  `path` the hub `/exec` endpoint expects. */
export interface ParsedIntegrationAction {
  providerId: string
  connectorId: string
  actionId: string
  /** `provider.connector.action`. */
  path: string
}

/**
 * Resolve an MCP tool name (the opaque `int_…` catalog name the agent calls)
 * into the dotted hub action path. Returns `undefined` when the name is not a
 * catalog integration tool, so the chat loop routes non-integration calls
 * elsewhere instead of misrouting them to the hub.
 */
export function resolveIntegrationAction(toolName: string): ParsedIntegrationAction | undefined {
  let parsed: { providerId: string; connectorId: string; actionId: string }
  try {
    parsed = parseIntegrationToolName(toolName)
  } catch {
    return undefined
  }
  if (!parsed.providerId || !parsed.connectorId || !parsed.actionId) return undefined
  return { ...parsed, path: `${parsed.providerId}.${parsed.connectorId}.${parsed.actionId}` }
}

interface HubEnvelope {
  success: boolean
  data?: { result?: unknown }
  error?: { code?: string; message?: string; details?: { approval?: unknown } }
}

/** Typed client over the platform hub `/v1/hub/exec`. The hub holds the user's
 *  credentials, resolves the connection from the bearer principal, evaluates
 *  per-action policy (read → allow, write/destructive → approval), and runs the
 *  action server-side. Never throws on a policy block — a gated write is a
 *  normal `succeeded: false` outcome. */
export class HubExecClient {
  private readonly baseUrl: string
  private readonly bearer: string
  private readonly fetchImpl: typeof fetch

  constructor(options: HubExecClientOptions) {
    if (!options.baseUrl) throw new Error('HubExecClient: baseUrl is required')
    if (!options.bearer) throw new Error('HubExecClient: bearer is required')
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.bearer = options.bearer
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async exec(input: { path: string; actionInput?: unknown; connectionId?: string }): Promise<HubExecResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/hub/exec`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ path: input.path, input: input.actionInput, connectionId: input.connectionId }),
    })
    const envelope = await this.readEnvelope(response)
    if (response.ok && envelope.success) return { succeeded: true, result: envelope.data?.result }
    return {
      succeeded: false,
      code: envelope.error?.code ?? `HUB_HTTP_${response.status}`,
      message: envelope.error?.message ?? `Hub /exec returned ${response.status}`,
      approval: envelope.error?.details?.approval,
    }
  }

  private async readEnvelope(response: Response): Promise<HubEnvelope> {
    const text = await response.text()
    if (!text) return { success: false, error: { code: `HUB_HTTP_${response.status}`, message: `Hub returned ${response.status} with no body` } }
    try {
      return JSON.parse(text) as HubEnvelope
    } catch {
      return { success: false, error: { code: 'HUB_BAD_RESPONSE', message: `Hub returned non-JSON (${response.status}): ${text.slice(0, 200)}` } }
    }
  }
}

export interface HubInvokeInput {
  userId: string
  /** The MCP tool name the agent called (`int_<provider>_<connector>_<action>`). */
  toolName: string
  args?: Record<string, unknown>
}
export interface HubInvokeOutcome {
  status: number
  body: Record<string, unknown>
}
export interface HubInvokeDeps {
  /** Resolve the user's Tangle API key (the hub principal bearer). Required —
   *  the product binds its own session-key resolver. Null → user not linked. */
  apiKeyResolver: (userId: string) => Promise<string | null>
  /** Platform base URL. Defaults to `env.TANGLE_PLATFORM_URL`. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

/**
 * Resolve + execute one integration tool call through the hub: resolve the
 * per-user bearer, map the MCP tool name to the hub action path, forward to
 * `/v1/hub/exec`, and shape the route response (200 ok / 401 not-linked /
 * 400 unknown-tool / 409 approval-required / 502 hub-error). A write that's
 * approval-gated surfaces verbatim as 409, never silently executed.
 */
export async function invokeIntegrationHub(input: HubInvokeInput, deps: HubInvokeDeps): Promise<HubInvokeOutcome> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)
  const baseUrl = deps.baseUrl ?? env.TANGLE_PLATFORM_URL?.trim()
  if (!baseUrl) return { status: 500, body: { error: 'TANGLE_PLATFORM_URL is not configured' } }

  const action = resolveIntegrationAction(input.toolName)
  if (!action) return { status: 400, body: { error: `Unsupported integration tool: ${input.toolName}` } }

  const bearer = await deps.apiKeyResolver(input.userId)
  if (!bearer) return { status: 401, body: { error: 'Tangle account not linked — connect integrations from the app first' } }

  const client = new HubExecClient({ baseUrl, bearer, fetchImpl: deps.fetchImpl })
  const outcome = await client.exec({ path: action.path, actionInput: input.args ?? {} })

  if (outcome.succeeded) {
    return { status: 200, body: { success: true, path: action.path, providerId: action.providerId, action: action.actionId, result: outcome.result } }
  }
  const status = outcome.code === 'HUB_APPROVAL_REQUIRED' ? 409 : 502
  return {
    status,
    body: { success: false, path: action.path, code: outcome.code, error: outcome.message, ...(outcome.approval ? { approval: outcome.approval } : {}) },
  }
}
