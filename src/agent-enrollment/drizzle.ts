/**
 * Durable enrollment claims for products that already use Drizzle over D1.
 * This optional subpath leaves the core enrollment module free of Drizzle.
 *
 * The product owns two SQLite tables and their migration:
 *
 * - `instanceClaims`: NOT NULL ownerScope, instanceKey, profileVersion and
 *   configurationDigest; PRIMARY KEY (ownerScope, instanceKey).
 * - `enrollments`: PRIMARY KEY enrollmentId with explicit NOT NULL; NOT NULL
 *   ownerScope and every other AgentEnrollmentClaim field; nullable generation, sandboxId,
 *   filesystemIncarnationId and sessionId. These four target fields must be
 *   all NULL or all non-NULL, and a committed target must be immutable.
 *
 * `enrollmentId` must be explicitly NOT NULL: the guarded insert returns NULL
 * for a mismatched instance config, which must abort the entire batch. The
 * instance row must be immutable while an enrollment references it. A foreign
 * key from (ownerScope, instanceKey) to the reservation is recommended.
 * Products may add their own foreign keys and live authorization triggers.
 * No table is created or changed by this adapter.
 *
 * `claimIfAbsent` uses one D1 batch. Its second statement can insert an
 * enrollment only when the reserved instance has the same profile and digest.
 * The final statement removes a reservation created by a losing enrollment-ID
 * race, before the batch commits. D1 batches are atomic; a driver without
 * batch is refused rather than leaving half a claim.
 */

import { and, eq, exists, isNull, notExists, sql } from 'drizzle-orm'
import type { AnySQLiteColumn, AnySQLiteTable, BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  EnrollmentTargetError,
  type AgentEnrollmentClaim,
  type AgentEnrollmentStore,
  type AgentEnrollmentTarget,
} from './index'

export type AgentEnrollmentDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/** Required Drizzle column properties; SQL column names remain product-owned. */
export type AgentInstanceClaimTable = AnySQLiteTable & {
  ownerScope: AnySQLiteColumn
  instanceKey: AnySQLiteColumn
  profileVersion: AnySQLiteColumn
  configurationDigest: AnySQLiteColumn
}

/** The claim and its write-once native target share one enrollment row. */
export type AgentEnrollmentClaimTable = AnySQLiteTable & {
  enrollmentId: AnySQLiteColumn
  ownerScope: AnySQLiteColumn
  agentId: AnySQLiteColumn
  workspaceId: AnySQLiteColumn
  threadId: AnySQLiteColumn
  instanceKey: AnySQLiteColumn
  profileVersion: AnySQLiteColumn
  configurationDigest: AnySQLiteColumn
  generation: AnySQLiteColumn
  sandboxId: AnySQLiteColumn
  filesystemIncarnationId: AnySQLiteColumn
  sessionId: AnySQLiteColumn
}

export interface CreateDrizzleAgentEnrollmentStoreOptions {
  db: AgentEnrollmentDatabase
  instanceClaims: AgentInstanceClaimTable
  enrollments: AgentEnrollmentClaimTable
  /** Stable owner identity, obtained from the host's authenticated request. */
  ownerScope: string
}

type EnrollmentRow = AgentEnrollmentClaim & {
  ownerScope: string
  generation: number | null
  sandboxId: string | null
  filesystemIncarnationId: string | null
  sessionId: string | null
}

type InstanceRow = {
  profileVersion: string
  configurationDigest: string
}

function claimFromRow(row: EnrollmentRow): AgentEnrollmentClaim {
  return {
    enrollmentId: row.enrollmentId,
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    instanceKey: row.instanceKey,
    profileVersion: row.profileVersion,
    configurationDigest: row.configurationDigest,
  }
}

function targetFromRow(row: EnrollmentRow): AgentEnrollmentTarget | null {
  const values = [row.generation, row.sandboxId, row.filesystemIncarnationId, row.sessionId]
  if (values.every(value => value === null)) return null
  if (values.some(value => value === null)) throw new EnrollmentTargetError('target_changed')
  return {
    ...claimFromRow(row),
    generation: row.generation!,
    sandboxId: row.sandboxId!,
    filesystemIncarnationId: row.filesystemIncarnationId!,
    sessionId: row.sessionId!,
  }
}

/** Create an owner-scoped store backed by the caller's existing Drizzle D1. */
export function createDrizzleAgentEnrollmentStore(
  options: CreateDrizzleAgentEnrollmentStoreOptions,
): AgentEnrollmentStore {
  const { db, instanceClaims, enrollments, ownerScope } = options
  if (!ownerScope.trim()) throw new EnrollmentTargetError('invalid_request')
  const atomicDb = db as AgentEnrollmentDatabase & {
    batch?: (statements: [unknown, ...unknown[]]) => Promise<unknown[]>
  }

  async function findEnrollment(enrollmentId: string): Promise<EnrollmentRow | null> {
    const rows = await db.select().from(enrollments).where(and(
      eq(enrollments.enrollmentId, enrollmentId), eq(enrollments.ownerScope, ownerScope),
    )).limit(1)
    return (rows[0] ?? null) as EnrollmentRow | null
  }

  async function findInstance(instanceKey: string): Promise<InstanceRow | null> {
    const rows = await db.select({
      profileVersion: instanceClaims.profileVersion,
      configurationDigest: instanceClaims.configurationDigest,
    }).from(instanceClaims).where(and(
      eq(instanceClaims.ownerScope, ownerScope), eq(instanceClaims.instanceKey, instanceKey),
    )).limit(1)
    return (rows[0] ?? null) as InstanceRow | null
  }

  async function matchingInstance(claim: AgentEnrollmentClaim): Promise<boolean> {
    const instance = await findInstance(claim.instanceKey)
    return !!instance && instance.profileVersion === claim.profileVersion
      && instance.configurationDigest === claim.configurationDigest
  }

  async function get(enrollmentId: string): Promise<AgentEnrollmentTarget | null> {
    const row = await findEnrollment(enrollmentId)
    if (!row) return null
    const target = targetFromRow(row)
    if (!target) return null
    if (!await matchingInstance(target)) throw new EnrollmentTargetError('target_changed')
    return target
  }

  return {
    get,
    async claimIfAbsent(input) {
      if (typeof atomicDb.batch !== 'function') {
        throw new Error('Agent enrollment requires an atomic Drizzle D1 batch')
      }
      const claim: AgentEnrollmentClaim = { ...input }
      const instanceScope = and(
        eq(instanceClaims.ownerScope, ownerScope),
        eq(instanceClaims.instanceKey, claim.instanceKey),
      )
      const reservation = db.insert(instanceClaims).values({
        ownerScope, instanceKey: claim.instanceKey,
        profileVersion: claim.profileVersion,
        configurationDigest: claim.configurationDigest,
      }).onConflictDoNothing()
      // A NULL enrollment ID fails the required NOT NULL constraint. The
      // atomic batch then rolls back a reservation with a different config.
      const validEnrollmentId = sql<string>`(
        SELECT ${claim.enrollmentId} FROM ${instanceClaims}
        WHERE ${instanceScope}
          AND ${instanceClaims.profileVersion} = ${claim.profileVersion}
          AND ${instanceClaims.configurationDigest} = ${claim.configurationDigest}
        LIMIT 1
      )`
      const enrollment = db.insert(enrollments).values({
        ...claim, ownerScope, enrollmentId: validEnrollmentId,
      }).onConflictDoNothing()
      // If enrollmentId was already taken by a different key, the second
      // insert does nothing. Remove only a reservation with no enrollment.
      const cleanup = db.delete(instanceClaims).where(and(
        instanceScope,
        eq(instanceClaims.profileVersion, claim.profileVersion),
        eq(instanceClaims.configurationDigest, claim.configurationDigest),
        notExists(db.select({ id: enrollments.enrollmentId }).from(enrollments).where(and(
          eq(enrollments.ownerScope, ownerScope),
          eq(enrollments.instanceKey, claim.instanceKey),
        ))),
      ))
      try {
        await atomicDb.batch([reservation, enrollment, cleanup])
      } catch (error) {
        const existing = await findEnrollment(claim.enrollmentId)
        if (existing) {
          const winner = claimFromRow(existing)
          if (!await matchingInstance(winner)) throw new EnrollmentTargetError('conflict')
          return winner
        }
        const instance = await findInstance(claim.instanceKey)
        if (instance && (instance.profileVersion !== claim.profileVersion
          || instance.configurationDigest !== claim.configurationDigest)) {
          throw new EnrollmentTargetError('conflict')
        }
        throw error
      }
      const row = await findEnrollment(claim.enrollmentId)
      if (!row) throw new EnrollmentTargetError('conflict')
      if (!await matchingInstance(claimFromRow(row))) throw new EnrollmentTargetError('conflict')
      return claimFromRow(row)
    },
    async insertIfAbsent(target) {
      const saved = { ...target }
      await db.update(enrollments).set({
        generation: saved.generation,
        sandboxId: saved.sandboxId,
        filesystemIncarnationId: saved.filesystemIncarnationId,
        sessionId: saved.sessionId,
      }).where(and(
        eq(enrollments.enrollmentId, saved.enrollmentId),
        eq(enrollments.ownerScope, ownerScope),
        eq(enrollments.agentId, saved.agentId),
        eq(enrollments.workspaceId, saved.workspaceId),
        eq(enrollments.threadId, saved.threadId),
        eq(enrollments.instanceKey, saved.instanceKey),
        eq(enrollments.profileVersion, saved.profileVersion),
        eq(enrollments.configurationDigest, saved.configurationDigest),
        isNull(enrollments.generation),
        isNull(enrollments.sandboxId),
        isNull(enrollments.filesystemIncarnationId),
        isNull(enrollments.sessionId),
        exists(db.select({ key: instanceClaims.instanceKey }).from(instanceClaims).where(and(
          eq(instanceClaims.ownerScope, ownerScope),
          eq(instanceClaims.instanceKey, saved.instanceKey),
          eq(instanceClaims.profileVersion, saved.profileVersion),
          eq(instanceClaims.configurationDigest, saved.configurationDigest),
        ))),
      ))
      const winner = await get(saved.enrollmentId)
      if (!winner) throw new EnrollmentTargetError('conflict')
      return winner
    },
  }
}
