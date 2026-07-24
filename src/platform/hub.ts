/**
 * Integrations-hub proxy routes: the app-side surface that forwards an
 * authenticated user's requests to the platform's `/v1/integrations/*` API
 * using their stored platform key. Auth, key lookup, and the wire client are
 * structural seams (`HubProxyContext`); error detection is by name + shape so
 * it survives bundlers duplicating module instances.
 */

import {
  resolveTangleDevOrUserKey,
  type TangleExecutionEnvironment,
  type TangleExecutionKeySource,
} from '../runtime/model'

/** Hub bearer provenance mirrors the execution-key source union. */
export type TangleHubBearerSource = TangleExecutionKeySource

/** Represent a resolved bearer token with its associated TangleHub bearer source */
export interface ResolvedTangleHubBearer {
  bearer: string
  source: TangleHubBearerSource
}

/** Resolve options required to obtain a user's TangleHub bearer token including environment and API key retrieval */
export interface ResolveUserTangleHubBearerOptions {
  userId: string
  /** Deployment context. Only local development may use env credentials. */
  environment?: TangleExecutionEnvironment
  /** Env to read for the local-development bearer. */
  env?: Record<string, string | undefined>
  /** App-owned lookup for the caller's linked platform API key. */
  getUserApiKey: () => string | null | undefined | Promise<string | null | undefined>
}

/** Resolve options for retrieving a TangleHub bearer token for a specified user */
export interface ResolveUserTangleHubBearerForUserOptions<UserId = string> {
  userId: UserId
  environment?: TangleExecutionEnvironment
  env?: Record<string, string | undefined>
  getUserApiKey: (userId: UserId) => string | null | undefined | Promise<string | null | undefined>
}

/** Represent missing Tangle platform link error for a specified user ID */
export class TangleBearerMissingError extends Error {
  constructor(readonly userId: string) {
    super(`No Tangle platform link for user ${userId}`)
    this.name = 'TangleBearerMissingError'
  }
}

/**
 * Resolve the Tangle bearer used by the integration hub proxy.
 *
 * Local development may use a server env key so apps can exercise the hub
 * without completing cross-site SSO. Deployed contexts must use the caller's
 * linked platform key; this keeps integration ownership aligned with the user.
 */
export async function resolveUserTangleHubBearer(
  opts: ResolveUserTangleHubBearerOptions,
): Promise<ResolvedTangleHubBearer> {
  const resolved = await resolveTangleDevOrUserKey({
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: opts.getUserApiKey,
  })
  if (resolved) return { bearer: resolved.apiKey, source: resolved.source }

  throw new TangleBearerMissingError(opts.userId)
}

/** Resolve the TangleHub bearer token for a specified user based on provided options */
export async function resolveUserTangleHubBearerForUser<UserId = string>(
  opts: ResolveUserTangleHubBearerForUserOptions<UserId>,
): Promise<ResolvedTangleHubBearer> {
  return resolveUserTangleHubBearer({
    userId: String(opts.userId),
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: () => opts.getUserApiKey(opts.userId),
  })
}

/** Structural guard (name + userId shape) — robust when the error class is
 *  constructed in a different module instance than the one checking it. */
export function isTangleBearerMissingError(error: unknown): error is TangleBearerMissingError {
  return (
    error instanceof Error &&
    error.name === 'TangleBearerMissingError' &&
    typeof (error as { userId?: unknown }).userId === 'string'
  )
}

/** Structural detection of the platform hub wire error (name + numeric status). */
export function isPlatformHubErrorLike(error: unknown): error is Error & { status: number; code?: string } {
  return (
    error instanceof Error &&
    error.name === 'PlatformHubError' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

/** Structural subset of the platform hub wire client — extra methods are fine. */
export interface HubClientLike {
  catalog(): Promise<unknown>
  listConnections(): Promise<unknown>
  revokeConnection(connectionId: string): Promise<unknown>
  startAuth(input: {
    providerId: string
    connectorId: string
    returnUrl: string
    requestedScopes?: string[]
  }): Promise<{ authorizationUrl: string; state: string }>
  listHealthchecks(): Promise<unknown>
}

/** Define methods to require user ID, get bearer token, and create a hub client bound to the bearer */
export interface HubProxyContext {
  /** Resolve the authenticated user id. Throw the app's own auth Response /
   *  redirect to reject — it propagates untouched. */
  requireUserId(request: Request): Promise<string>
  /** The user's platform bearer; throw `TangleBearerMissingError` when unlinked. */
  getBearer(userId: string): Promise<string>
  /** A hub client bound to the bearer. */
  createHubClient(bearer: string): HubClientLike
}

/** Define arguments for configuring a proxy route with request and optional parameters */
export interface HubProxyRouteArgs {
  request: Request
  params?: Record<string, string | undefined>
}

/** Define routes for hub proxy handling catalog, connections, healthchecks, and authorization actions */
export interface HubProxyRoutes {
  /** GET → `{ catalog }`. */
  catalog(args: HubProxyRouteArgs): Promise<Response>
  /** GET → `{ connections }`. */
  connections(args: HubProxyRouteArgs): Promise<Response>
  /** DELETE → the platform revocation result verbatim; 405 otherwise. */
  connectionDelete(args: { request: Request; params: { connectionId: string } }): Promise<Response>
  /** GET → `{ healthchecks }`. */
  healthchecks(args: HubProxyRouteArgs): Promise<Response>
  /** POST `{ providerId, connectorId, returnUrl, requestedScopes? }` →
   *  `{ authorizationUrl, state }`; 405 non-POST; 400 on bad JSON / missing fields. */
  authStart(args: HubProxyRouteArgs): Promise<Response>
}

interface StartAuthBody {
  providerId?: string
  connectorId?: string
  returnUrl?: string
  requestedScopes?: string[]
}

/** Resolve hub proxy routes with authentication and error handling based on the given context */
export function createHubProxyRoutes(ctx: HubProxyContext): HubProxyRoutes {
  /** Auth runs OUTSIDE the proxy try/catch so the app's auth throw (redirect
   *  Response etc.) is never swallowed; bearer + platform errors are mapped. */
  async function proxy(request: Request, call: (hub: HubClientLike) => Promise<Response>): Promise<Response> {
    const userId = await ctx.requireUserId(request)
    try {
      const bearer = await ctx.getBearer(userId)
      return await call(ctx.createHubClient(bearer))
    } catch (err) {
      if (isTangleBearerMissingError(err)) {
        return Response.json({ error: 'tangle_link_required' }, { status: 412 })
      }
      if (isPlatformHubErrorLike(err)) {
        return Response.json({ error: err.message, code: err.code }, { status: err.status })
      }
      throw err
    }
  }

  return {
    catalog: ({ request }) => proxy(request, async (hub) => Response.json({ catalog: await hub.catalog() })),

    connections: ({ request }) =>
      proxy(request, async (hub) => Response.json({ connections: await hub.listConnections() })),

    connectionDelete: async ({ request, params }) => {
      if (request.method !== 'DELETE') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 })
      }
      return proxy(request, async (hub) => Response.json(await hub.revokeConnection(params.connectionId)))
    },

    healthchecks: ({ request }) =>
      proxy(request, async (hub) => Response.json({ healthchecks: await hub.listHealthchecks() })),

    authStart: async ({ request }) => {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 })
      }
      const userId = await ctx.requireUserId(request)
      let body: StartAuthBody
      try {
        body = (await request.json()) as StartAuthBody
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
      if (!body.providerId || !body.connectorId || !body.returnUrl) {
        return Response.json({ error: 'providerId, connectorId, and returnUrl are required' }, { status: 400 })
      }
      try {
        const bearer = await ctx.getBearer(userId)
        const result = await ctx.createHubClient(bearer).startAuth({
          providerId: body.providerId,
          connectorId: body.connectorId,
          returnUrl: body.returnUrl,
          requestedScopes: body.requestedScopes,
        })
        return Response.json({ authorizationUrl: result.authorizationUrl, state: result.state })
      } catch (err) {
        if (isTangleBearerMissingError(err)) {
          return Response.json({ error: 'tangle_link_required' }, { status: 412 })
        }
        if (isPlatformHubErrorLike(err)) {
          return Response.json({ error: err.message, code: err.code }, { status: err.status })
        }
        throw err
      }
    },
  }
}
