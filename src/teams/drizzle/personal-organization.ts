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

import { and, eq } from 'drizzle-orm'
import type { OrganizationRole } from '../roles'
import type { TeamDatabase } from './access'
import type { OrganizationMemberRow, OrganizationRow, TeamTables } from './schema'

export interface EnsurePersonalOrganizationUser {
  id: string
  name?: string | null
  email?: string | null
}

export interface PersonalOrganizationResult {
  organization: OrganizationRow
  member: OrganizationMemberRow
  role: OrganizationRole
}

export interface CreatePersonalOrganizationOptions {
  db: TeamDatabase
  tables: TeamTables
}

export function createEnsurePersonalOrganization(opts: CreatePersonalOrganizationOptions) {
  const { db, tables } = opts
  const { organizations, organizationMembers } = tables

  return async function ensurePersonalOrganization(
    user: EnsurePersonalOrganizationUser,
  ): Promise<PersonalOrganizationResult> {
    const [existing] = await db
      .select({
        organization: organizations,
        member: organizationMembers,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(
        eq(organizationMembers.userId, user.id),
        eq(organizations.kind, 'personal'),
      ))
      .limit(1)

    if (existing) {
      return {
        organization: existing.organization,
        member: existing.member,
        role: existing.member.role as OrganizationRole,
      }
    }

    const orgName = user.name?.trim() || user.email?.split('@')[0] || 'Personal'
    const slug = `personal-${user.id}`
    const [organization] = await db
      .insert(organizations)
      .values({
        name: `${orgName}'s Organization`,
        slug,
        kind: 'personal',
        createdBy: user.id,
      })
      .onConflictDoUpdate({
        target: organizations.slug,
        set: { updatedAt: new Date() },
      })
      .returning()

    // A single-row upsert with .returning() always yields exactly one row.
    const org = organization as OrganizationRow

    const [member] = await db
      .insert(organizationMembers)
      .values({
        organizationId: org.id,
        userId: user.id,
        role: 'owner',
      })
      .onConflictDoUpdate({
        target: [organizationMembers.organizationId, organizationMembers.userId],
        set: { role: 'owner', updatedAt: new Date() },
      })
      .returning()

    return { organization: org, member: member as OrganizationMemberRow, role: 'owner' }
  }
}
