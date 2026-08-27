import { base64UrlDecodeText } from '../crypto/web-token'
import {
  mintTerminalProxyToken,
  verifyTerminalProxyToken,
  type TerminalProxyIdentity,
} from './terminal-proxy-token'

/** Define the shape of a workspace sandbox instance including its connection details and status */
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

// Generic name-keyed sandbox lifecycle manager. A structural, substrate-free
// helper for products that drive their own SDK/box types (distinct from the
// concrete `ensureWorkspaceSandbox` in ./index, which is bound to the
// @tangle-network/sandbox client). Kept as a public export — external
// consumers compose it; removing it would be a breaking change.
/** Define the context containing workspace and user identifiers for sandbox environment operations */
export interface WorkspaceSandboxEnsureContext {
  workspaceId: string
  userId: string
}

/** Define configuration options for managing and interacting with workspace sandboxes */
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

/** Manage workspace sandboxes by ensuring their creation and retrieval for specified users */
export interface WorkspaceSandboxManager<TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void> {
  ensureWorkspaceSandbox: (
    workspaceId: string,
    userId: string,
    options?: TEnsureOptions,
  ) => Promise<TBox>
}

/** Create a manager to handle workspace sandbox instances with client and options configuration */
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

/** Define options for generating a sandbox terminal token including secret and expiration settings */
export interface SandboxTerminalTokenOptions {
  secret?: string
  expiresInMs?: number
  now?: () => number
}

/** Resolve the identity type used for sandbox terminal token subjects */
export type SandboxTerminalTokenSubject = TerminalProxyIdentity

/** Provide token and expiration details for a sandbox terminal session */
export interface SandboxTerminalTokenResult {
  token: string
  expiresAt: Date
}

const DEFAULT_TERMINAL_TOKEN_TTL_MS = 15 * 60 * 1000
const BEARER_SUBPROTOCOL_PREFIX = 'bearer.'
// Legacy `createSandboxTerminalToken` (pre proxy-token extraction) prefixed
// minted tokens with `sbxt_` and signed the unprefixed payload. New tokens
// carry no prefix. Strip it on verify so tokens minted by a prior deploy still
// validate within their (default 15-min) TTL window — avoids a wave of 403s on
// in-flight browser terminal sessions right after rollout.
const LEGACY_TERMINAL_TOKEN_PREFIX = 'sbxt_'

/** Generate a sandbox terminal token for a given subject with specified options */
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
  const minted = await mintTerminalProxyToken(secret, subject, expiresInMs, now)
  if (!minted.succeeded) throw minted.error
  return minted.value
}

/** Verify the validity of a sandbox terminal token against the expected identity and options */
export async function verifySandboxTerminalToken(
  token: string,
  expected: SandboxTerminalTokenSubject,
  opts: SandboxTerminalTokenOptions,
): Promise<boolean> {
  validateTerminalSubject(expected)
  const secret = opts.secret?.trim()
  const now = opts.now ?? Date.now
  const normalized = token.startsWith(LEGACY_TERMINAL_TOKEN_PREFIX)
    ? token.slice(LEGACY_TERMINAL_TOKEN_PREFIX.length)
    : token
  return verifyTerminalProxyToken(secret ?? '', normalized, expected, now)
}

/** Represent an authenticated user within a sandbox environment with a unique identifier */
export interface AuthenticatedSandboxUser {
  id: string
}

/** Define options to handle workspace sandbox connections with user authentication and access control */
export interface WorkspaceSandboxConnectionHandlerOptions<TBox extends WorkspaceSandboxInstanceLike> {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string }) => Promise<void>
  ensureWorkspaceSandbox: (workspaceId: string, userId: string) => Promise<TBox>
  tokenSecret: string | (() => string | undefined)
  tokenExpiresInMs?: number
  proxyRuntimeUrl?: (args: { request: Request; workspaceId: string; sandboxId: string; box: TBox }) => string
  exposeDirectSidecar?: boolean
}

/** Define arguments required to establish a workspace sandbox connection */
export interface WorkspaceSandboxConnectionArgs {
  request: Request
  params: {
    workspaceId?: string
  }
}

/** Create a handler to resolve workspace sandbox connections with user and access validation */
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

    const directSidecarUrl = box.connection?.sidecarUrl ?? box.connection?.runtimeUrl
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

    if (!directSidecarUrl) {
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
        { secret, expiresInMs: opts.tokenExpiresInMs },
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

/** Define credentials required to access the sandbox API environment */
export interface SandboxApiCredentials {
  baseUrl: string
  apiKey: string
}

/** Define a connection configuration for sandbox runtime including URL and optional server-side auth token */
export interface SandboxRuntimeConnection {
  runtimeUrl: string
  /** Server-side sidecar bearer. Must authorize terminal routes; never expose it to browser code. */
  authToken?: string
}

/** Define options for handling workspace sandbox runtime proxy including user, access, credentials, and connection retrieval */
export interface WorkspaceSandboxRuntimeProxyHandlerOptions {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<void>
  getSandboxApiCredentials: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxApiCredentials>
  getSandboxRuntimeConnection?: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxRuntimeConnection | null | undefined>
  tokenSecret: string | (() => string | undefined)
  fetch?: typeof fetch
  forwardHeaders?: string[]
}

/** Define arguments for proxying runtime requests within a workspace sandbox environment */
export interface WorkspaceSandboxRuntimeProxyArgs {
  request: Request
  params: {
    workspaceId?: string
    sandboxId?: string
    '*'?: string
  }
}

/** Create a proxy handler to resolve sandbox runtime requests with user and workspace access validation */
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
    if (!token || !(await verifySandboxTerminalToken(token, { userId: user.id, workspaceId, sandboxId }, { secret }))) {
      return Response.json({ error: 'Invalid terminal token' }, { status: 403 })
    }

    const requestUrl = new URL(request.url)
    const runtimeConnection = await opts.getSandboxRuntimeConnection?.({ request, userId: user.id, workspaceId, sandboxId })
    const directRuntimeConnection = runtimeConnection?.runtimeUrl && runtimeConnection.authToken ? runtimeConnection : null
    const credentials = directRuntimeConnection ? null : await opts.getSandboxApiCredentials({ request, userId: user.id, workspaceId, sandboxId })
    const upstreamUrl = directRuntimeConnection
      ? new URL(encodedRuntimePath, `${directRuntimeConnection.runtimeUrl.replace(/\/+$/, '')}/`)
      : new URL(
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/runtime/${encodedRuntimePath}`,
        credentials!.baseUrl,
      )
    upstreamUrl.search = requestUrl.search

    const headers = buildSandboxRuntimeProxyHeaders(
      request.headers,
      directRuntimeConnection?.authToken ?? credentials!.apiKey,
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

/** Define the structure for matching a sandbox terminal WebSocket with workspace and path details */
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
  const decodedWorkspaceId = safeDecodeURIComponent(workspaceId)
  const decodedSandboxId = safeDecodeURIComponent(sandboxId)
  if (!decodedWorkspaceId || !decodedSandboxId) return null
  return { workspaceId: decodedWorkspaceId, sandboxId: decodedSandboxId, subPath }
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

/** Define options to handle user authentication, workspace access, and sandbox API credential retrieval */
export interface WorkspaceSandboxTerminalUpgradeHandlerOptions {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<void>
  getSandboxApiCredentials: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxApiCredentials>
  getSandboxRuntimeConnection?: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxRuntimeConnection | null | undefined>
  tokenSecret: string | (() => string | undefined)
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
    if (!token || !(await verifySandboxTerminalToken(token, { userId: user.id, workspaceId, sandboxId }, { secret }))) {
      return new Response('Invalid terminal token', { status: 403 })
    }

    const runtimeConnection = await opts.getSandboxRuntimeConnection?.({ request, userId: user.id, workspaceId, sandboxId })
    const directRuntimeConnection = runtimeConnection?.runtimeUrl && runtimeConnection.authToken ? runtimeConnection : null
    const credentials = directRuntimeConnection ? null : await opts.getSandboxApiCredentials({ request, userId: user.id, workspaceId, sandboxId })
    const upstreamUrl = directRuntimeConnection
      ? new URL(subPath, `${directRuntimeConnection.runtimeUrl.replace(/\/+$/, '')}/`)
      : new URL(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/runtime/${subPath}`, credentials!.baseUrl)
    upstreamUrl.search = url.search

    // Forward the upgrade verbatim — keep the Upgrade/Connection + Sec-WebSocket-*
    // headers the handshake needs, but strip the browser-only bearer subprotocol
    // and send the server-to-server sandbox credential only as Authorization.
    // Returning the upstream 101 passes the live socket straight through to the browser.
    const upstreamHeaders = new Headers(request.headers)
    const upstreamBearer = directRuntimeConnection?.authToken ?? credentials!.apiKey
    upstreamHeaders.set('Authorization', `Bearer ${upstreamBearer}`)
    upstreamHeaders.delete('host')
    stripBearerSubprotocol(upstreamHeaders)
    const fetchImpl = opts.fetch ?? fetch
    return fetchImpl(upstreamUrl.toString(), { method: request.method, headers: upstreamHeaders })
  }
}

const DEFAULT_RUNTIME_PROXY_HEADERS = ['accept', 'content-type', 'last-event-id', 'x-session-id']

/** Build proxy headers for sandbox runtime including authorization and forwarded headers */
export function buildSandboxRuntimeProxyHeaders(source: Headers, sandboxApiKey: string, forwardHeaders = DEFAULT_RUNTIME_PROXY_HEADERS): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${sandboxApiKey}`)
  for (const name of forwardHeaders) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** Encode a runtime path by URI-encoding each valid segment and returning null for invalid segments */
export function encodeSandboxRuntimePath(runtimePath: string): string | null {
  const segments = runtimePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

/** Extract the token from a bearer authorization string or return null if invalid or missing */
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

/** Resolve and decode a bearer token from a comma-separated subprotocol string or return null */
export function bearerSubprotocolToken(value: string | null): string | null {
  if (!value) return null
  for (const part of value.split(',')) {
    const protocol = part.trim()
    if (!protocol.toLowerCase().startsWith(BEARER_SUBPROTOCOL_PREFIX)) continue
    const encoded = protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length)
    if (!encoded) return null
    try {
      const token = base64UrlDecodeText(encoded).trim()
      return token || null
    } catch {
      return null
    }
  }
  return null
}

/** Resolve the terminal token from request headers using Authorization or Sec-WebSocket-Protocol fields */
export function terminalTokenFromRequest(headers: Headers): string | null {
  return bearerToken(headers.get('Authorization')) ?? bearerSubprotocolToken(headers.get('Sec-WebSocket-Protocol'))
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function stripBearerSubprotocol(headers: Headers): void {
  const value = headers.get('Sec-WebSocket-Protocol')
  if (!value) return
  const protocols = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith(BEARER_SUBPROTOCOL_PREFIX))
  if (protocols.length) {
    headers.set('Sec-WebSocket-Protocol', protocols.join(', '))
  } else {
    headers.delete('Sec-WebSocket-Protocol')
  }
}

function validateTerminalSubject(subject: SandboxTerminalTokenSubject): void {
  if (!subject.userId) throw new Error('userId is required')
  if (!subject.workspaceId) throw new Error('workspaceId is required')
  if (!subject.sandboxId) throw new Error('sandboxId is required')
}
