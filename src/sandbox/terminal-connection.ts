/**
 * Browser-direct scoped-token terminal connection route (#341/#349).
 *
 * Epic #343 / decision #341: the fleet's terminal transport is browser-direct
 * — the product's server authenticates the request and provisions/resolves
 * the sandbox exactly once, mints a short-lived SDK scoped token
 * (`box.mintScopedToken`), and hands the browser just enough to connect
 * `TerminalView` straight to the sidecar. No worker relays terminal bytes for
 * this shape — that is the proxy transport in `./workspace-terminal` +
 * `./terminal-proxy-token`, now `@deprecated` in favor of this one
 * (retirement tracked in #350; nothing removed, three apps still import it).
 *
 * VERIFIED PLATFORM CONTRACT (`@tangle-network/sandbox` 0.15.2 + the
 * orchestrator/sidecar enforcement source, verified 2026-07-30):
 *
 * 1. Only a `scope: 'session-runtime'` token carries the `terminal`
 *    capability (`cap: ["read", "workspace", "terminal"]`). `'project'` and
 *    `'session'` mint SessionGateway READ tokens (HS256, `typ: "read"`, no
 *    `cap` claim at all — a different token family the sidecar rejects
 *    outright); `'read-only'` carries `cap: ["read"]` only. **No scope other
 *    than `'session-runtime'` can ever open a terminal**, which is why this
 *    route no longer takes `scope` as a parameter — it is pinned.
 * 2. The orchestrator's terminal WS gate fails closed unless the token's
 *    `sid` claim EQUALS the `<connectionId>` path segment of
 *    `/terminals/<connectionId>/ws`
 *    (`verifyScopedSidecarCapability(sidecar, token, "terminal", connectionId)`).
 *    So `mintScopedToken({ scope: 'session-runtime', sessionId })` MUST be
 *    called with `sessionId === connectionId` — the exact id `TerminalView`
 *    will dial. That is why this route threads a `connectionId` end to end
 *    instead of deriving its own session id.
 * 3. The browser-safe terminal base is the mint result's `sidecarProxyUrl`
 *    (`/v1/sidecar-proxy/{id}` on the Sandbox API) — **not**
 *    `box.connection.runtimeUrl`. The SDK's own `_attachTerminal` is the
 *    reference implementation:
 *    `mintScopedToken({ scope: 'session-runtime', sessionId: connectionId })`
 *    then dial `${scoped.sidecarProxyUrl}/terminals/${connectionId}/ws`.
 *    Pointing `TerminalView` at `runtimeUrl` fails auth regardless of scope —
 *    only the sidecar-proxy hop decodes the browser's
 *    `bearer.<base64url>` WS subprotocol.
 *
 * HISTORICAL NOTE: an earlier shape of this route (and legal-agent's
 * production route it was modeled on, `scope: 'project'` +
 * `connection.runtimeUrl`) predates the platform's terminal-auth hardening —
 * the terminal capability gate (2026-06-19), the scoped-token terminal WS
 * path (2026-07-15), and the `sid`-binding fail-closed check
 * (2026-07-17/18). That shape does not authenticate on the current platform
 * and is not a valid spec for the token path anymore.
 *
 * SECURITY POSTURE: unlike the read-only session-gateway streaming token
 * (`box.mintScopedToken({scope:'session'})` paired with
 * `SessionGatewayClient`), the token this route mints grants **command
 * execution** in the sandbox once handed to `TerminalView`. Its safety rests
 * on a **short TTL** (default 15 minutes, the SDK's own max — still a caller
 * parameter) and, structurally, the narrowest scope the platform offers: one
 * box (`ensureSandbox` resolved it for THIS user), one terminal connection
 * (`session-runtime` bound to a single `sid`). Widening the TTL default
 * without an explicit reason is a security regression, not a convenience.
 *
 * Wire contract: the browser passes the response's `sidecarUrl` as
 * `TerminalView`'s `apiUrl` prop, `token` as its token prop, and the
 * response's echoed `connectionId` as `TerminalView`'s `connectionId` prop —
 * the token's `sid` is bound to exactly that id, so any other value fails the
 * WS upgrade. sandbox-ui sends the token as a `bearer.<base64url>` WebSocket
 * subprotocol (browsers cannot set `Authorization` on a WS handshake).
 * `useSandboxTerminalConnection` (`../web-react/sandbox-terminal`) carries
 * `connectionId` through automatically.
 */

/** The structural surface this route needs from an SDK sandbox box — no `@tangle-network/sandbox` class import (invariant 3). */
export interface TerminalConnectionBoxLike {
  id: string
  status?: string
  connection?: { runtimeUrl?: string }
  mintScopedToken(opts: {
    scope: string
    sessionId?: string
    ttlMinutes?: number
  }): Promise<{ token: string; expiresAt: Date; sidecarProxyUrl: string }>
}

/** Configuration for {@link createSandboxTerminalConnectionRoute}. */
export interface SandboxTerminalConnectionRouteOptions<TBox extends TerminalConnectionBoxLike, TUser> {
  /**
   * Authenticate the incoming request. Return the authenticated user, or a
   * `Response` to short-circuit the route (e.g. a 401) — that Response is
   * returned to the caller verbatim.
   */
  requireUser(request: Request): Promise<TUser | Response>
  /**
   * Resolve (provisioning if needed) the sandbox this user's terminal should
   * connect to. Domain-specific provisioning (workspace- vs user-scoped,
   * naming, reuse) stays entirely in the product's implementation of this
   * seam — the route only reacts to success/failure.
   */
  ensureSandbox(user: TUser, request: Request): Promise<TBox>
  /** `box.mintScopedToken` TTL in minutes. Default `15` (the SDK's own max). */
  ttlMinutes?: number
  /**
   * Resolve the terminal connection id the minted token's `sid` is bound to
   * — this MUST be the same id `TerminalView` dials
   * (`tabTerminalConnectionId()`), because the orchestrator's terminal WS
   * gate fails closed unless `sid === <connectionId>` in
   * `/terminals/<connectionId>/ws`.
   *
   * `requested` is `new URL(request.url).searchParams.get('connectionId')`.
   * The default resolver returns `requested` unchanged. A product may
   * validate/namespace the id here (e.g. a per-user prefix in a shared box)
   * — if it rewrites the id, the client MUST use the response's echoed
   * `connectionId`, since the sid binding makes any other id fail the WS
   * upgrade.
   *
   * A resolved falsy/empty value fails the request with a 400 before any
   * sandbox work happens.
   */
  resolveConnectionId?: (ctx: {
    request: Request
    user: TUser
    box: TBox
    requested: string | null
  }) => string | null | undefined | Promise<string | null | undefined>
}

const DEFAULT_TTL_MINUTES = 15
const TERMINAL_SCOPE = 'session-runtime'

function defaultResolveConnectionId(ctx: { requested: string | null }): string | null {
  return ctx.requested
}

/**
 * Build the browser-direct terminal connection route: `GET` handler that
 * authenticates, resolves the sandbox, mints a scoped token pinned to
 * `scope: 'session-runtime'` (the ONLY scope the platform grants the
 * `terminal` capability to), and returns exactly what the browser needs to
 * connect `TerminalView` directly to the sidecar — no worker in the data
 * path once the terminal is open.
 *
 * Response shapes:
 * - `requireUser` returns a `Response` → that `Response`, verbatim.
 * - `ensureSandbox` throws → `500 {error}` (the thrown message surfaced).
 * - `box.connection?.runtimeUrl` missing → `503 {error, status: box.status}`
 *   — this is a READINESS gate only; the URL returned to the client on
 *   success is always the mint's `sidecarProxyUrl`, never `runtimeUrl`.
 * - resolved connection id is falsy/empty → `400 {error}`.
 * - `box.mintScopedToken` rejects → `503 {error}`.
 * - success → `200 {sidecarUrl, token, expiresAt, status, sandboxId, connectionId}`.
 *   `connectionId` is the id the token's `sid` is bound to — the client MUST
 *   hand this (not its own) to `TerminalView`.
 */
export function createSandboxTerminalConnectionRoute<TBox extends TerminalConnectionBoxLike, TUser>(
  opts: SandboxTerminalConnectionRouteOptions<TBox, TUser>,
): (request: Request) => Promise<Response> {
  const resolveConnectionId = opts.resolveConnectionId ?? defaultResolveConnectionId

  return async function handleSandboxTerminalConnection(request: Request): Promise<Response> {
    const user = await opts.requireUser(request)
    if (user instanceof Response) return user

    let box: TBox
    try {
      box = await opts.ensureSandbox(user, request)
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to provision sandbox' },
        { status: 500 },
      )
    }

    const runtimeUrl = box.connection?.runtimeUrl
    if (!runtimeUrl) {
      return Response.json(
        {
          error: 'Sandbox runtime not ready. The sandbox is still initializing -- retry in a few seconds.',
          status: box.status,
        },
        { status: 503 },
      )
    }

    const requested = new URL(request.url).searchParams.get('connectionId')
    const connectionId = await resolveConnectionId({ request, user, box, requested })
    if (!connectionId) {
      return Response.json(
        {
          error:
            "connectionId is required — pass the same id TerminalView dials (tabTerminalConnectionId()) as the 'connectionId' query parameter",
        },
        { status: 400 },
      )
    }

    let scoped: { token: string; expiresAt: Date; sidecarProxyUrl: string }
    try {
      scoped = await box.mintScopedToken({
        scope: TERMINAL_SCOPE,
        ttlMinutes: opts.ttlMinutes ?? DEFAULT_TTL_MINUTES,
        sessionId: connectionId,
      })
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to mint sandbox token' },
        { status: 503 },
      )
    }

    return Response.json({
      sidecarUrl: scoped.sidecarProxyUrl,
      token: scoped.token,
      expiresAt: scoped.expiresAt.toISOString(),
      status: box.status,
      sandboxId: box.id,
      connectionId,
    })
  }
}
