export interface WorkspaceSandboxInstanceLike {
  id: string
  name?: string
  status?: string
  connection?: {
    runtimeUrl?: string
    sidecarUrl?: string
    authToken?: string
    sidecarToken?: string
    authTokenExpiresAt?: string
  } | null
}

export interface WorkspaceSandboxEnsureContext {
  workspaceId: string
  userId: string
}

export interface WorkspaceSandboxManagerOptions<TClient, TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void> {
  getClient: (ctx: WorkspaceSandboxEnsureContext) => Promise<TClient> | TClient
  nameForWorkspace: (workspaceId: string, ctx: WorkspaceSandboxEnsureContext) => string
  listSandboxes: (client: TClient, ctx: WorkspaceSandboxEnsureContext) => Promise<TBox[]>
  createSandbox: (args: {
    client: TClient
    ctx: WorkspaceSandboxEnsureContext
    name: string
    options: TEnsureOptions
    listError?: unknown
  }) => Promise<TBox>
  waitForRunning?: (box: TBox, ctx: WorkspaceSandboxEnsureContext) => Promise<void>
  prepareExisting?: (box: TBox, ctx: WorkspaceSandboxEnsureContext, options: TEnsureOptions) => Promise<TBox | void>
  prepareCreated?: (box: TBox, ctx: WorkspaceSandboxEnsureContext, options: TEnsureOptions) => Promise<TBox | void>
  onListError?: (error: unknown, ctx: WorkspaceSandboxEnsureContext) => void
}

export interface WorkspaceSandboxManager<TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void> {
  ensureWorkspaceSandbox: (
    workspaceId: string,
    userId: string,
    options?: TEnsureOptions,
  ) => Promise<TBox>
}

export function createWorkspaceSandboxManager<TClient, TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void>(
  opts: WorkspaceSandboxManagerOptions<TClient, TBox, TEnsureOptions>,
): WorkspaceSandboxManager<TBox, TEnsureOptions> {
  return {
    async ensureWorkspaceSandbox(workspaceId, userId, options) {
      if (!workspaceId) throw new Error('workspaceId is required')
      if (!userId) throw new Error('userId is required')
      const ctx = { workspaceId, userId }
      const client = await opts.getClient(ctx)
      const name = opts.nameForWorkspace(workspaceId, ctx)
      let listError: unknown
      let existing: TBox[] = []

      try {
        existing = await opts.listSandboxes(client, ctx)
      } catch (err) {
        listError = err
        opts.onListError?.(err, ctx)
      }

      const found = existing.find((box) => box.name === name)
      if (found) {
        return (await opts.prepareExisting?.(found, ctx, options as TEnsureOptions)) ?? found
      }

      const created = await opts.createSandbox({
        client,
        ctx,
        name,
        options: options as TEnsureOptions,
        listError,
      })
      await opts.waitForRunning?.(created, ctx)
      return (await opts.prepareCreated?.(created, ctx, options as TEnsureOptions)) ?? created
    },
  }
}

export interface SandboxTerminalTokenOptions {
  secret?: string
  prefix?: string
  expiresInMs?: number
  now?: () => number
}

export interface SandboxTerminalTokenSubject {
  userId: string
  workspaceId: string
  sandboxId: string
}

export interface SandboxTerminalTokenResult {
  token: string
  expiresAt: Date
}

interface SandboxTerminalTokenPayload extends SandboxTerminalTokenSubject {
  exp: number
  n: string
}

const DEFAULT_TERMINAL_TOKEN_PREFIX = 'sbxt_'
const DEFAULT_TERMINAL_TOKEN_TTL_MS = 15 * 60 * 1000
const BEARER_SUBPROTOCOL_PREFIX = 'bearer.'

export async function createSandboxTerminalToken(
  subject: SandboxTerminalTokenSubject,
  opts: SandboxTerminalTokenOptions,
): Promise<SandboxTerminalTokenResult> {
  validateTerminalSubject(subject)
  const secret = opts.secret?.trim()
  if (!secret) throw new Error('terminal token secret is required')
  const now = opts.now ?? Date.now
  const expiresInMs = opts.expiresInMs ?? DEFAULT_TERMINAL_TOKEN_TTL_MS
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) throw new Error('expiresInMs must be a positive number')
  const expiresAt = new Date(now() + expiresInMs)
  const payload: SandboxTerminalTokenPayload = {
    ...subject,
    exp: Math.floor(expiresAt.getTime() / 1000),
    n: crypto.randomUUID(),
  }
  const encodedPayload = base64urlText(JSON.stringify(payload))
  const signature = await signText(encodedPayload, secret)
  return {
    token: `${opts.prefix ?? DEFAULT_TERMINAL_TOKEN_PREFIX}${encodedPayload}.${signature}`,
    expiresAt,
  }
}

export async function verifySandboxTerminalToken(
  token: string,
  expected: SandboxTerminalTokenSubject,
  opts: SandboxTerminalTokenOptions,
): Promise<boolean> {
  validateTerminalSubject(expected)
  const secret = opts.secret?.trim()
  const prefix = opts.prefix ?? DEFAULT_TERMINAL_TOKEN_PREFIX
  if (!secret || !token.startsWith(prefix)) return false
  const body = token.slice(prefix.length)
  const dot = body.lastIndexOf('.')
  if (dot <= 0 || dot === body.length - 1) return false
  const encodedPayload = body.slice(0, dot)
  const signature = body.slice(dot + 1)
  if (!timingSafeEqual(signature, await signText(encodedPayload, secret))) return false

  let payload: SandboxTerminalTokenPayload
  try {
    payload = JSON.parse(textFromBase64url(encodedPayload)) as SandboxTerminalTokenPayload
  } catch {
    return false
  }

  const now = opts.now ?? Date.now
  return payload.userId === expected.userId
    && payload.workspaceId === expected.workspaceId
    && payload.sandboxId === expected.sandboxId
    && Number.isFinite(payload.exp)
    && payload.exp > Math.floor(now() / 1000)
}

export interface AuthenticatedSandboxUser {
  id: string
}

export interface WorkspaceSandboxConnectionHandlerOptions<TBox extends WorkspaceSandboxInstanceLike> {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string }) => Promise<void>
  ensureWorkspaceSandbox: (workspaceId: string, userId: string) => Promise<TBox>
  tokenSecret: string | (() => string | undefined)
  tokenExpiresInMs?: number
  tokenPrefix?: string
  proxyRuntimeUrl?: (args: { request: Request; workspaceId: string; sandboxId: string; box: TBox }) => string
  exposeDirectSidecar?: boolean
}

export interface WorkspaceSandboxConnectionArgs {
  request: Request
  params: {
    workspaceId?: string
  }
}

export function createWorkspaceSandboxConnectionHandler<TBox extends WorkspaceSandboxInstanceLike>(
  opts: WorkspaceSandboxConnectionHandlerOptions<TBox>,
) {
  return async function handleWorkspaceSandboxConnection({ request, params }: WorkspaceSandboxConnectionArgs): Promise<Response> {
    const user = await opts.requireUser(request)
    const workspaceId = params.workspaceId
    if (!workspaceId) return Response.json({ error: 'workspaceId is required' }, { status: 400 })
    await opts.requireWorkspaceAccess({ request, userId: user.id, workspaceId })

    let box: TBox
    try {
      box = await opts.ensureWorkspaceSandbox(workspaceId, user.id)
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to provision workspace sandbox' },
        { status: 500 },
      )
    }

    const directSidecarUrl = box.connection?.sidecarUrl ?? (box.connection?.authToken ? box.connection?.runtimeUrl : undefined)
    const directSidecarToken = box.connection?.authToken ?? box.connection?.sidecarToken
    const directSidecarExpiresAt = box.connection?.authTokenExpiresAt
    if (opts.exposeDirectSidecar && directSidecarUrl && directSidecarToken && directSidecarExpiresAt) {
      return Response.json({
        runtimeUrl: directSidecarUrl,
        sidecarUrl: directSidecarUrl,
        token: directSidecarToken,
        expiresAt: directSidecarExpiresAt,
        status: box.status,
        sandboxId: box.id,
      })
    }

    if (!box.connection?.runtimeUrl) {
      return Response.json(
        {
          error: 'Workspace sandbox runtime not ready. The sandbox is still initializing -- retry in a few seconds.',
          status: box.status,
        },
        { status: 503 },
      )
    }

    const secret = typeof opts.tokenSecret === 'function' ? opts.tokenSecret() : opts.tokenSecret
    let scoped: SandboxTerminalTokenResult
    try {
      scoped = await createSandboxTerminalToken(
        { userId: user.id, workspaceId, sandboxId: box.id },
        { secret, expiresInMs: opts.tokenExpiresInMs, prefix: opts.tokenPrefix },
      )
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to mint sandbox token' },
        { status: 503 },
      )
    }

    const runtimeUrl = opts.proxyRuntimeUrl
      ? opts.proxyRuntimeUrl({ request, workspaceId, sandboxId: box.id, box })
      : `/api/workspaces/${encodeURIComponent(workspaceId)}/sandbox/runtime/${encodeURIComponent(box.id)}`

    return Response.json({
      runtimeUrl,
      sidecarUrl: runtimeUrl,
      token: scoped.token,
      expiresAt: scoped.expiresAt.toISOString(),
      status: box.status,
      sandboxId: box.id,
    })
  }
}

export interface SandboxApiCredentials {
  baseUrl: string
  apiKey: string
}

export interface SandboxRuntimeConnection {
  runtimeUrl: string
  authToken?: string
}

export interface WorkspaceSandboxRuntimeProxyHandlerOptions {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<void>
  getSandboxApiCredentials: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxApiCredentials>
  getSandboxRuntimeConnection?: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxRuntimeConnection | null | undefined>
  tokenSecret: string | (() => string | undefined)
  tokenPrefix?: string
  fetch?: typeof fetch
  forwardHeaders?: string[]
}

export interface WorkspaceSandboxRuntimeProxyArgs {
  request: Request
  params: {
    workspaceId?: string
    sandboxId?: string
    '*'?: string
  }
}

export function createWorkspaceSandboxRuntimeProxyHandler(opts: WorkspaceSandboxRuntimeProxyHandlerOptions) {
  return async function handleWorkspaceSandboxRuntimeProxy({ request, params }: WorkspaceSandboxRuntimeProxyArgs): Promise<Response> {
    const user = await opts.requireUser(request)
    const workspaceId = params.workspaceId
    const sandboxId = params.sandboxId
    const runtimePath = params['*']
    if (!workspaceId || !sandboxId || !runtimePath) {
      return Response.json({ error: 'workspaceId, sandboxId, and runtime path are required' }, { status: 400 })
    }
    const encodedRuntimePath = encodeSandboxRuntimePath(runtimePath)
    if (!encodedRuntimePath) return Response.json({ error: 'Invalid sandbox runtime path' }, { status: 400 })

    await opts.requireWorkspaceAccess({ request, userId: user.id, workspaceId, sandboxId })

    const token = terminalTokenFromRequest(request.headers)
    const secret = typeof opts.tokenSecret === 'function' ? opts.tokenSecret() : opts.tokenSecret
    if (!token || !(await verifySandboxTerminalToken(token, { userId: user.id, workspaceId, sandboxId }, { secret, prefix: opts.tokenPrefix }))) {
      return Response.json({ error: 'Invalid terminal token' }, { status: 403 })
    }

    const requestUrl = new URL(request.url)
    const runtimeConnection = await opts.getSandboxRuntimeConnection?.({ request, userId: user.id, workspaceId, sandboxId })
    const credentials = runtimeConnection ? null : await opts.getSandboxApiCredentials({ request, userId: user.id, workspaceId, sandboxId })
    const upstreamUrl = runtimeConnection
      ? new URL(encodedRuntimePath, `${runtimeConnection.runtimeUrl.replace(/\/+$/, '')}/`)
      : new URL(
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/runtime/${encodedRuntimePath}`,
        credentials!.baseUrl,
      )
    upstreamUrl.search = requestUrl.search

    const headers = buildSandboxRuntimeProxyHeaders(
      request.headers,
      runtimeConnection?.authToken ?? credentials!.apiKey,
      opts.forwardHeaders,
    )
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: 'manual',
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      init.body = request.body
      init.duplex = 'half'
    }

    const fetchImpl = opts.fetch ?? fetch
    const response = await fetchImpl(upstreamUrl, init)
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('set-cookie')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }
}

// ---------------------------------------------------------------------------
// Terminal WebSocket upgrade
//
// The interactive terminal is WebSocket-only on the current sidecar (the REST
// `POST /terminals` create route was removed in the websocket-first migration).
// `createWorkspaceSandboxRuntimeProxyHandler` runs inside a React Router
// loader/action, which can only return a normal Response — never a 101 — so it
// cannot perform the upgrade. The upgrade must be intercepted at the Worker
// fetch entry (server.ts) BEFORE React Router, mirroring the session-stream WS
// interceptor. This handler does exactly that: it auth-gates the upgrade (the
// scoped terminal token rides in the `bearer.` subprotocol because browsers
// can't set Authorization on a WS handshake) and forwards it to the sandbox API
// runtime proxy with the server-to-server credential. Returning the upstream
// 101 passes the live socket straight through to the browser — the same idiom
// the sandbox API uses to reach the orchestrator.
//
// NOTE: this only runs under a WebSocket-capable runtime (Cloudflare Workers /
// `wrangler`). `react-router dev` (Vite) never invokes the Worker fetch entry,
// so the terminal WS is exercised under `wrangler dev` / production.
// ---------------------------------------------------------------------------

const SANDBOX_TERMINAL_WS_PATHNAME =
  /^\/api\/workspaces\/([^/]+)\/sandbox\/runtime\/([^/]+)\/(terminals\/[^/]+\/ws)$/

export interface SandboxTerminalWsMatch {
  workspaceId: string
  sandboxId: string
  subPath: string
}

/**
 * Parse a same-origin terminal-WS pathname into its parts, or `null` when the
 * path is not a sandbox terminal WebSocket. Matches the default `runtimeUrl`
 * convention emitted by {@link createWorkspaceSandboxConnectionHandler}
 * (`/api/workspaces/:workspaceId/sandbox/runtime/:sandboxId`) with a canonical
 * `terminals/:id/ws` sub-path. `subPath` is left URL-encoded for re-use in the
 * upstream URL; the ids are decoded for auth checks.
 */
export function matchSandboxTerminalWsPath(pathname: string): SandboxTerminalWsMatch | null {
  const m = SANDBOX_TERMINAL_WS_PATHNAME.exec(pathname)
  if (!m) return null
  const [, workspaceId, sandboxId, subPath] = m
  if (!workspaceId || !sandboxId || !subPath) return null
  return { workspaceId: decodeURIComponent(workspaceId), sandboxId: decodeURIComponent(sandboxId), subPath }
}

/** True when `request` is a WebSocket upgrade for a sandbox terminal path. */
export function isSandboxTerminalWsUpgrade(request: Request): boolean {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return false
  try {
    return matchSandboxTerminalWsPath(new URL(request.url).pathname) !== null
  } catch {
    return false
  }
}

export interface WorkspaceSandboxTerminalUpgradeHandlerOptions {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<void>
  getSandboxApiCredentials: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxApiCredentials>
  getSandboxRuntimeConnection?: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxRuntimeConnection | null | undefined>
  tokenSecret: string | (() => string | undefined)
  tokenPrefix?: string
  fetch?: typeof fetch
}

/**
 * Build a Worker-entry handler that proxies a sandbox terminal WebSocket
 * upgrade to the sandbox API runtime proxy. Returns `null` when the request is
 * not a terminal WS upgrade, so the caller can fall through to its normal
 * request handler:
 *
 * ```ts
 * const handled = await handleSandboxTerminalUpgrade(request)
 * if (handled) return handled
 * ```
 */
export function createWorkspaceSandboxTerminalUpgradeHandler(opts: WorkspaceSandboxTerminalUpgradeHandlerOptions) {
  return async function handleWorkspaceSandboxTerminalUpgrade(request: Request): Promise<Response | null> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return null
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return null
    }
    const match = matchSandboxTerminalWsPath(url.pathname)
    if (!match) return null
    const { workspaceId, sandboxId, subPath } = match

    let user: AuthenticatedSandboxUser
    try {
      user = await opts.requireUser(request)
    } catch {
      return new Response('Unauthorized', { status: 401 })
    }
    try {
      await opts.requireWorkspaceAccess({ request, userId: user.id, workspaceId, sandboxId })
    } catch {
      return new Response('Forbidden', { status: 403 })
    }

    const token = terminalTokenFromRequest(request.headers)
    const secret = typeof opts.tokenSecret === 'function' ? opts.tokenSecret() : opts.tokenSecret
    if (!token || !(await verifySandboxTerminalToken(token, { userId: user.id, workspaceId, sandboxId }, { secret, prefix: opts.tokenPrefix }))) {
      return new Response('Invalid terminal token', { status: 403 })
    }

    const runtimeConnection = await opts.getSandboxRuntimeConnection?.({ request, userId: user.id, workspaceId, sandboxId })
    const credentials = runtimeConnection ? null : await opts.getSandboxApiCredentials({ request, userId: user.id, workspaceId, sandboxId })
    const upstreamUrl = runtimeConnection
      ? new URL(subPath, `${runtimeConnection.runtimeUrl.replace(/\/+$/, '')}/`)
      : new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/runtime/${subPath}`, credentials!.baseUrl)
    upstreamUrl.search = url.search

    // Forward the upgrade verbatim — keep the Upgrade/Connection + Sec-WebSocket-*
    // headers the handshake needs and the offered subprotocol — but swap the auth
    // to the server-to-server sandbox credential. Returning the upstream 101
    // passes the live socket straight through to the browser.
    const upstreamHeaders = new Headers(request.headers)
    upstreamHeaders.set('Authorization', `Bearer ${runtimeConnection?.authToken ?? credentials!.apiKey}`)
    upstreamHeaders.delete('host')
    const fetchImpl = opts.fetch ?? fetch
    return fetchImpl(upstreamUrl.toString(), { method: request.method, headers: upstreamHeaders })
  }
}

const DEFAULT_RUNTIME_PROXY_HEADERS = ['accept', 'content-type', 'last-event-id', 'x-session-id']

export function buildSandboxRuntimeProxyHeaders(source: Headers, sandboxApiKey: string, forwardHeaders = DEFAULT_RUNTIME_PROXY_HEADERS): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${sandboxApiKey}`)
  for (const name of forwardHeaders) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

export function encodeSandboxRuntimePath(runtimePath: string): string | null {
  const segments = runtimePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

export function bearerToken(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.toLowerCase() === 'bearer') return null
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const token = trimmed.slice('bearer '.length).trim()
    return token || null
  }
  return trimmed
}

export function bearerSubprotocolToken(value: string | null): string | null {
  if (!value) return null
  for (const part of value.split(',')) {
    const protocol = part.trim()
    if (!protocol.toLowerCase().startsWith(BEARER_SUBPROTOCOL_PREFIX)) continue
    const encoded = protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length)
    if (!encoded) return null
    try {
      const token = textFromBase64url(encoded).trim()
      return token || null
    } catch {
      return null
    }
  }
  return null
}

export function terminalTokenFromRequest(headers: Headers): string | null {
  return bearerToken(headers.get('Authorization')) ?? bearerSubprotocolToken(headers.get('Sec-WebSocket-Protocol'))
}

function validateTerminalSubject(subject: SandboxTerminalTokenSubject): void {
  if (!subject.userId) throw new Error('userId is required')
  if (!subject.workspaceId) throw new Error('workspaceId is required')
  if (!subject.sandboxId) throw new Error('sandboxId is required')
}

async function signText(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return base64url(new Uint8Array(sig))
}

function base64urlText(text: string): string {
  return base64url(new TextEncoder().encode(text))
}

function textFromBase64url(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
