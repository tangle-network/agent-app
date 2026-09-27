/**
 * Invite-accept surface for `/invite/:token`. Renders the invite state (valid /
 * invalid / already-accepted), handles the signed-out path (sign in or create
 * an account with the invited email), the email-mismatch path (switch account),
 * and the accept action. Callback-driven: the host supplies the resolved
 * `details` and `onAccept` / `onNavigate`, so this imports no app router or
 * fetch client. Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 */
import type { InviteAcceptPageProps } from '../contracts';
export declare function InviteAcceptPage({ details, onAccept, onNavigate, onResendVerification }: InviteAcceptPageProps): import("react").JSX.Element;
