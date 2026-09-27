/**
 * Email-invitation panel: invite by email + role, and a history of every
 * invitation (pending / accepted / expired / revoked) with its email-delivery
 * status. Pending rows expose copy-link / resend / revoke. Fully callback-driven
 * — the host supplies the data and the async `onInvite` / `onResend` / `onRevoke`
 * callbacks (backed by `./teams/invitations-api`), so this imports no app router,
 * fetch client, or toast. Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 *
 * Mount alongside a list-only `MembersPanel` (`showInviteForm={false}`): the
 * members panel shows accepted members, this owns the invite flow + pending list.
 */
import type { InvitationsPanelProps } from '../contracts';
export declare function InvitationsPanel({ invitations, currentRole, onInvite, onResend, onRevoke, onCopy, onNotice, }: InvitationsPanelProps): import("react").JSX.Element;
