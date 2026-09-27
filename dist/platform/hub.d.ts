/**
 * Integrations-hub proxy routes: the app-side surface that forwards an
 * authenticated user's requests to the platform's `/v1/integrations/*` API
 * using their stored platform key. Auth, key lookup, and the wire client are
 * structural seams (`HubProxyContext`); error detection is by name + shape so
 * it survives bundlers duplicating module instances.
 */
import { type TangleExecutionEnvironment, type TangleExecutionKeySource } from '../runtime/model';
/** Hub bearer provenance mirrors the execution-key source union. */
export type TangleHubBearerSource = TangleExecutionKeySource;
/** Represent a resolved bearer token with its associated TangleHub bearer source */
export interface ResolvedTangleHubBearer {
    bearer: string;
    source: TangleHubBearerSource;
}
/** Resolve options required to obtain a user's TangleHub bearer token including environment and API key retrieval */
export interface ResolveUserTangleHubBearerOptions {
    userId: string;
    /** Deployment context. Only local development may use env credentials. */
    environment?: TangleExecutionEnvironment;
    /** Env to read for the local-development bearer. */
    env?: Record<string, string | undefined>;
    /** App-owned lookup for the caller's linked platform API key. */
    getUserApiKey: () => string | null | undefined | Promise<string | null | undefined>;
}
/** Resolve options for retrieving a TangleHub bearer token for a specified user */
export interface ResolveUserTangleHubBearerForUserOptions<UserId = string> {
    userId: UserId;
    environment?: TangleExecutionEnvironment;
    env?: Record<string, string | undefined>;
    getUserApiKey: (userId: UserId) => string | null | undefined | Promise<string | null | undefined>;
}
/** Represent missing Tangle platform link error for a specified user ID */
export declare class TangleBearerMissingError extends Error {
    readonly userId: string;
    constructor(userId: string);
}
/**
 * Resolve the Tangle bearer used by the integration hub proxy.
 *
 * Local development may use a server env key so apps can exercise the hub
 * without completing cross-site SSO. Deployed contexts must use the caller's
 * linked platform key; this keeps integration ownership aligned with the user.
 */
export declare function resolveUserTangleHubBearer(opts: ResolveUserTangleHubBearerOptions): Promise<ResolvedTangleHubBearer>;
/** Resolve the TangleHub bearer token for a specified user based on provided options */
export declare function resolveUserTangleHubBearerForUser<UserId = string>(opts: ResolveUserTangleHubBearerForUserOptions<UserId>): Promise<ResolvedTangleHubBearer>;
/** Structural guard (name + userId shape) — robust when the error class is
 *  constructed in a different module instance than the one checking it. */
export declare function isTangleBearerMissingError(error: unknown): error is TangleBearerMissingError;
/** Structural detection of the platform hub wire error (name + numeric status). */
export declare function isPlatformHubErrorLike(error: unknown): error is Error & {
    status: number;
    code?: string;
};
/** Structural subset of the platform hub wire client — extra methods are fine. */
export interface HubClientLike {
    catalog(): Promise<unknown>;
    listConnections(): Promise<unknown>;
    revokeConnection(connectionId: string): Promise<unknown>;
    startAuth(input: {
        providerId: string;
        connectorId: string;
        returnUrl: string;
        requestedScopes?: string[];
    }): Promise<{
        authorizationUrl: string;
        state: string;
    }>;
    listHealthchecks(): Promise<unknown>;
}
/** Define methods to require user ID, get bearer token, and create a hub client bound to the bearer */
export interface HubProxyContext {
    /** Resolve the authenticated user id. Throw the app's own auth Response /
     *  redirect to reject — it propagates untouched. */
    requireUserId(request: Request): Promise<string>;
    /** The user's platform bearer; throw `TangleBearerMissingError` when unlinked. */
    getBearer(userId: string): Promise<string>;
    /** A hub client bound to the bearer. */
    createHubClient(bearer: string): HubClientLike;
}
/** Define arguments for configuring a proxy route with request and optional parameters */
export interface HubProxyRouteArgs {
    request: Request;
    params?: Record<string, string | undefined>;
}
/** Define routes for hub proxy handling catalog, connections, healthchecks, and authorization actions */
export interface HubProxyRoutes {
    /** GET → `{ catalog }`. */
    catalog(args: HubProxyRouteArgs): Promise<Response>;
    /** GET → `{ connections }`. */
    connections(args: HubProxyRouteArgs): Promise<Response>;
    /** DELETE → the platform revocation result verbatim; 405 otherwise. */
    connectionDelete(args: {
        request: Request;
        params: {
            connectionId: string;
        };
    }): Promise<Response>;
    /** GET → `{ healthchecks }`. */
    healthchecks(args: HubProxyRouteArgs): Promise<Response>;
    /** POST `{ providerId, connectorId, returnUrl, requestedScopes? }` →
     *  `{ authorizationUrl, state }`; 405 non-POST; 400 on bad JSON / missing fields. */
    authStart(args: HubProxyRouteArgs): Promise<Response>;
}
/** Resolve hub proxy routes with authentication and error handling based on the given context */
export declare function createHubProxyRoutes(ctx: HubProxyContext): HubProxyRoutes;
