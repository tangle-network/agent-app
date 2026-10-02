import type {
  HubApiKeyConnectionMetadata,
  HubConnection,
  HubConnectionHealthResponse,
  HubOAuthStartResponse,
  HubPolicy,
  HubPolicyDecision,
  HubProvider,
  HubTool,
} from '@tangle-network/hub-sdk'

/** The host must bind each request to this server-verified identity. */
export interface HubIntegrationsIdentity {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string
}

export interface HubSettingsRequest {
  readonly identity: HubIntegrationsIdentity
  readonly path: string
  readonly init: RequestInit
}

/**
 * The host supplies its authenticated fetch, CSRF protection and expected
 * identity check. The browser never receives a Hub credential or SDK client.
 */
export type HubSettingsRequestFn = (request: HubSettingsRequest) => Promise<Response>

export interface HubIntegrationsClient {
  providers(identity: HubIntegrationsIdentity, signal?: AbortSignal): Promise<HubProvider[]>
  connections(identity: HubIntegrationsIdentity, signal?: AbortSignal): Promise<HubConnection[]>
  startOAuth(identity: HubIntegrationsIdentity, providerId: string, input: { returnUrl: string; connectionParameters?: Record<string, string> }, signal?: AbortSignal): Promise<HubOAuthStartResponse>
  connectApiKey(identity: HubIntegrationsIdentity, providerId: string, apiKey: string, metadata?: HubApiKeyConnectionMetadata, signal?: AbortSignal): Promise<HubConnection>
  revoke(identity: HubIntegrationsIdentity, connectionId: string, signal?: AbortSignal): Promise<HubConnection>
  health(identity: HubIntegrationsIdentity, connectionId: string, signal?: AbortSignal): Promise<HubConnectionHealthResponse>
  actions(identity: HubIntegrationsIdentity, providerId: string, limit: number, signal?: AbortSignal): Promise<HubTool[]>
  policies(identity: HubIntegrationsIdentity, connectionId: string, signal?: AbortSignal): Promise<HubPolicy[]>
  setPolicy(identity: HubIntegrationsIdentity, connectionId: string, actionPath: string, decision: HubPolicyDecision, signal?: AbortSignal): Promise<HubPolicy>
  resetPolicy(identity: HubIntegrationsIdentity, connectionId: string, actionPath: string, signal?: AbortSignal): Promise<void>
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hub settings response.')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Hub settings response.')
  return value
}

function namedArray<T>(value: unknown, key: string): T[] {
  const rows = array(object(value)[key])
  if (rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid Hub settings response.')
  return rows as T[]
}

function namedObject<T>(value: unknown, key: string): T {
  return object(object(value)[key]) as T
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new TypeError('Invalid Hub settings identifier.')
  return encodeURIComponent(value)
}

/** Finite browser transport for the server-owned `createHubSettingsRoutes` API. */
export function createHubIntegrationsClient(request: HubSettingsRequestFn, basePath = '/api/hub/settings'): HubIntegrationsClient {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new TypeError('Invalid Hub settings basePath.')

  async function call(identity: HubIntegrationsIdentity, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', signal?: AbortSignal, body?: object): Promise<unknown> {
    if (![identity.userId, identity.sessionId, identity.workspaceId].every(part => typeof part === 'string' && part.trim())) {
      throw new TypeError('Hub settings identity is required.')
    }
    const response = await request({
      identity,
      path: `${basePath}${path}`,
      init: { method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) },
    })
    if (!response.ok) {
      let code: string | undefined
      try {
        const error = object(await response.json())
        if (typeof error.code === 'string') code = error.code
      } catch { /* Status remains authoritative when a response is unreadable. */ }
      throw new Error(`Hub settings request failed (${response.status}${code ? `, ${code}` : ''}).`)
    }
    return response.json()
  }

  return {
    async providers(identity, signal) { return namedArray<HubProvider>(await call(identity, '/providers', 'GET', signal), 'providers') },
    async connections(identity, signal) { return namedArray<HubConnection>(await call(identity, '/connections', 'GET', signal), 'connections') },
    async startOAuth(identity, providerId, input, signal) {
      const response = object(await call(identity, `/connections/${segment(providerId)}/start`, 'POST', signal, input))
      if (typeof response.redirectUrl !== 'string') throw new Error('Invalid Hub OAuth response.')
      return response as unknown as HubOAuthStartResponse
    },
    async connectApiKey(identity, providerId, apiKey, metadata, signal) {
      return namedObject<HubConnection>(await call(identity, `/connections/${segment(providerId)}/connect-key`, 'POST', signal, { apiKey, ...(metadata === undefined ? {} : { metadata }) }), 'connection')
    },
    async revoke(identity, connectionId, signal) { return namedObject<HubConnection>(await call(identity, `/connections/${segment(connectionId)}`, 'DELETE', signal), 'connection') },
    async health(identity, connectionId, signal) {
      const response = object(await call(identity, `/connections/${segment(connectionId)}/health`, 'POST', signal))
      object(response.connection)
      object(response.health)
      return response as unknown as HubConnectionHealthResponse
    },
    async actions(identity, providerId, limit, signal) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Hub action limit must be 1–200.')
      const search = new URLSearchParams({ query: '', limit: String(limit) })
      return namedArray<HubTool>(await call(identity, `/providers/${segment(providerId)}/actions?${search}`, 'GET', signal), 'tools')
    },
    async policies(identity, connectionId, signal) {
      const search = new URLSearchParams({ connectionId })
      return namedArray<HubPolicy>(await call(identity, `/policies?${search}`, 'GET', signal), 'policies')
    },
    async setPolicy(identity, connectionId, actionPath, decision, signal) {
      return namedObject<HubPolicy>(await call(identity, '/policies', 'PUT', signal, { connectionId, actionPath, decision }), 'policy')
    },
    async resetPolicy(identity, connectionId, actionPath, signal) {
      const response = object(await call(identity, '/policies', 'DELETE', signal, { connectionId, actionPath }))
      if (response.connectionId !== connectionId || response.actionPath !== actionPath || typeof response.deleted !== 'boolean') {
        throw new Error('Invalid Hub policy reset response.')
      }
    },
  }
}
