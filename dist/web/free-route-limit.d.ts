/**
 * Rate-limit policy for FREE routes: authenticated, unmetered, compute-bearing
 * endpoints.
 *
 * Billing meters the chat turn. Everything deterministic a product adds beside
 * it — a planning recompute fired on every slider drag, a redline diff, a
 * deadline computation — runs unmetered, so nothing bounds how much worker CPU
 * one authenticated caller can spend. `checkRateLimit` is the primitive; this
 * is the policy around it, so a route declares a cost class instead of each one
 * inventing a key format, a budget, and a denial response.
 *
 * Three rules this enforces that a hand-rolled call site usually does not:
 *
 * 1. **Identity is required.** A missing subject is denied, never pooled into a
 *    shared bucket and never quietly keyed by IP — a shared bucket makes one
 *    heavy user throttle everyone, and an IP key makes one NAT do the same.
 * 2. **A limiter that throws denies.** KV `get`/`put` failures are transport
 *    failures; treating them as "allowed" converts a KV outage into an
 *    unbounded-compute hole, which is exactly when the limiter matters most.
 * 3. **The denial is a typed, correctable outcome** — reason, HTTP status and
 *    `Retry-After` — so the caller answers the client rather than failing
 *    opaquely or, worse, continuing.
 *
 * ```ts
 * export const action = withFreeRouteLimit(
 *   {
 *     route: 'tax.plan.recompute',
 *     costClass: 'interactive',
 *     kv: ({ context }) => context.cloudflare.env.RATE_LIMIT_KV,
 *     identify: async ({ request }) => {
 *       const session = await requireSession(request)
 *       return { subject: session.userId, workspace: session.workspaceId }
 *     },
 *   },
 *   async ({ request }) => Response.json(recompute(await request.json())),
 * )
 * ```
 */
import { type KvLike } from './rate-limit';
/** Requests allowed per identity inside a sliding window. */
export interface RateLimitBudget {
    limit: number;
    windowSeconds: number;
}
/**
 * How expensive one call is, which is what picks the default budget.
 *
 * - `interactive` — a control the user drags or types into, recomputed per
 *   tick. Sized for sustained two-per-second interaction, so a real slider
 *   never trips it and a script still stops.
 * - `compute` — a derivation the user triggers deliberately (recalculate a
 *   plan, diff a document, compute a deadline set). The default.
 * - `heavy` — whole-document or whole-matter work measured in seconds of CPU.
 */
export type FreeRouteClass = 'interactive' | 'compute' | 'heavy';
/** Default budget per cost class. A product overrides with an explicit
 *  `budget` when it has measured its own route. */
export declare const FREE_ROUTE_BUDGETS: Readonly<Record<FreeRouteClass, RateLimitBudget>>;
/** A workspace's shared ceiling defaults to this many times one member's, so a
 *  multi-seat tenant is bounded without a single active member tripping it. */
export declare const WORKSPACE_BUDGET_MULTIPLIER = 5;
/** Why a call was refused. Every value is a REFUSAL — there is no reason code
 *  that lets the handler run. */
export type FreeRouteDenialReason = 
/** No authenticated subject. Not correctable by waiting. */
'unidentified'
/** The window is full for this subject or workspace. */
 | 'rate-limited'
/** The limiter itself failed (KV read/write threw). Denied, not passed. */
 | 'limiter-unavailable';
/** Which window refused the call. `null` when no window was consulted. */
export type FreeRouteDimension = 'subject' | 'workspace' | null;
/**
 * A correctable refusal: the caller maps `status` + `retryAfterSeconds` onto a
 * response (see {@link freeRouteLimitResponse}) so the client learns what to do
 * next. Carrying the limiter's own failure in `cause` keeps a KV outage
 * diagnosable instead of collapsing into a generic 429.
 */
export declare class FreeRouteLimitError extends Error {
    readonly reason: FreeRouteDenialReason;
    readonly status: 401 | 429 | 503;
    readonly retryAfterSeconds: number;
    readonly dimension: FreeRouteDimension;
    readonly route: string;
    constructor(init: {
        reason: FreeRouteDenialReason;
        status: 401 | 429 | 503;
        retryAfterSeconds: number;
        dimension: FreeRouteDimension;
        route: string;
        message: string;
        cause?: unknown;
    });
}
/** What remains of the binding window after an allowed call. */
export interface FreeRouteAllowance {
    /** Remaining calls in whichever window is tightest. */
    remaining: number;
    /** Unix seconds at which that window resets. */
    resetAt: number;
    /** The budget that window enforces. */
    budget: RateLimitBudget;
    /** Which window is tightest — `subject` unless a workspace ceiling binds. */
    dimension: Exclude<FreeRouteDimension, null>;
}
/** Typed outcome at the route boundary: an allowance, or a refusal that says
 *  how to correct it. There is no third state and no silent pass. */
export type FreeRouteLimitOutcome = {
    succeeded: true;
    value: FreeRouteAllowance;
} | {
    succeeded: false;
    error: FreeRouteLimitError;
};
export interface FreeRouteLimitInput {
    kv: KvLike;
    /** Stable route name. Part of the key, so two routes never share a window. */
    route: string;
    /** The authenticated subject (user id). Absent or blank ⇒ denied. */
    subject: string | null | undefined;
    /** Tenant the call belongs to. When present, a second, wider window bounds
     *  the workspace as a whole. */
    workspace?: string | null;
    /** Cost class picking the default budget. Ignored when `budget` is given.
     *  Default `'compute'`. */
    costClass?: FreeRouteClass;
    budget?: RateLimitBudget;
    /** Workspace ceiling. Defaults to the subject budget's limit multiplied by
     *  {@link WORKSPACE_BUDGET_MULTIPLIER} over the same window. */
    workspaceBudget?: RateLimitBudget;
}
/**
 * Decide whether one authenticated, unmetered call may run.
 *
 * Checks the subject's window first, then the workspace ceiling when a
 * workspace is supplied; the tighter of the two is what the allowance reports.
 * Every failure path returns a refusal — none returns an allowance.
 */
export declare function checkFreeRouteLimit(input: FreeRouteLimitInput): Promise<FreeRouteLimitOutcome>;
export interface FreeRouteLimitResponseOptions {
    /** Extra response headers (a product's security headers, CORS). */
    headers?: Record<string, string>;
    /** Client-facing message. Defaults to the error's own message. */
    message?: string;
}
/** The refusal as an HTTP response: the error's status, a JSON body carrying
 *  the machine-readable `reason`, and `Retry-After` when waiting can fix it. */
export declare function freeRouteLimitResponse(error: FreeRouteLimitError, options?: FreeRouteLimitResponseOptions): Response;
/** The authenticated caller behind one request. */
export interface FreeRouteIdentity {
    subject: string;
    workspace?: string | null;
}
export interface WithFreeRouteLimitOptions<TArgs> {
    /** Stable route name; part of the key. */
    route: string;
    costClass?: FreeRouteClass;
    budget?: RateLimitBudget;
    workspaceBudget?: RateLimitBudget;
    /** The KV binding for this request. */
    kv: (args: TArgs) => KvLike;
    /**
     * Resolve the authenticated caller. Return `null` for an unauthenticated
     * request — the wrapper then refuses with 401 and the handler never runs.
     *
     * A THROW here propagates: an auth lookup that failed is not the same as an
     * absent session, and the wrapper will not invent a status for it. The
     * handler still does not run, so the failure stays closed.
     */
    identify: (args: TArgs) => Promise<FreeRouteIdentity | null> | FreeRouteIdentity | null;
    /** Build the refusal response. Defaults to {@link freeRouteLimitResponse}. */
    onDenied?: (error: FreeRouteLimitError, args: TArgs) => Response | Promise<Response>;
}
/**
 * Wrap an authenticated, unmetered, compute-bearing route handler in its
 * budget. The limit is applied BEFORE the handler is entered — including
 * before the request body is read — so a refused call costs a KV read, not the
 * compute the route exists to do.
 *
 * The handler's own response is returned untouched: this never rewrites status,
 * body or headers on the success path, so it cannot break a streaming or
 * pre-built response.
 *
 * `TArgs` is the router's handler-argument object (react-router's
 * `ActionFunctionArgs`, or any single-object shape a product uses).
 */
export declare function withFreeRouteLimit<TArgs>(options: WithFreeRouteLimitOptions<TArgs>, handler: (args: TArgs) => Response | Promise<Response>): (args: TArgs) => Promise<Response>;
