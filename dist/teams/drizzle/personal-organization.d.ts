/**
 * `ensurePersonalOrganization` — the substrate that makes solo-user adoption
 * work. Every user gets exactly one auto-created `kind: 'personal'` org with
 * the user as `owner` member. That org is the tenant that owns their
 * workspaces, so role resolution (`getWorkspaceAccess`) has an org row to read
 * even before any team/invite exists.
 *
 * Idempotent by construction: the org `slug` is derived from the user id
 * (`personal-<id>`) and upserted; the membership upserts on the
 * (organizationId, userId) unique index. Concurrent calls converge — no
 * duplicate personal orgs, no duplicate owner rows.
 *
 * ADOPTION CONTRACT: call this once per user at first authenticated entry
 * (e.g. right after sign-in / session bootstrap) BEFORE the first
 * `getWorkspaceAccess`. Role resolution requires the org membership to exist;
 * an adopter that skips this will see `null` access for a brand-new user with
 * no org row. There is no implicit creation inside the access builders — that
 * keeps reads side-effect-free; provisioning is this explicit call.
 */
import type { OrganizationRole } from '../roles';
import type { TeamDatabase } from './access';
import type { OrganizationMemberRow, OrganizationRow, TeamTables } from './schema';
/** Define the structure for a user within a personal organization context */
export interface EnsurePersonalOrganizationUser {
    id: string;
    name?: string | null;
    email?: string | null;
}
/** Describe a personal organization result including organization, member, and role details */
export interface PersonalOrganizationResult {
    organization: OrganizationRow;
    member: OrganizationMemberRow;
    role: OrganizationRole;
}
/** Define options required to create a personal organization including database and tables references */
export interface CreatePersonalOrganizationOptions {
    db: TeamDatabase;
    tables: TeamTables;
}
/** Ensure a user has a personal organization by creating or retrieving it as needed */
export declare function createEnsurePersonalOrganization(opts: CreatePersonalOrganizationOptions): (user: EnsurePersonalOrganizationUser) => Promise<PersonalOrganizationResult>;
