/**
 * Framework-neutral email-invitation lifecycle for the teams module: create /
 * list / resend / revoke / preview / accept over the dedicated
 * `workspace_invitation` table (from `createWorkspaceInvitationTable`). Lifted out
 * of any one app's route file — each app binds this once to its own db/tables/
 * access and mounts the handlers in its own routes with its own auth.
 *
 * Unlike `members-api` (whose "invite" is a pending workspaceMember row, no
 * email), this models the rich lifecycle: a dedicated invitation row with status,
 * 7-day expiry, emailStatus, resend, and revoke. On accept it materializes the
 * `organizationMembers` + `workspaceMembers` rows, so `members-api.listMembers`
 * still surfaces accepted members; pending invites live only here.
 *
 * Handlers return a discriminated `InvitationOutcome` (not a `Response`) so the
 * route adapter maps `{ status }` to its own framework's response. Three seams:
 *   - `sendInvitationEmail` (REQUIRED) — the app's mail transport. Returns a
 *     typed outcome; a failed send never blocks invitation creation (emailStatus
 *     is recorded as 'failed' and the invite link is still returned).
 *   - `enforceSeat` (OPTIONAL) — billing/seat-limit gate, called at create time
 *     only when the invite would consume a NEW seat. Reused from members-api.
 *   - `memberSyncSeam.add` (OPTIONAL) — fire-and-forget propagation of the new
 *     member to a sandbox/external system on accept. Fail-soft by contract.
 *
 * Imports `drizzle-orm`, so this is a subpath, never re-exported from root.
 */
import { type InvitationEmailStatus, type InvitationPermission, type InvitationStatus } from './invitations';
import { type EnforceSeatSeam, type MemberSyncSeam } from './members-api';
import type { TeamDatabase, WorkspaceAccessApi } from './drizzle/access';
import type { TeamParentTable, TeamTables } from './drizzle/schema';
import type { WorkspaceInvitationTables } from './drizzle/invitations-schema';
export { SeatLimitError } from './members-api';
export type { EnforceSeatSeam, MemberSyncSeam } from './members-api';
/** The app's mail transport. Returns a typed outcome; never throws to the API. */
export interface SendInvitationEmailInput {
    to: string;
    workspaceName: string;
    inviterEmail: string;
    permission: InvitationPermission;
    inviteUrl: string;
    expiresAt: Date;
}
/** Represent the outcome of sending an invitation email with success status and optional error message */
export type SendInvitationEmailResult = {
    succeeded: true;
} | {
    succeeded: false;
    error: string;
};
/** Resolve sending an invitation email and return the result asynchronously */
export interface SendInvitationEmailSeam {
    (input: SendInvitationEmailInput): Promise<SendInvitationEmailResult>;
}
/** The product's user table, narrowed to the columns the queries read. */
export interface InvitationUserTable {
    id: any;
    email: any;
    emailVerified: any;
}
/** The product's workspace table, narrowed to the columns the queries read. */
export interface InvitationWorkspaceTable {
    id: any;
    name: any;
}
/** Define configuration options required to manage workspace invitations and related data sources */
export interface InvitationsApiOptions {
    db: TeamDatabase;
    tables: TeamTables;
    /** The invitation table from `createWorkspaceInvitationTable`. */
    invitationsTable: WorkspaceInvitationTables;
    userTable: TeamParentTable & InvitationUserTable;
    workspaceTable: TeamParentTable & InvitationWorkspaceTable;
    access: Pick<WorkspaceAccessApi, 'getWorkspaceAccess'>;
    /** REQUIRED — the app's mail transport (e.g. Resend + renderInvitationEmail). */
    sendInvitationEmail: SendInvitationEmailSeam;
    /** OPTIONAL — seat-limit gate at create time; mirrors members-api. */
    enforceSeat?: EnforceSeatSeam;
    /** OPTIONAL — fire-and-forget member propagation on accept. */
    memberSyncSeam?: Pick<MemberSyncSeam, 'add'>;
    /** Inviter display fallback when the inviter's email is unknown. */
    productDisplayName?: string;
}
/** Represent a workspace invitation with details about inviter, permissions, status, and timestamps */
export interface WorkspaceInvitationView {
    id: string;
    workspaceId: string;
    organizationId: string;
    email: string;
    invitedByUserId: string;
    inviterEmail: string | null;
    permissions: InvitationPermission;
    token: string;
    status: InvitationStatus;
    emailStatus: InvitationEmailStatus;
    expiresAt: Date;
    createdAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    lastSentAt: Date | null;
}
/** Describe the structure of an invitation preview with workspace, email, permissions, status, and expiration details */
export interface InvitationPreview {
    workspaceId: string;
    workspaceName: string;
    email: string;
    inviterEmail: string | null;
    permissions: InvitationPermission;
    status: InvitationStatus;
    expiresAt: Date;
}
/** Resolve the result of an invitation as success with a value or failure with status and error details */
export type InvitationOutcome<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    status: number;
    error: string;
};
/**
 * Build the invitations API bound to one product's db/tables/access/seams.
 * Returns the six lifecycle handlers an app mounts in its routes.
 */
export declare function createInvitationsApi(opts: InvitationsApiOptions): {
    createInvitation: (input: {
        workspaceId: string;
        email: string;
        permissions: string | undefined;
        invitedByUserId: string;
        origin: string;
        now?: Date;
    }) => Promise<InvitationOutcome<{
        invitation: WorkspaceInvitationView;
        inviteUrl: string;
        emailError?: string;
    }>>;
    listInvitations: (input: {
        workspaceId: string;
        userId: string;
        origin: string;
        now?: Date;
    }) => Promise<InvitationOutcome<{
        invitations: Array<WorkspaceInvitationView & {
            inviteUrl: string;
        }>;
    }>>;
    resendInvitation: (input: {
        invitationId: string;
        userId: string;
        origin: string;
        now?: Date;
    }) => Promise<InvitationOutcome<{
        invitation: WorkspaceInvitationView;
        inviteUrl: string;
        emailError?: string;
    }>>;
    revokeInvitation: (input: {
        invitationId: string;
        userId: string;
        now?: Date;
    }) => Promise<InvitationOutcome<{
        invitation: WorkspaceInvitationView;
    }>>;
    getPreview: (token: string, now?: Date) => Promise<InvitationOutcome<InvitationPreview>>;
    acceptInvitation: (input: {
        token: string;
        userId: string;
        now?: Date;
    }) => Promise<InvitationOutcome<{
        workspaceId: string;
    }>>;
};
