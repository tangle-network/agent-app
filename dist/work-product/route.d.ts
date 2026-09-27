/**
 * Framework-neutral work-product review endpoints — the
 * `createInteractionAnswerRoute` factory pattern: web-standard
 * `Request`/`Response`, ONE product-supplied `authorize` seam (session auth,
 * workspace access, reviewer identity, rate limits), everything behind it
 * mechanism. Server-only and subpath-only: never reachable from a client
 * bundle (enforced by the browser-safety test).
 *
 * The verdict endpoint is deliberately NOT a second approval broker: agent
 * asks stay on `/interactions`; this is the REVIEWER's plain authorized
 * verdict on a ready package — one human-in-the-loop channel per direction.
 * A `request_changes` note re-enters chat as the correction turn via the
 * `onVerdict` seam; chat remains the driver surface.
 */
import { type WorkProductPersistedPart, type WorkProductRecord, type WorkProductStorePort } from './types';
/** Reviewer verdict wire body for the POST endpoint. */
export type WorkProductVerdictBody = {
    ok: true;
    id: string;
    verdict: 'approve';
    note?: string;
} | {
    ok: true;
    id: string;
    verdict: 'request_changes';
    note: string;
} | {
    ok: false;
    error: string;
};
/** Validate the verdict POST body: `{ id, verdict, note? }`; a
 *  `request_changes` verdict REQUIRES a non-empty note — the note IS the
 *  correction turn the agent works from. */
export declare function validateWorkProductVerdictBody(body: Record<string, unknown>): WorkProductVerdictBody;
/** The product seam's verdict for one request: authenticated reviewer +
 *  workspace, or a product-authored short-circuit Response (401/403/429…). */
export type WorkProductRouteAuthorization = {
    ok: true;
    workspaceId: string;
    reviewedBy: string;
} | {
    ok: false;
    response: Response;
};
/** Auth seam arguments carrying the request, the endpoint intent, and the parsed verdict body */
export interface WorkProductAuthorizeArgs {
    request: Request;
    intent: 'list' | 'detail' | 'verdict';
    /** The parsed, validated POST body (verdict intent only). */
    body?: Record<string, unknown>;
}
/** Configuration options assembling the review endpoints from the store and product seams */
export interface WorkProductRoutesOptions {
    store: WorkProductStorePort;
    /** Authenticate + authorize the caller; the ONLY product access step. */
    authorize: (args: WorkProductAuthorizeArgs) => Promise<WorkProductRouteAuthorization>;
    /** Post-verdict product seam: post the `request_changes` note into the
     *  driving chat thread as the correction turn, notify, etc. Runs after the
     *  transition commits; a throw is logged, never unwinds the verdict. */
    onVerdict?: (args: {
        record: WorkProductRecord;
        verdict: 'approve' | 'request_changes';
        note?: string;
        reviewedBy: string;
    }) => void | Promise<void>;
    /** Persist/update the transcript anchor part reflecting the new status, so
     *  the chat card flips with the verdict. */
    persistAnchorPart?: (part: WorkProductPersistedPart, record: WorkProductRecord) => void | Promise<void>;
    /** Future integration point fired on approval (push to a DMS/CRM/export
     *  pipeline). A stub seam by design — export itself stays the product's
     *  signed object-store download. */
    onExport?: (record: WorkProductRecord) => void | Promise<void>;
    logger?: Pick<Console, 'warn' | 'error'>;
    now?: () => number;
}
/** Assembled review endpoints returning web-standard Responses */
export interface WorkProductRoutes {
    /** GET — the workspace's records for the queue projection. Optional
     *  `?status=a,b` filter. */
    list: (request: Request) => Promise<Response>;
    /** GET — one record by id (404 when absent or outside the workspace). */
    detail: (request: Request, id: string) => Promise<Response>;
    /** POST `{ id, verdict, note? }` — the reviewer verdict: CAS transition +
     *  history entry + product seams. 409 when the record is no longer ready. */
    verdict: (request: Request) => Promise<Response>;
}
/** Create the work-product review endpoints over the store port and product seams */
export declare function createWorkProductRoutes(options: WorkProductRoutesOptions): WorkProductRoutes;
