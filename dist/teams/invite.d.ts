/**
 * Pure invite-token helpers — generation, shape validation, and expiry math.
 * No I/O: the members API persists/looks up tokens; these functions only
 * produce well-formed tokens and decide, given values the caller already
 * loaded, whether an invite is usable.
 *
 * A token is an opaque high-entropy URL-safe string. It is the bearer secret
 * in `/invite/:token`, so it must be unguessable and never derived from the
 * email or workspace. `generateInviteToken` uses Web Crypto (`crypto`), which
 * is present in Workers, Node 18+, Deno, and browsers — no Node-only import,
 * so this stays a pure leaf.
 */
/** Cryptographically-random, URL-safe (base64url) invite token. */
export declare function generateInviteToken(): string;
/** True when `value` has the shape of an invite token (not whether it exists). */
export declare function isInviteTokenShape(value: unknown): value is string;
/** A pending invite row, narrowed to the fields invite acceptance reasons over. */
export interface InviteTokenState {
    /** null until accepted — a non-null value means the invite was already used. */
    acceptedAt: Date | number | null | undefined;
    /** Email the invite was addressed to, if any. */
    inviteEmail?: string | null;
    /** Optional hard expiry; omit/undefined for invites that never expire. */
    expiresAt?: Date | number | null;
}
/** Define possible reasons for rejecting an invite including acceptance, expiration, or email mismatch */
export type InviteRejectionReason = 'already-accepted' | 'expired' | 'email-mismatch';
/** Represent the outcome of validating an invite with success status and optional rejection reason */
export interface InviteValidationResult {
    ok: boolean;
    reason?: InviteRejectionReason;
}
/**
 * Decide whether a loaded invite can be accepted by `acceptingEmail` at `now`.
 * Pure: the caller has already fetched the row by token; this only judges it.
 * Email match is case-insensitive and only enforced when the invite was
 * addressed to a specific email (an open invite has no `inviteEmail`).
 */
export declare function validateInviteToken(invite: InviteTokenState, opts?: {
    acceptingEmail?: string | null;
    now?: Date;
}): InviteValidationResult;
