import { base64UrlDecodeText } from '../crypto/web-token'
import {
  mintTerminalProxyToken,
  verifyTerminalProxyToken,
  type TerminalProxyIdentity,
} from './terminal-proxy-token'

/**
 * The same-origin PROXY terminal transport: connection handler -> HMAC proxy
 * token -> runtime proxy -> WebSocket upgrade relay, with a worker in the
 * data path for every terminal byte. Epic #343 / decision #341 moved the
 * fleet default to the browser-direct scoped-token transport in
 * `./terminal-connection.ts` — the product's server authenticates +
 * provisions once, mints an SDK scoped token, and the browser connects
 * `TerminalView` straight to the sidecar with no worker relay. Nothing here
 * is removed (three apps still import this seam); retirement is tracked in
 * #350 and removal is a major.
 *
 * KEPT / DEPRECATED split in this file:
 *
 * | export                                        | status                              |
 * | ---------------------------------------------- | ----------------------------------- |
 * | `createWorkspaceSandboxManager` + friends      | KEPT — generic box lifecycle, used by both transports |
 * | `WorkspaceSandboxInstanceLike`                 | KEPT — same reason                  |
 * | `createWorkspaceSandboxConnectionHandler`      | `@deprecated` — proxy connection route |
 * | `createWorkspaceSandboxRuntimeProxyHandler`    | `@deprecated` — proxy runtime relay |
 * | `createWorkspaceSandboxTerminalUpgradeHandler` | `@deprecated` — proxy WS upgrade relay |
 * | `createSandboxTerminalToken` / `verifySandboxTerminalToken` | `@deprecated` — proxy HMAC token |
 * | every other exported helper below              | `@deprecated` — exists only to serve the proxy relay |
 */

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

/**
 * Define options for generating a sandbox terminal token including secret and expiration settings
 *
 * @deprecated Options for the same-origin proxy terminal transport's HMAC
 * token, superseded by the browser-direct scoped-token transport — build the
 * route with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface SandboxTerminalTokenOptions {
  secret?: string
  expiresInMs?: number
  now?: () => number
}

/**
 * Resolve the identity type used for sandbox terminal token subjects
 *
 * @deprecated Identity alias for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export type SandboxTerminalTokenSubject = TerminalProxyIdentity

/**
 * Provide token and expiration details for a sandbox terminal session
 *
 * @deprecated Result shape for the same-origin proxy terminal transport's
 * HMAC token, superseded by the browser-direct scoped-token transport —
 * build the route with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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

/**
 * Generate a sandbox terminal token for a given subject with specified options
 *
 * @deprecated Mints a token for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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

/**
 * Verify the validity of a sandbox terminal token against the expected identity and options
 *
 * @deprecated Verifies a token for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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

/**
 * Represent an authenticated user within a sandbox environment with a unique identifier
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface AuthenticatedSandboxUser {
  id: string
}

/**
 * Define options to handle workspace sandbox connections with user authentication and access control
 *
 * @deprecated Options for the same-origin proxy terminal connection handler,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface WorkspaceSandboxConnectionHandlerOptions<TBox extends WorkspaceSandboxInstanceLike> {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string }) => Promise<void>
  ensureWorkspaceSandbox: (workspaceId: string, userId: string) => Promise<TBox>
  tokenSecret: string | (() => string | undefined)
  tokenExpiresInMs?: number
  proxyRuntimeUrl?: (args: { request: Request; workspaceId: string; sandboxId: string; box: TBox }) => string
  exposeDirectSidecar?: boolean
}

/**
 * Define arguments required to establish a workspace sandbox connection
 *
 * @deprecated Argument shape for the same-origin proxy terminal connection
 * handler, superseded by the browser-direct scoped-token transport — build
 * the route with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface WorkspaceSandboxConnectionArgs {
  request: Request
  params: {
    workspaceId?: string
  }
}

/**
 * Create a handler to resolve workspace sandbox connections with user and access validation
 *
 * @deprecated The same-origin proxy terminal transport is superseded by the
 * browser-direct scoped-token transport — build the route with
 * `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
 */
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

/**
 * Define credentials required to access the sandbox API environment
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface SandboxApiCredentials {
  baseUrl: string
  apiKey: string
}

/**
 * Build the sandbox API's sidecar-proxy base for a box:
 * `{baseUrl}/v1/sidecar-proxy/{sandboxId}`.
 *
 * This is the ONLY upstream that serves the interactive terminal. Measured on
 * production (`sandbox.tangle.tools`, one box, `ws` client, same credential in
 * every arm):
 *
 * | upstream base                          | result                          |
 * |----------------------------------------|---------------------------------|
 * | `/v1/sidecar-proxy/{id}`               | 101 -> `ready` 2551ms -> shell  |
 * | `/v1/sandboxes/{id}/runtime/`          | HTTP 500                        |
 * | `connection.runtimeUrl` (the box host) | 101 then close 1000, 0 bytes    |
 *
 * The box's own `connection.runtimeUrl` (`https://sandbox-*.tangle.sh`) accepts
 * the upgrade — its Caddy front end upgrades every path, including ones that do
 * not exist — and then hangs up without a PTY. A 101 from that host therefore
 * proves nothing; only a `ready` control frame does. Two products shipped a
 * terminal against it and rendered a permanent spinner.
 *
 * Exported so no product writes the path literal a fourth time.
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function sandboxSidecarProxyUrl(baseUrl: string, sandboxId: string): string {
  if (!baseUrl) throw new Error('baseUrl is required')
  if (!sandboxId) throw new Error('sandboxId is required')
  return new URL(`/v1/sidecar-proxy/${encodeURIComponent(sandboxId)}`, baseUrl).toString().replace(/\/+$/, '')
}

/**
 * Define a connection configuration for sandbox runtime including URL and optional server-side auth token
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface SandboxRuntimeConnection {
  runtimeUrl: string
  /** Server-side sidecar bearer. Must authorize terminal routes; never expose it to browser code. */
  authToken?: string
}

/**
 * Define options for handling workspace sandbox runtime proxy including user, access, credentials, and connection retrieval
 *
 * @deprecated Options for the same-origin proxy terminal runtime relay,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface WorkspaceSandboxRuntimeProxyHandlerOptions {
  requireUser: (request: Request) => Promise<AuthenticatedSandboxUser>
  requireWorkspaceAccess: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<void>
  getSandboxApiCredentials: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxApiCredentials>
  getSandboxRuntimeConnection?: (args: { request: Request; userId: string; workspaceId: string; sandboxId: string }) => Promise<SandboxRuntimeConnection | null | undefined>
  tokenSecret: string | (() => string | undefined)
  fetch?: typeof fetch
  forwardHeaders?: string[]
}

/**
 * Define arguments for proxying runtime requests within a workspace sandbox environment
 *
 * @deprecated Argument shape for the same-origin proxy terminal runtime
 * relay, superseded by the browser-direct scoped-token transport — build the
 * route with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface WorkspaceSandboxRuntimeProxyArgs {
  request: Request
  params: {
    workspaceId?: string
    sandboxId?: string
    '*'?: string
  }
}

/**
 * Create a proxy handler to resolve sandbox runtime requests with user and workspace access validation
 *
 * @deprecated The same-origin proxy terminal transport is superseded by the
 * browser-direct scoped-token transport — build the route with
 * `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
 */
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
      : new URL(encodedRuntimePath, `${sandboxSidecarProxyUrl(credentials!.baseUrl, sandboxId)}/`)
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

/**
 * Define the structure for matching a sandbox terminal WebSocket with workspace and path details
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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
 *
 * @deprecated Parses a path for the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
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

/**
 * True when `request` is a WebSocket upgrade for a sandbox terminal path.
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function isSandboxTerminalWsUpgrade(request: Request): boolean {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return false
  try {
    return matchSandboxTerminalWsPath(new URL(request.url).pathname) !== null
  } catch {
    return false
  }
}

/**
 * Define options to handle user authentication, workspace access, and sandbox API credential retrieval
 *
 * @deprecated Options for the same-origin proxy terminal WS upgrade relay,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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
 *
 * @deprecated The same-origin proxy terminal transport is superseded by the
 * browser-direct scoped-token transport — build the route with
 * `createSandboxTerminalConnectionRoute` (`src/sandbox/terminal-connection.ts`)
 * instead. Three apps still import this seam; retirement is tracked in #350
 * and removal is a major.
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
      : new URL(subPath, `${sandboxSidecarProxyUrl(credentials!.baseUrl, sandboxId)}/`)
    upstreamUrl.search = url.search

    // Forward the upgrade verbatim — keep the Upgrade/Connection + Sec-WebSocket-*
    // headers the handshake needs, but strip the browser-only bearer subprotocol
    // and send the server-to-server sandbox credential only as Authorization.
    // Returning the upstream 101 passes the live socket straight through to the browser.
    const upstreamHeaders = new Headers(request.headers)
    const upstreamBearer = directRuntimeConnection?.authToken ?? credentials!.apiKey
    upstreamHeaders.set('Authorization', `Bearer ${upstreamBearer}`)
    upstreamHeaders.delete('host')
    const browserProtocol = selectedBearerSubprotocol(request.headers.get('Sec-WebSocket-Protocol'))
    stripBearerSubprotocol(upstreamHeaders)
    const fetchImpl = opts.fetch ?? fetch
    const upstream = await fetchImpl(upstreamUrl.toString(), { method: request.method, headers: upstreamHeaders })

    const echo = terminalUpgradeSubprotocolEcho(upstream, browserProtocol)
    if (!echo) return upstream
    // Only reachable on a WebSocket-capable runtime: Cloudflare Workers is the
    // one place a 101 Response can be constructed, and only while carrying the
    // live socket. Dropping `webSocket` here would hand the browser a dead 101 —
    // and on Node the construction throws outright, which is exactly the
    // "status codes in the range 200 to 599" 500 the old upstream returned.
    return new Response(null, {
      status: echo.status,
      statusText: echo.statusText,
      headers: echo.headers,
      webSocket: (upstream as Response & { webSocket?: WebSocket | null }).webSocket ?? null,
    } as ResponseInit)
  }
}

/**
 * A response-like shape carrying just what the subprotocol echo decision reads.
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export interface TerminalUpgradeResponseLike {
  status: number
  statusText?: string
  headers: Headers
}

/**
 * Decide whether a terminal upgrade's 101 needs the browser's own subprotocol
 * echoed back onto it, and return the headers to answer with. `null` means
 * "pass the upstream response through untouched".
 *
 * Why this exists: the browser's terminal credential rides in a
 * `bearer.<base64url>` WebSocket subprotocol, because a browser cannot set
 * `Authorization` on a WS handshake. That subprotocol is a browser-to-Worker
 * credential, so it is stripped before the upstream hop — and the upstream then
 * answers the 101 selecting nothing. A browser MUST fail the connection when a
 * 101 selects no subprotocol after it offered one (RFC 6455 s4.1), so the socket
 * dies on open and the terminal renders a spinner forever.
 *
 * Kept as a pure function because a 101 `Response` cannot be constructed off
 * Workers, so this is the only part of the decision a test can drive directly.
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function terminalUpgradeSubprotocolEcho(
  upstream: TerminalUpgradeResponseLike,
  browserProtocol: string | null,
): { status: number; statusText: string; headers: Headers } | null {
  if (upstream.status !== 101 || !browserProtocol) return null
  // The upstream's own selection is authoritative; overwriting it would tell the
  // browser a protocol was agreed that the server never agreed to.
  if (upstream.headers.has('Sec-WebSocket-Protocol')) return null
  const headers = new Headers(upstream.headers)
  headers.set('Sec-WebSocket-Protocol', browserProtocol)
  return { status: upstream.status, statusText: upstream.statusText ?? '', headers }
}

/**
 * The exact `bearer.*` subprotocol string the browser offered, so it can be
 * echoed verbatim on the 101. Returns null when the browser offered none.
 *
 * Takes the raw `Sec-WebSocket-Protocol` value rather than the `Headers`, to
 * match its siblings `bearerSubprotocolToken` and `stripBearerSubprotocol` —
 * one shape for the whole family, and the caller reads the header once.
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function selectedBearerSubprotocol(value: string | null): string | null {
  if (!value) return null
  for (const part of value.split(',')) {
    const protocol = part.trim()
    if (protocol.toLowerCase().startsWith(BEARER_SUBPROTOCOL_PREFIX)) return protocol
  }
  return null
}

const DEFAULT_RUNTIME_PROXY_HEADERS = ['accept', 'content-type', 'last-event-id', 'x-session-id']

/**
 * Build proxy headers for sandbox runtime including authorization and forwarded headers
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function buildSandboxRuntimeProxyHeaders(source: Headers, sandboxApiKey: string, forwardHeaders = DEFAULT_RUNTIME_PROXY_HEADERS): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${sandboxApiKey}`)
  for (const name of forwardHeaders) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/**
 * Encode a runtime path by URI-encoding each valid segment and returning null for invalid segments
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
export function encodeSandboxRuntimePath(runtimePath: string): string | null {
  const segments = runtimePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

/**
 * Extract the token from a bearer authorization string or return null if invalid or missing
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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

/**
 * Resolve and decode a bearer token from a comma-separated subprotocol string or return null
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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

/**
 * Resolve the terminal token from request headers using Authorization or Sec-WebSocket-Protocol fields
 *
 * @deprecated Exists only to serve the same-origin proxy terminal transport,
 * superseded by the browser-direct scoped-token transport — build the route
 * with `createSandboxTerminalConnectionRoute`
 * (`src/sandbox/terminal-connection.ts`) instead. Three apps still import
 * this seam; retirement is tracked in #350 and removal is a major.
 */
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
