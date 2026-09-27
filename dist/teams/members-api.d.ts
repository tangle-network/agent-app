/**
 * Framework-neutral members API for the teams module: the invite / list /
 * update-role / remove / accept-invite logic, lifted out of any one app's route
 * file. Each app mounts these in its own route with its own auth — the handlers
 * take an already-authenticated `actor`, the parsed inputs, the `db` + `tables`
 * from `createTeamTables`, the product's user + workspace tables, and the
 * workspace-access API from `createWorkspaceAccess`. They return web-standard
 * `Response`s (available in Workers, Node 18+, Deno, browsers), so
 * "framework-neutral" is literal: no Remix/React-Router/Express import anywhere.
 *
 * Two OPTIONAL seams an app wires only if it needs them:
 *   - `enforceSeat` — billing/seat-limit gate, called at invite time only when
 *     the invite would consume a NEW billable seat. An app without seat billing
 *     passes nothing and seats are never checked.
 *   - `memberSyncSeam` — fire-and-forget propagation of membership changes to a
 *     sandbox/external system (add on accept, role on update, remove on
 *     delete). An app without sandbox sync passes nothing. Fail-soft by
 *     contract: a thrown sync is caught and never blocks the DB mutation.
 *
 * Imports `drizzle-orm`, so this is a subpath, never re-exported from root.
 */
import { type WorkspaceRole } from './roles';
import type { TeamDatabase, WorkspaceAccessApi } from './drizzle/access';
import type { TeamParentTable, TeamTables } from './drizzle/schema';
/** The authenticated caller — apps resolve this from their own session layer. */
export interface MembersApiActor {
    id: string;
    email?: string | null;
}
/**
 * The product's user table, narrowed to the columns the member queries read.
 * Adopters pass their real drizzle user table.
 */
export interface UserLookupTable {
    id: any;
    name: any;
    email: any;
}
/**
 * The product's workspace table, narrowed to the columns the member queries
 * read. The handlers join it to resolve a workspace's organization (the same
 * table passed to createTeamTables as workspaceTable).
 */
export interface WorkspaceLookupTable {
    id: any;
    organizationId: any;
}
/**
 * Optional billing seat gate. The seam resolves the count input itself (it
 * owns the plan/seat model) and throws when over the limit; the handler turns a
 * thrown `SeatLimitError` into a 402. Called only when an invite would consume
 * a NEW seat (invitee is not already an org member and has no pending org
 * invite) — the same guard gtm uses, so the seam never fires on a no-op invite.
 */
export interface EnforceSeatSeam {
    (input: {
        actorId: string;
        organizationId: string;
    }): Promise<void> | void;
}
/** Thrown by an `enforceSeat` seam to deny an invite; serialized to a 402. */
export declare class SeatLimitError extends Error {
    readonly status: number;
    readonly capability?: string;
    readonly requiredPlan?: string;
    constructor(message: string, opts?: {
        status?: number;
        capability?: string;
        requiredPlan?: string;
    });
}
/**
 * Optional membership-change propagation to an external system (e.g. sandbox).
 * Every method is fire-and-forget and fail-soft: the handler awaits nothing and
 * swallows rejections, so an unavailable downstream never blocks the mutation.
 * Each fires only for members with a real `userId` (never email-only invites).
 */
export interface MemberSyncSeam {
    add?(input: {
        workspaceId: string;
        userId: string;
        role: WorkspaceRole;
    }): Promise<void> | void;
    role?(input: {
        workspaceId: string;
        userId: string;
        role: WorkspaceRole;
    }): Promise<void> | void;
    remove?(input: {
        workspaceId: string;
        userId: string;
    }): Promise<void> | void;
}
/** Define configuration options for managing team members and workspace access APIs */
export interface MembersApiOptions {
    db: TeamDatabase;
    tables: TeamTables;
    /** The product's user table (FK target passed to createTeamTables). */
    userTable: TeamParentTable & UserLookupTable;
    /** The product's workspace table (FK target passed to createTeamTables). */
    workspaceTable: TeamParentTable & WorkspaceLookupTable;
    /** Workspace-access API from createWorkspaceAccess — RBAC stays one source. */
    access: Pick<WorkspaceAccessApi, 'getWorkspaceAccess'>;
    enforceSeat?: EnforceSeatSeam;
    memberSyncSeam?: MemberSyncSeam;
}
/** Define the structure of a workspace member entry with identification, role, and status details */
export interface MemberListEntry {
    id: string;
    userId: string | null;
    organizationMemberId: string | null;
    role: WorkspaceRole;
    name: string | null;
    email: string | null;
    invitedAt: Date | number | null;
    acceptedAt: Date | number | null;
    inherited: boolean;
}
/**
 * Build the members API bound to one product's db/tables/access. Returns five
 * handlers; an app maps its route methods onto them (GET→list, POST→invite,
 * PATCH→updateRole, DELETE→remove; accept on its own route).
 */
export declare function createMembersApi(opts: MembersApiOptions): {
    listMembers: (input: {
        workspaceId: string;
        actor: MembersApiActor;
    }) => Promise<Response>;
    inviteMember: (input: {
        workspaceId: string;
        actor: MembersApiActor;
        email?: string;
        role?: string;
    }) => Promise<Response>;
    updateMemberRole: (input: {
        workspaceId: string;
        actor: MembersApiActor;
        memberId?: string;
        role?: string;
    }) => Promise<Response>;
    removeMember: (input: {
        workspaceId: string;
        actor: MembersApiActor;
        memberId?: string;
    }) => Promise<Response>;
    acceptInvite: (input: {
        token?: string;
        actor: MembersApiActor;
    }) => Promise<Response>;
};
