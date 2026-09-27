/**
 * Pure invitation helpers + email-template renderer for the teams capability.
 * Zero dependencies: no drizzle, no env, no react, no network. The lifecycle API
 * (`./invitations-api`) and an app's own mail transport build on these; this leaf
 * imports nothing back, so a consumer can pull just the token/expiry math or the
 * template renderer without dragging in drizzle or a mail client.
 *
 * `renderInvitationEmail` is deliberately transport-free: it returns the
 * `{ from, subject, html, text }` an app hands to its own Resend/SES/etc. The
 * secret (API key) and the network call stay in the app's seam — agent-app ships
 * only the deterministic template.
 */
import type { AssignableWorkspaceRole } from './roles';
/** The role an invitation grants — the assignable workspace ladder (never owner). */
export type InvitationPermission = AssignableWorkspaceRole;
/** Define possible states for an invitation's lifecycle including pending, accepted, expired, and revoked */
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
/** Define possible statuses for the sending state of an invitation email */
export type InvitationEmailStatus = 'not_sent' | 'sent' | 'failed';
/** Define the number of days before an invitation expires */
export declare const INVITATION_EXPIRY_DAYS = 7;
/** Normalize an invitation email by trimming whitespace and converting to lowercase */
export declare function normalizeInvitationEmail(email: string): string;
/** Resolve invitation permission from a string or return null if invalid */
export declare function parseInvitationPermission(value: string | undefined): InvitationPermission | null;
/** Calculate the expiration date of an invitation based on the given or current date */
export declare function getInvitationExpiresAt(now?: Date): Date;
/**
 * A cryptographically-random, URL-safe invitation token. `inv_`-prefixed so a
 * token is self-identifying and never collides with the workspaceMember invite
 * tokens minted by `members-api` (`generateInviteToken`).
 */
export declare function generateInvitationToken(): string;
/** Generate an invite URL by combining the origin with an encoded token */
export declare function inviteUrlForToken(origin: string, token: string): string;
/** Define input data required to render an invitation email template */
export interface RenderInvitationEmailInput {
    to: string;
    workspaceName: string;
    inviterEmail: string;
    permission: string;
    inviteUrl: string;
    expiresAt: Date;
}
/** Define the structure for an invitation email brand including the RFC-5322 From header */
export interface InvitationEmailBrand {
    /** RFC-5322 From header, e.g. `GTM Agent <noreply@gtm.tangle.tools>`. */
    fromAddress: string;
}
/** Define the structure of a fully rendered invitation email with sender, subject, and content fields */
export interface RenderedInvitationEmail {
    from: string;
    subject: string;
    html: string;
    text: string;
}
/**
 * Render the invitation email body — pure, deterministic, transport-free. The
 * caller passes the result to its own mail client; this never reads a secret or
 * touches the network.
 */
export declare function renderInvitationEmail(input: RenderInvitationEmailInput, brand: InvitationEmailBrand): RenderedInvitationEmail;
