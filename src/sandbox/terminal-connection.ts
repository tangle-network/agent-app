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
 * This factory mirrors legal-agent's production route
 * (`src/routes/api.sandbox.connection.ts` + `src/lib/.server/user-sandbox.ts`)
 * byte-for-byte in status codes and response shape, generalized behind two
 * product seams (`requireUser`, `ensureSandbox`) so every app composes the
 * same mechanism instead of re-deriving it.
 *
 * SECURITY POSTURE: unlike the read-only session-gateway streaming token
 * (`box.mintScopedToken({scope:'session'})` paired with
 * `SessionGatewayClient`), the token this route mints grants **command
 * execution** in the sandbox once handed to `TerminalView`. Its safety rests
 * entirely on two load-bearing parameters this factory keeps caller-supplied
 * rather than baking in: a **short TTL** (default 15 minutes, the SDK's own
 * max) and a **narrow scope** — every scope is minted FROM the one box
 * `ensureSandbox` resolved for THIS user (even the default `'project'` scope
 * is that box's, never a fleet-wide credential), and the session scopes
 * narrow further to a single session. Widening either default without an
 * explicit reason is a security regression, not a convenience.
 *
 * Wire contract: the browser passes the response's `sidecarUrl` as
 * `TerminalView`'s `apiUrl` and `token` as its token prop; sandbox-ui sends
 * the token as a `bearer.<base64url>` WebSocket subprotocol (browsers cannot
 * set `Authorization` on a WS handshake). `useSandboxTerminalConnection`
 * (`../web-react/sandbox-terminal`) is transport-agnostic and already resolves
 * `runtimeUrl ?? sidecarUrl` — this route returns `sidecarUrl` only, and the
 * hook's fallback picks it up with no hook change required.
 *
 * Default `scope: 'project'` + `ttlMinutes: 15` matches legal-agent's shipped
 * production route.
 */

/** The structural surface this route needs from an SDK sandbox box — no `@tangle-network/sandbox` class import (invariant 3). */
export interface TerminalConnectionBoxLike {
  id: string
  status?: string
  connection?: { runtimeUrl?: string }
  mintScopedToken(opts: {
    scope: string
    sessionId?: string
    runtimeSessionId?: string
    ttlMinutes?: number
  }): Promise<{ token: string; expiresAt: Date }>
}

/** The `box.mintScopedToken` scope this route requests. See the SDK's `ScopedTokenScope`. */
export type SandboxTerminalConnectionScope = 'project' | 'session' | 'session-runtime' | 'read-only'

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
  /** `box.mintScopedToken` scope. Default `'project'` (legal-agent production). */
  scope?: SandboxTerminalConnectionScope
  /** `box.mintScopedToken` TTL in minutes. Default `15` (legal-agent production; the SDK's own max). */
  ttlMinutes?: number
  /**
   * Required when `scope` is `'session'` or `'session-runtime'` — validated at
   * FACTORY-CREATION time (fail loud on a deterministic config error rather
   * than minting an overly broad token silently at request time). May be a
   * literal or a `(user, box) => string` resolved per request; a callback
   * that resolves to an empty value fails the request with a 500, never a
   * silent fallback to a broader scope.
   */
  sessionId?: string | ((user: TUser, box: TBox) => string)
  /**
   * Required when `scope` is `'session'` — same fail-loud contract as
   * {@link SandboxTerminalConnectionRouteOptions.sessionId}.
   */
  runtimeSessionId?: string | ((user: TUser, box: TBox) => string)
}

const DEFAULT_SCOPE: SandboxTerminalConnectionScope = 'project'
const DEFAULT_TTL_MINUTES = 15

/**
 * Build the browser-direct terminal connection route: `GET` handler that
 * authenticates, resolves the sandbox, mints a scoped token, and returns
 * exactly what the browser needs to connect `TerminalView` directly to the
 * sidecar — no worker in the data path once the terminal is open.
 *
 * Response shapes, matching legal-agent's production route exactly:
 * - `requireUser` returns a `Response` → that `Response`, verbatim.
 * - `ensureSandbox` throws → `500 {error}` (the thrown message surfaced).
 * - `box.connection?.runtimeUrl` missing → `503 {error, status: box.status}`.
 * - `box.mintScopedToken` rejects → `503 {error}`.
 * - success → `200 {sidecarUrl, token, expiresAt, status, sandboxId}`.
 *
 * Throws IMMEDIATELY (at factory-creation time, not per-request) when a
 * session-shaped scope is configured without the session id(s) it requires —
 * a deterministic config error must never degrade into a silently broader
 * token at runtime.
 */
export function createSandboxTerminalConnectionRoute<TBox extends TerminalConnectionBoxLike, TUser>(
  opts: SandboxTerminalConnectionRouteOptions<TBox, TUser>,
): (request: Request) => Promise<Response> {
  const scope = opts.scope ?? DEFAULT_SCOPE
  if ((scope === 'session' || scope === 'session-runtime') && opts.sessionId === undefined) {
    throw new Error(
      `createSandboxTerminalConnectionRoute: scope '${scope}' requires a 'sessionId' option`,
    )
  }
  if (scope === 'session' && opts.runtimeSessionId === undefined) {
    throw new Error(
      "createSandboxTerminalConnectionRoute: scope 'session' requires a 'runtimeSessionId' option",
    )
  }

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

    let sessionId: string | undefined
    if (opts.sessionId !== undefined) {
      sessionId = typeof opts.sessionId === 'function' ? opts.sessionId(user, box) : opts.sessionId
      if (!sessionId) {
        return Response.json({ error: 'sessionId resolved to an empty value' }, { status: 500 })
      }
    }

    let runtimeSessionId: string | undefined
    if (opts.runtimeSessionId !== undefined) {
      runtimeSessionId = typeof opts.runtimeSessionId === 'function' ? opts.runtimeSessionId(user, box) : opts.runtimeSessionId
      if (!runtimeSessionId) {
        return Response.json({ error: 'runtimeSessionId resolved to an empty value' }, { status: 500 })
      }
    }

    let scoped: { token: string; expiresAt: Date }
    try {
      scoped = await box.mintScopedToken({
        scope,
        ttlMinutes: opts.ttlMinutes ?? DEFAULT_TTL_MINUTES,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
      })
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to mint sandbox token' },
        { status: 503 },
      )
    }

    return Response.json({
      sidecarUrl: runtimeUrl,
      token: scoped.token,
      expiresAt: scoped.expiresAt.toISOString(),
      status: box.status,
      sandboxId: box.id,
    })
  }
}
