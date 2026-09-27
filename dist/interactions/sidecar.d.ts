/**
 * Server-side client for the sandbox sidecar's generic interaction routes
 * (`GET/POST {runtimeUrl}/agents/sessions/{sessionId}/interactions`). The
 * pinned sandbox SDK exposes only the question-specific `session().answer()`
 * convenience; these raw calls are backend-agnostic (question/permission/plan,
 * any harness) and carry explicit outcomes (accepted/declined).
 *
 * Server-only: the sidecar bearer must never reach browser code. The caller
 * supplies the connection as a structural value (runtime URL + bearer +
 * session id) — no sandbox-SDK import, so any box-resolution strategy works.
 */
import type { InteractionData, InteractionOutcome, InteractionRequestWire } from './contract';
/** Describe error details including code, message, and upstream HTTP status for sidecar interactions */
export interface SidecarInteractionsError {
    code: string;
    message: string;
    /** Upstream HTTP status; 0 when the sidecar was unreachable. */
    status: number;
}
/** Represent the outcome of sidecar interactions with success or error details */
export type SidecarInteractionsResult<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    error: SidecarInteractionsError;
};
/** Where and how to reach one session's interaction registry. */
export interface SidecarInteractionsConnection {
    runtimeUrl: string;
    authToken?: string;
    /** The sidecar agent-session id (the chat thread's session). */
    sessionId: string;
    /** Request deadline. A pending interaction means the box is up and the
     *  sidecar responsive; a short default keeps a wedged runtime from stalling
     *  the answering request. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
}
/** Outstanding (unanswered) interactions for the session — the sidecar's
 *  registry is authoritative, so this is the reconnect/reload source of truth. */
export declare function listSessionInteractions(connection: SidecarInteractionsConnection): Promise<SidecarInteractionsResult<InteractionRequestWire[]>>;
/** Resolves one interaction. `data` is required by the sidecar only for
 *  `accepted` outcomes and is validated fail-closed against the answerSpec
 *  (400 INVALID_INTERACTION_ANSWER on mismatch). */
export declare function respondToSessionInteraction(connection: SidecarInteractionsConnection, response: {
    id: string;
    outcome: InteractionOutcome;
    data?: InteractionData;
}): Promise<SidecarInteractionsResult<void>>;
/**
 * A sandbox session's lifecycle as the sidecar reports it.
 *
 * Every field is optional because the sidecar's payload has grown over time and
 * an older box answers with a subset. A reader that assumes a field is present
 * mis-reads an old box as terminal; the shapes below are read defensively for
 * that reason, not out of caution about types.
 */
export interface SidecarSessionState {
    state?: string;
    activeExecutionId?: string | null;
    activeExecutionStatus?: string | null;
    reconnectable?: boolean;
    registryAuthority?: string | null;
    terminalReason?: string | null;
    lastEventAt?: string | number | null;
    outstandingInteractions?: unknown[];
}
export interface SidecarAbortResult {
    cancelled: boolean;
    reason?: string;
    session?: SidecarSessionState;
}
/**
 * Whether a session has finished and will not produce more events.
 *
 * The three early returns are the ones that matter: a session with a live
 * execution, one the platform says is reconnectable, or one holding an
 * unanswered interaction is NOT terminal however its `state` string reads. An
 * app that treats such a session as finished abandons a turn mid-flight, or
 * leaves an agent blocked on an answer nobody will send.
 */
export declare function isTerminalSidecarState(state: {
    state?: string;
    activeExecutionId?: string | null;
    reconnectable?: boolean;
    outstandingInteractions?: unknown[];
}): boolean;
/** The session's current lifecycle, for reconnect and resume decisions. */
export declare function getSessionState(connection: SidecarInteractionsConnection): Promise<SidecarInteractionsResult<SidecarSessionState>>;
/**
 * Cancel a running session.
 *
 * A 404 is reported as a SUCCESSFUL no-op rather than an error: the caller's
 * intent is "this session must not be running", and a session the sidecar has
 * never heard of already satisfies that. Surfacing it as a failure makes every
 * cancel-after-completion look like an outage.
 */
export declare function abortSession(connection: SidecarInteractionsConnection): Promise<SidecarInteractionsResult<SidecarAbortResult>>;
