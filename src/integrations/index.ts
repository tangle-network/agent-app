/**
 * Application wiring for Hub integration invocation.
 * Agent Integrations owns catalog names. Hub SDK owns the HTTP protocol,
 * bearer authentication, envelope validation and credential redaction.
 * Products supply their user-key resolver and domain catalog.
 */
import { parseIntegrationToolName } from '@tangle-network/agent-integrations/catalog'
import { HubClient, HubSdkError } from '@tangle-network/hub-sdk'

/** Error codes returned by Hub execution. */
export type HubExecErrorCode =
  | 'HUB_APPROVAL_REQUIRED'
  | 'HUB_POLICY_DENIED'
  | 'HUB_CONNECTION_MISSING'
  | 'HUB_CONNECTION_REVOKED'
  | 'HUB_CONFIG_MISSING'
  | 'HUB_NOT_FOUND'
  | string

/** Callers must inspect succeeded before reading result. */
export type HubExecResult =
  | { succeeded: true; result: unknown }
  | { succeeded: false; code: HubExecErrorCode; message: string; approval?: unknown }

/** Configuration for the compatibility Hub execution facade. */
export interface HubExecClientOptions {
  baseUrl: string
  /** The calling user's Hub principal bearer. */
  bearer: string
  fetchImpl?: typeof fetch
}

/** A resolved integration catalog action. */
export interface ParsedIntegrationAction {
  providerId: string
  connectorId: string
  actionId: string
  /** provider.connector.action */
  path: string
}

/** Resolve a catalog MCP tool name without claiming non-integration tools. */
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

/** Compatibility facade over the published Hub SDK. Policy refusals remain
 * values so existing approval UIs do not change. Transport failures still
 * throw, as they did before the migration. */
export class HubExecClient {
  private readonly hub: HubClient

  constructor(options: HubExecClientOptions) {
    if (!options.baseUrl) throw new Error('HubExecClient: baseUrl is required')
    if (!options.bearer) throw new Error('HubExecClient: bearer is required')
    this.hub = new HubClient({
      baseUrl: options.baseUrl,
      apiKey: options.bearer,
      fetch: options.fetchImpl,
    })
  }

  async exec(input: { path: string; actionInput?: unknown; connectionId?: string }): Promise<HubExecResult> {
    try {
      const response = await this.hub.tools.invoke(input.path, input.actionInput, {
        connectionId: input.connectionId,
      })
      return { succeeded: true, result: response.result }
    } catch (error) {
      if (!(error instanceof HubSdkError)) throw error
      const details = error.details
      const approval = typeof details === 'object' && details !== null && 'approval' in details
        ? details.approval : undefined
      return { succeeded: false, code: error.code, message: error.message, approval }
    }
  }
}

/** Input for the application integration-invoke route. */
export interface HubInvokeInput {
  userId: string
  toolName: string
  args?: Record<string, unknown>
}
/** Application HTTP outcome, including approval-required responses. */
export interface HubInvokeOutcome {
  status: number
  body: Record<string, unknown>
}
/** User authority is resolved on the server, never from model arguments. */
export interface HubInvokeDeps {
  apiKeyResolver: (userId: string) => Promise<string | null>
  baseUrl?: string
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

/** Resolve the user's key, invoke the published Hub client, and preserve the
 * application's existing 200/400/401/409/502 response contract. */
export async function invokeIntegrationHub(input: HubInvokeInput, deps: HubInvokeDeps): Promise<HubInvokeOutcome> {
  const env = deps.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const baseUrl = deps.baseUrl ?? env.TANGLE_PLATFORM_URL?.trim()
  if (!baseUrl) return { status: 500, body: { error: 'TANGLE_PLATFORM_URL is not configured' } }

  const action = resolveIntegrationAction(input.toolName)
  if (!action) return { status: 400, body: { error: `Unsupported integration tool: ${input.toolName}` } }

  const bearer = await deps.apiKeyResolver(input.userId)
  if (!bearer) return { status: 401, body: { error: 'Tangle account not linked: connect integrations from the app first' } }

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
