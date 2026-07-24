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

import { Resend } from 'resend'
import { renderInvitationEmail } from './invitations'
import type { SendInvitationEmailSeam } from './invitations-api'

/** Define options for sending a resend invitation including sender address and optional API key */
export interface ResendInvitationSenderOptions {
  /** RFC-5322 From header, e.g. `GTM Agent <noreply@gtm.tangle.tools>`. */
  from: string
  /** Resend API key. Defaults to `process.env.RESEND_API_KEY`. */
  apiKey?: string
}

/**
 * Build a `sendInvitationEmail` seam backed by Resend. Wire it into
 * `createInvitationsApi({ sendInvitationEmail: createResendInvitationSender({ from }) })`.
 * The client is built lazily on first send; with no key the seam fails typed
 * (the invitation is still created — emailStatus becomes 'failed').
 */
export function createResendInvitationSender(opts: ResendInvitationSenderOptions): SendInvitationEmailSeam {
  let client: Resend | null = null

  function getClient(): Resend | null {
    if (client) return client
    const key = opts.apiKey ?? (typeof process !== 'undefined' ? process.env.RESEND_API_KEY : undefined)
    if (!key) return null
    client = new Resend(key)
    return client
  }

  return async (input) => {
    const resend = getClient()
    if (!resend) return { succeeded: false, error: 'RESEND_API_KEY is not configured' }

    const msg = renderInvitationEmail(input, { fromAddress: opts.from })
    try {
      const result = await resend.emails.send({
        from: msg.from,
        to: input.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      })
      // Resend reports API-level failures in `result.error` WITHOUT throwing — a
      // try/catch alone would mark a failed send as a success.
      if (result.error) return { succeeded: false, error: result.error.message }
      return { succeeded: true }
    } catch (err) {
      return { succeeded: false, error: err instanceof Error ? err.message : 'Invitation email failed to send' }
    }
  }
}
