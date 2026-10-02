/** Finite, application-authorized account settings over the existing Hub SDK. */
import { parseJsonObjectBody } from '../web/core'

/** Non-secret API-key setup shapes supported by the Hub SDK. */
export type HubSettingsApiKeyMetadata =
  | { propertyId: string; currency?: string }
  | { listings: Array<{ id: string; pms: string }> }

/** Browser OAuth setup, excluding CLI mode and identity/credential overrides. */
export interface HubSettingsOAuthInput {
  returnUrl: string
  connectionParameters?: Record<string, string>
}

type PolicyDecision = 'allow' | 'ask' | 'deny'

/**
 * Structural subset of the existing SDK, with no execution methods. Keeping
 * this structural avoids imposing a Hub SDK peer on existing platform imports.
 */
export interface HubSettingsClient {
  connections: {
    providers(): Promise<unknown>
    list(): Promise<unknown>
    start(provider: string, input: HubSettingsOAuthInput): Promise<unknown>
    connectApiKey(provider: string, apiKey: string, metadata?: HubSettingsApiKeyMetadata): Promise<unknown>
    revoke(connectionId: string): Promise<unknown>
    health(connectionId: string): Promise<unknown>
  }
  tools: {
    search(query: string, options: { provider: string; limit: number }): Promise<unknown>
  }
  permissions: {
    list(connectionId: string): Promise<unknown>
    set(input: { connectionId: string; actionPath: string; decision: PolicyDecision }): Promise<unknown>
    delete(input: { connectionId: string; actionPath: string }): Promise<unknown>
  }
}

/** Validated, exact intent. The provider API key is deliberately not copied here. */
export type HubSettingsOperation =
  | { readonly operation: 'providers.list' | 'connections.list'; readonly target: 'caller-account' }
  | { readonly operation: 'oauth.start'; readonly provider: string; readonly input: Readonly<HubSettingsOAuthInput> }
  | { readonly operation: 'api-key.connect'; readonly provider: string; readonly metadata?: HubSettingsApiKeyMetadata }
  | { readonly operation: 'connection.revoke' | 'connection.health' | 'policies.list'; readonly connectionId: string }
  | { readonly operation: 'provider.actions'; readonly provider: string; readonly query: string; readonly limit: number }
  | { readonly operation: 'policy.set'; readonly connectionId: string; readonly actionPath: string; readonly decision: PolicyDecision }
  | { readonly operation: 'policy.reset'; readonly connectionId: string; readonly actionPath: string }

/** Server-derived application identity, not fields read from browser input. */
export interface HubSettingsPrincipal {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string
}

export interface HubSettingsGrant {
  readonly authorized: true
  readonly principal: HubSettingsPrincipal
}

export interface HubSettingsClientBinding {
  readonly client: HubSettingsClient
  /** Reassert the identity against which the credential was actually resolved. */
  readonly principal: HubSettingsPrincipal
  /** Never env/admin credentials, another owner's key, or a brokered execution token. */
  readonly credentialSource: 'caller-account'
}

export interface HubSettingsContext {
  /** Application-owned mount path, without a trailing slash. Default /api/hub/settings. */
  basePath?: string
  /**
   * Required on EVERY valid operation, including reads. Validate the current
   * session, CSRF protection, workspace role and exact target/decision here.
   * Return a denial Response or throw the app's auth Response to reject.
   * The body has been consumed; use the validated intent, not request.json().
   * OAuth success, connection ownership/policy, app consent and workspace
   * binding are separate facts. An execution grant is not a settings grant.
   */
  authorize(request: Request, operation: HubSettingsOperation): Promise<HubSettingsGrant | Response>
  /** Called only after authorization. Resolve the caller's linked account SDK client server-side. */
  resolveClient(principal: HubSettingsPrincipal): Promise<HubSettingsClientBinding>
}

export interface HubSettingsRoutes {
  /** Exact method/path allowlist under basePath; never forwards request headers or arbitrary paths. */
  handle(request: Request): Promise<Response>
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function invalid(): never {
  // Do not reflect request values: API keys and OAuth parameters can be sensitive.
  throw json({ error: 'Invalid Hub settings request', code: 'HUB_INVALID_INPUT' }, 400)
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}

function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  return value
}

function identifier(value: unknown): string {
  const id = text(value, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) invalid()
  return id
}

function action(value: unknown): string {
  const path = text(value)
  // An exact dotted action, never a provider wildcard, path, glob or pattern.
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(path)) invalid()
  return path
}

function metadata(value: unknown): HubSettingsApiKeyMetadata {
  const input = record(value)
  if ('propertyId' in input) {
    onlyKeys(input, ['propertyId', 'currency'])
    return { propertyId: text(input.propertyId), ...(input.currency === undefined ? {} : { currency: text(input.currency) }) }
  }
  onlyKeys(input, ['listings'])
  if (!Array.isArray(input.listings) || input.listings.length === 0 || input.listings.length > 200) invalid()
  return { listings: input.listings.map((item) => {
    const listing = record(item)
    onlyKeys(listing, ['id', 'pms'])
    return { id: text(listing.id), pms: text(listing.pms) }
  }) }
}

function oauthInput(body: Record<string, unknown>, url: URL): HubSettingsOAuthInput {
  onlyKeys(body, ['returnUrl', 'connectionParameters'])
  const returnUrl = text(body.returnUrl, 2048)
  let destination: URL
  try { destination = new URL(returnUrl) } catch { invalid() }
  if (!['https:', 'http:'].includes(destination.protocol) || destination.origin !== url.origin || destination.username || destination.password) invalid()
  const input: HubSettingsOAuthInput = { returnUrl }
  if (body.connectionParameters !== undefined) {
    const parameters = record(body.connectionParameters)
    if (Object.keys(parameters).length > 20) invalid()
    input.connectionParameters = Object.fromEntries(Object.entries(parameters).map(([key, value]) => {
      identifier(key)
      // These are non-secret provider setup values, never Hub auth or identity overrides.
      if (/^(?:user|userid|owner|ownerid|workspace|workspaceid|team|teamid|principal|principalid|session|sessionid|authorization|headers|cookie|apikey|token|accesstoken|refreshtoken|clientsecret|secret|credentials?|appid|clientid)$/.test(key.replace(/[_-]/g, '').toLowerCase())) invalid()
      return [key, text(value, 1024)]
    }))
  }
  return input
}

function query(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) invalid()
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if ((request.headers.get('content-type')?.split(';')[0] ?? '').trim().toLowerCase() !== 'application/json') {
    throw json({ error: 'Expected application/json', code: 'HUB_INVALID_INPUT' }, 415)
  }
  const [value, error] = await parseJsonObjectBody(request, { maxBytes: 64 * 1024 })
  if (error) { error.headers.set('Cache-Control', 'no-store'); throw error }
  return value
}

/** Snapshot nested intent before application callbacks can observe it. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function isPrincipal(value: unknown): value is HubSettingsPrincipal {
  if (value === null || typeof value !== 'object') return false
  const principal = value as Partial<HubSettingsPrincipal>
  return [principal.userId, principal.sessionId, principal.workspaceId].every((part) => typeof part === 'string' && part.trim().length > 0)
}

interface Prepared {
  intent: HubSettingsOperation
  call(client: HubSettingsClient): Promise<unknown>
}

const ROUTES = [
  { kind: 'providers', path: /^\/providers$/, methods: ['GET'] },
  { kind: 'connections', path: /^\/connections$/, methods: ['GET'] },
  { kind: 'oauth', path: /^\/connections\/([^/]+)\/start$/, methods: ['POST'] },
  { kind: 'api-key', path: /^\/connections\/([^/]+)\/connect-key$/, methods: ['POST'] },
  { kind: 'revoke', path: /^\/connections\/([^/]+)$/, methods: ['DELETE'] },
  { kind: 'health', path: /^\/connections\/([^/]+)\/health$/, methods: ['POST'] },
  { kind: 'actions', path: /^\/providers\/([^/]+)\/actions$/, methods: ['GET'] },
  { kind: 'policies', path: /^\/policies$/, methods: ['GET', 'PUT', 'DELETE'] },
] as const

async function prepare(request: Request, basePath: string): Promise<Prepared | Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${basePath}/`)) return json({ error: 'Not found' }, 404)
  const path = url.pathname.slice(basePath.length)
  const route = ROUTES.find((candidate) => candidate.path.test(path))
  if (!route) return json({ error: 'Not found' }, 404)
  if (!(route.methods as readonly string[]).includes(request.method)) {
    return json({ error: 'Method not allowed' }, 405, { Allow: route.methods.join(', ') })
  }
  const target = route.path.exec(path)?.[1]
  const isPolicyRead = route.kind === 'policies' && request.method === 'GET'
  const isActions = route.kind === 'actions'
  query(url, isPolicyRead ? ['connectionId'] : isActions ? ['query', 'limit'] : [])
  const hasJson = route.kind === 'oauth' || route.kind === 'api-key' || (route.kind === 'policies' && !isPolicyRead)
  if (!hasJson && request.body !== null) invalid()

  if (route.kind === 'providers') return { intent: { operation: 'providers.list', target: 'caller-account' }, call: (hub) => hub.connections.providers() }
  if (route.kind === 'connections') return { intent: { operation: 'connections.list', target: 'caller-account' }, call: (hub) => hub.connections.list() }
  if (isPolicyRead) {
    const connectionId = identifier(url.searchParams.get('connectionId'))
    return { intent: { operation: 'policies.list', connectionId }, call: (hub) => hub.permissions.list(connectionId) }
  }
  if (route.kind === 'policies') {
    const input = await body(request)
    onlyKeys(input, request.method === 'PUT' ? ['connectionId', 'actionPath', 'decision'] : ['connectionId', 'actionPath'])
    const connectionId = identifier(input.connectionId)
    const actionPath = action(input.actionPath)
    if (request.method === 'DELETE') return { intent: { operation: 'policy.reset', connectionId, actionPath }, call: (hub) => hub.permissions.delete({ connectionId, actionPath }) }
    const decision = input.decision
    if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') invalid()
    return { intent: { operation: 'policy.set', connectionId, actionPath, decision }, call: (hub) => hub.permissions.set({ connectionId, actionPath, decision }) }
  }
  const id = identifier(target)
  if (isActions) {
    const search = url.searchParams.get('query') ?? ''
    if (search.length > 512 || /[\u0000-\u001f\u007f]/.test(search)) invalid()
    const rawLimit = url.searchParams.get('limit') ?? '200'
    if (!/^[1-9][0-9]*$/.test(rawLimit)) invalid()
    const limit = Number(rawLimit)
    if (limit > 200) invalid()
    return { intent: { operation: 'provider.actions', provider: id, query: search, limit }, call: (hub) => hub.tools.search(search, { provider: id, limit }) }
  }
  if (route.kind === 'oauth') {
    const input = freeze(oauthInput(await body(request), url))
    return { intent: { operation: 'oauth.start', provider: id, input }, call: (hub) => hub.connections.start(id, input) }
  }
  if (route.kind === 'api-key') {
    const input = await body(request)
    onlyKeys(input, ['apiKey', 'metadata'])
    const apiKey = text(input.apiKey, 16 * 1024)
    const setup = input.metadata === undefined ? undefined : freeze(metadata(input.metadata))
    return { intent: { operation: 'api-key.connect', provider: id, ...(setup === undefined ? {} : { metadata: setup }) }, call: (hub) => hub.connections.connectApiKey(id, apiKey, setup) }
  }
  if (route.kind === 'health') return { intent: { operation: 'connection.health', connectionId: id }, call: (hub) => hub.connections.health(id) }
  if (route.kind === 'revoke') return { intent: { operation: 'connection.revoke', connectionId: id }, call: (hub) => hub.connections.revoke(id) }
  return invalid()
}

/** Build the finite, application-authorized Hub settings server boundary. */
export function createHubSettingsRoutes(ctx: HubSettingsContext): HubSettingsRoutes {
  if (typeof ctx.authorize !== 'function' || typeof ctx.resolveClient !== 'function') {
    throw new TypeError('Hub settings requires authorize and resolveClient callbacks')
  }
  const basePath = ctx.basePath ?? '/api/hub/settings'
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new TypeError('Invalid Hub settings basePath')

  return { async handle(request) {
    let prepared: Prepared | Response
    try { prepared = await prepare(request, basePath) } catch (error) {
      if (error instanceof Response) return error
      throw error
    }
    if (prepared instanceof Response) return prepared
    // Auth throws intentionally propagate. No SDK/client lookup has occurred.
    const grant = await ctx.authorize(request, freeze(prepared.intent))
    if (grant instanceof Response) return grant
    if (grant?.authorized !== true || !isPrincipal(grant.principal)) {
      return json({ error: 'Hub settings authorization required', code: 'HUB_FORBIDDEN' }, 403)
    }
    const principal = Object.freeze({ userId: grant.principal.userId, sessionId: grant.principal.sessionId, workspaceId: grant.principal.workspaceId })
    try {
      const bound = await ctx.resolveClient(principal)
      if (bound?.credentialSource !== 'caller-account' || !isPrincipal(bound.principal) ||
        bound.principal.userId !== principal.userId || bound.principal.sessionId !== principal.sessionId || bound.principal.workspaceId !== principal.workspaceId) {
        return json({ error: 'Hub settings caller binding mismatch', code: 'HUB_FORBIDDEN' }, 403)
      }
      // Client resolution can outlive a session or role grant. Recheck before the Hub effect.
      const renewed = await ctx.authorize(request, prepared.intent)
      if (renewed instanceof Response) return renewed
      if (renewed?.authorized !== true || !isPrincipal(renewed.principal) ||
        renewed.principal.userId !== principal.userId || renewed.principal.sessionId !== principal.sessionId || renewed.principal.workspaceId !== principal.workspaceId) {
        return json({ error: 'Hub settings authorization required', code: 'HUB_FORBIDDEN' }, 403)
      }
      return json(await prepared.call(bound.client))
    } catch (error) {
      // Structural detection survives SDK copies without a runtime peer import.
      if (error instanceof Error && error.name === 'HubSdkError' && typeof (error as { code?: unknown }).code === 'string') {
        const { code, status } = error as Error & { code: string; status?: number }
        const fallback = code === 'HUB_INVALID_INPUT' ? 400 : code === 'HUB_UNAUTHENTICATED' ? 401 : code === 'HUB_FORBIDDEN' ? 403 : 502
        const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback
        // Never echo upstream details/message: they can contain submitted credentials.
        return json({ error: 'Hub settings request failed', code }, httpStatus)
      }
      throw error
    }
  } }
}
