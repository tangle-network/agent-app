/**
 * Framework-neutral interaction-answer endpoints, lifted out of the per-app
 * route files (gtm `api.chat.interactions`, legal `api.chat.interactions`,
 * tax `api.sessions.$id.interactions` — three byte-similar forks):
 *
 *   list(request)   — GET: outstanding asks for a live turn (reload restore)
 *   answer(request) — POST `{ id, outcome, data? }`: resolve one ask
 *
 * The product supplies ONE seam, `resolveConnection`: authenticate the caller,
 * authorize the thread/session, and resolve the sidecar connection. Everything
 * behind the seam is mechanism the forks kept re-fixing:
 *
 *   - body validation (safe field keys, typed values),
 *   - sidecar error → client contract mapping (every "the ask is gone" shape
 *     becomes 410 so the card flips to its expired state),
 *   - duplicate resolution: after answering, every other outstanding ask with
 *     the same content signature (a re-emitted duplicate) gets the same answer,
 *   - unblock verification: re-list and fail loud (503 INTERACTION_STILL_PENDING)
 *     when the sidecar accepted the POST but the ask is still open,
 *   - best-effort list: sidecar failures return `{ interactions: [],
 *     unavailable }` so a reload restore never breaks the live stream.
 *
 * Handlers return web-standard `Response`s (Workers, Node 18+, Deno) — no
 * router import anywhere.
 */
import { type InteractionData, type InteractionRequestWire } from './contract';
import { type SidecarInteractionsConnection, type SidecarInteractionsError } from './sidecar';
/** Define possible outcomes for an interaction client as accepted or declined */
export type InteractionClientOutcome = 'accepted' | 'declined';
/** Validate interaction answer body and return success with data or failure with error message */
export type InteractionAnswerBodyValidation = {
    ok: true;
    id: string;
    outcome: InteractionClientOutcome;
    data?: InteractionData;
} | {
    ok: false;
    error: string;
};
/** Validates the client POST body: `{ id, outcome, data? }` with
 *  identifier-safe field keys and primitive/string-array values only. */
export declare function validateInteractionAnswerBody(body: Record<string, unknown>): InteractionAnswerBodyValidation;
/** Provide logging methods for warnings and errors in interaction routes */
export type InteractionRouteLogger = Pick<Console, 'warn' | 'error'>;
/** Sidecar error → the client-actionable contract. Every "the ask is gone"
 *  shape maps to 410 so the card flips to its expired state — a raw 404/409
 *  must never surface. */
export declare function mapInteractionRespondFailure(error: SidecarInteractionsError, logger?: InteractionRouteLogger): Response;
/** The product seam's verdict for one request. `response` short-circuits with
 *  a product-authored Response (401/404/429…); `unavailable` means the caller
 *  is fine but the sandbox runtime is not reachable — the factory shapes that
 *  per intent (empty list for `list`, 503 for `answer`). */
export type InteractionConnectionResolution = {
    ok: true;
    connection: SidecarInteractionsConnection;
} | {
    ok: false;
    response: Response;
} | {
    ok: false;
    unavailable: string;
};
/** Define arguments required to resolve interaction connections based on request and intent */
export interface ResolveInteractionConnectionArgs {
    request: Request;
    intent: 'list' | 'answer';
    /** The parsed, validated POST body (answer intent only) so the resolver can
     *  read product routing fields (workspaceId/threadId) without re-parsing. */
    body?: Record<string, unknown>;
}
/** Describe the arguments provided before processing an interaction answer including request, body, and connection details */
export interface BeforeInteractionAnswerArgs {
    request: Request;
    /** Original parsed body, including product routing fields. */
    body: Record<string, unknown>;
    /** Shared validation result; products never need to parse the answer again. */
    answer: Extract<InteractionAnswerBodyValidation, {
        ok: true;
    }>;
    connection: SidecarInteractionsConnection;
    /** The route's single authoritative pre-answer sidecar snapshot. */
    outstanding: InteractionRequestWire[];
    answeredRequest?: InteractionRequestWire;
    /** Content-identical questions that the shared route will also answer. */
    duplicateRequests: InteractionRequestWire[];
}
/** Define arguments for durable interaction routes including a stable caller-created attempt key */
export interface DurableInteractionRouteArgs extends BeforeInteractionAnswerArgs {
    /** Caller-created opaque identifier, stable across an ambiguous retry. */
    attemptKey: string;
}
/** Crash-recoverable persistence lifecycle for the answer route. The product
 * binds this structural port to its OWN durable store — agent-app ships no
 * implementation (the `/durable-chat` module that used to provide one was
 * removed in 0.44.0 after nine repos produced zero imports of it). Existing
 * `beforeAnswer` behavior remains independent and unchanged. */
export interface DurableInteractionRoutePersistence<TPrepared = unknown> {
    guarantee: 'reconciled' | 'best-effort';
    prepare(args: DurableInteractionRouteArgs): TPrepared | Promise<TPrepared>;
    /** Resolve an ambiguous retry (for example, the sidecar says the ask is
     * already gone). Only `settled:true` permits the route to report success. */
    reconcile(args: DurableInteractionRouteArgs & {
        prepared: TPrepared;
    }): {
        settled: boolean;
    } | Promise<{
        settled: boolean;
    }>;
    /** Record the authority acknowledgement before terminal projection. */
    acknowledge(args: DurableInteractionRouteArgs & {
        prepared: TPrepared;
        duplicateIds: string[];
    }): void | Promise<void>;
    /** Idempotently materialize terminal status and accepted values. */
    finalize(args: DurableInteractionRouteArgs & {
        prepared: TPrepared;
        duplicateIds: string[];
    }): void | Promise<void>;
    fail?(args: DurableInteractionRouteArgs & {
        prepared: TPrepared;
        error: unknown;
    }): void | Promise<void>;
}
/** Define options to authenticate, authorize, and manage persistence for interaction answer routes */
export interface InteractionAnswerRouteOptions {
    /** Authenticate + authorize the caller and resolve the sidecar connection.
     *  This is the only product-supplied step: session auth, workspace/thread
     *  access, rate limiting, and box resolution all live here. */
    resolveConnection: (args: ResolveInteractionConnectionArgs) => Promise<InteractionConnectionResolution>;
    /** Product persistence seam that runs before the answer can unblock and
     * finalize the agent turn. A throw aborts the request before any answer POST. */
    beforeAnswer?: (args: BeforeInteractionAnswerArgs) => void | Promise<void>;
    /** Additive crash-recoverable settlement. When configured, POST requires an
     * `attemptKey`; accepted values are finalized only after sidecar ack. */
    durable?: DurableInteractionRoutePersistence;
    logger?: InteractionRouteLogger;
}
/** Define routes to list outstanding interactions and resolve answers for live turns */
export interface InteractionAnswerRoute {
    /** GET — outstanding interactions for a live turn. Failures return an empty
     *  list with an explicit `unavailable` code: the caller is a best-effort
     *  reload restore, and the live/replayed stream must stay untouched when the
     *  sidecar cannot answer. */
    list: (request: Request) => Promise<Response>;
    /** POST `{ id, outcome, data?, ...productFields }` — resolve one ask, answer
     *  content-identical duplicates the same way, then re-list to prove the run
     *  actually unblocked. */
    answer: (request: Request) => Promise<Response>;
}
/** Create an interaction answer route that handles listing and resolving interaction requests */
export declare function createInteractionAnswerRoute(options: InteractionAnswerRouteOptions): InteractionAnswerRoute;
