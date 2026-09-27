/**
 * Workspace members panel: list members, invite by email + role, change a
 * member's role, remove a member. Fully callback-driven — the host supplies the
 * data and the async `onInvite`/`onChangeRole`/`onRemove` callbacks (backed by
 * `./teams/members-api`), so this imports no app router, fetch client, or toast.
 * Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 *
 * Role gating mirrors the API: only admins/owners see role selects and the
 * remove control; inherited org owners and explicit owners are not editable
 * here (org-level concern). The invite role select offers `admin` only to
 * admins/owners.
 */
import type { MembersPanelProps } from '../contracts';
export declare function MembersPanel({ members, currentRole, onInvite, onChangeRole, onRemove, onNotice, showInviteForm, }: MembersPanelProps): import("react").JSX.Element;
