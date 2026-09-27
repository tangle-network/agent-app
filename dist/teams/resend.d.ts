/**
 * Opt-in Resend transport for the teams invitations `sendInvitationEmail` seam.
 * Most adopters back the seam with Resend and hand-roll the same wrapper — and
 * the same mistake: `resend.emails.send()` returns `{ data, error }` and does NOT
 * throw on an API-level failure (unverified domain, rate limit, bad recipient),
 * so a `try/catch` alone records a failed send as a success. This helper sends
 * through the shared `renderInvitationEmail` template and returns a typed failure
 * on BOTH a thrown error AND a non-null `result.error`.
 *
 * `resend` is an OPTIONAL peer, imported only here: apps not on Resend keep
 * passing a raw seam, and the package core never pulls a mail dependency.
 */
import type { SendInvitationEmailSeam } from './invitations-api';
/** Define options for sending a resend invitation including sender address and optional API key */
export interface ResendInvitationSenderOptions {
    /** RFC-5322 From header, e.g. `GTM Agent <noreply@gtm.tangle.tools>`. */
    from: string;
    /** Resend API key. Defaults to `process.env.RESEND_API_KEY`. */
    apiKey?: string;
}
/**
 * Build a `sendInvitationEmail` seam backed by Resend. Wire it into
 * `createInvitationsApi({ sendInvitationEmail: createResendInvitationSender({ from }) })`.
 * The client is built lazily on first send; with no key the seam fails typed
 * (the invitation is still created — emailStatus becomes 'failed').
 */
export declare function createResendInvitationSender(opts: ResendInvitationSenderOptions): SendInvitationEmailSeam;
