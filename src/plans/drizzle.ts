/**
 * Durable plan parts in the product's chat message table: read a plan out of
 * a thread's persisted assistant parts and write a decided plan back onto the
 * part the transcript renders.
 *
 * Two races are handled by converging rather than erroring: the plan part may
 * not be persisted yet when a fast click arrives (the write lags the stream),
 * and a second tab may decide first (the sandbox answers 409).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn, AnySQLiteTable, BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { canTransitionPlanStatus, persistedPartToPlan, planToPersistedPart, type ChatPlan } from './index'

/** The product's message table, narrowed to the columns plan parts use. */
export type PlanMessageTable = AnySQLiteTable & {
  id: AnySQLiteColumn
  threadId: AnySQLiteColumn
  role: AnySQLiteColumn
  parts: AnySQLiteColumn
  /** Needed only by `planOriginUserTurn`. */
  metadata?: AnySQLiteColumn
}

export interface PlanPartStoreOptions {
  db: BaseSQLiteDatabase<'sync' | 'async', any, any>
  messages: PlanMessageTable
}

type PartsRow = { parts: Array<Record<string, unknown>> | null }

const PERSISTED_PLAN_DELAYS_MS = [0, 25, 75, 150] as const
const CONFLICT_PLAN_DELAYS_MS = [0, 50, 100, 200, 400] as const

export function createPlanPartStore({ db, messages }: PlanPartStoreOptions) {
  /** Rows carrying one plan revision, matched inside SQLite rather than by
   *  pulling every assistant row's parts into the worker. `json_valid` guards
   *  rows that predate the parts column, where `json_each` would throw. */
  function planRowFilter(threadId: string, planId: string, revision: number): SQL {
    return and(
      eq(messages.threadId, threadId),
      eq(messages.role, 'assistant'),
      sql`${messages.parts} IS NOT NULL AND json_valid(${messages.parts}) AND EXISTS (
        SELECT 1 FROM json_each(${messages.parts})
        WHERE json_extract(value, '$.type') = 'plan'
          AND json_extract(value, '$.planId') = ${planId}
          AND json_extract(value, '$.revision') = ${revision}
      )`,
    ) as SQL
  }

  /** The thread's plan: the requested revision, or with no `planId` the latest
   *  submitted one. Revisions belong to one sandbox session, so submission
   *  time also orders replacement sessions; a repeated part resolves to the
   *  furthest-transitioned status. */
  async function persistedPlan(threadId: string, planId?: string, revision?: number): Promise<ChatPlan | null> {
    const where = planId && revision !== undefined
      ? planRowFilter(threadId, planId, revision)
      : and(eq(messages.threadId, threadId), eq(messages.role, 'assistant'))
    const rows = await db.select({ parts: messages.parts }).from(messages).where(where) as PartsRow[]
    let latest: ChatPlan | null = null
    for (const row of rows) {
      for (const part of row.parts ?? []) {
        const plan = persistedPartToPlan(part)
        if (!plan || (planId && (plan.planId !== planId || plan.revision !== revision))) continue
        const submittedAt = Date.parse(plan.submittedAt)
        if (!Number.isFinite(submittedAt)) continue
        const latestSubmittedAt = latest ? Date.parse(latest.submittedAt) : -Infinity
        if (!latest || submittedAt > latestSubmittedAt
          || (submittedAt === latestSubmittedAt && plan.revision > latest.revision)
          || (plan.planId === latest.planId && plan.revision === latest.revision
            && canTransitionPlanStatus(latest.status, plan.status))) {
          latest = plan
        }
      }
    }
    return latest
  }

  async function pollPersistedPlan(
    threadId: string,
    planId: string,
    revision: number,
    delaysMs: readonly number[],
    done: (plan: ChatPlan) => boolean,
  ): Promise<ChatPlan | null> {
    let latest: ChatPlan | null = null
    for (const delayMs of delaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      latest = await persistedPlan(threadId, planId, revision)
      if (latest && done(latest)) return latest
    }
    return latest
  }

  /** A fast click can land before the stream persists the plan part: a
   *  bounded wait rather than a 404 the user would retry blind. */
  function waitForPersistedPlan(threadId: string, planId: string, revision: number): Promise<ChatPlan | null> {
    return pollPersistedPlan(threadId, planId, revision, PERSISTED_PLAN_DELAYS_MS, () => true)
  }

  /** After a conflict, wait for the other decider's write-back so both tabs
   *  converge on the same terminal plan. */
  function reconciledConflictPlan(threadId: string, planId: string, revision: number): Promise<ChatPlan | null> {
    return pollPersistedPlan(threadId, planId, revision, CONFLICT_PLAN_DELAYS_MS,
      (plan) => plan.status !== 'pending' && plan.status !== 'preparing')
  }

  /** Write the decided plan back onto its transcript part. Throws when the
   *  plan is not in the thread: a silent no-op would leave the card pending. */
  async function persistPlanStatus(threadId: string, plan: ChatPlan): Promise<void> {
    const rows = await db
      .select({ id: messages.id, parts: messages.parts })
      .from(messages)
      .where(planRowFilter(threadId, plan.planId, plan.revision)) as Array<PartsRow & { id: string }>
    let found = false
    for (const row of rows) {
      let changed = false
      const nextParts = (row.parts ?? []).map((part) => {
        const current = persistedPartToPlan(part)
        if (current?.planId !== plan.planId || current.revision !== plan.revision) return part
        found = true
        changed = true
        return planToPersistedPart(plan) as unknown as Record<string, unknown>
      })
      if (changed) await db.update(messages).set({ parts: nextParts } as never).where(eq(messages.id, row.id))
    }
    if (!found) throw new Error(`Plan ${plan.planId} is missing from thread ${threadId}`)
  }

  /** The user turn that started the plan. Every revision of a plan inherits
   *  the turn before its first submitted revision. */
  async function planOriginUserTurn(
    threadId: string,
    planId: string,
    revision: number,
  ): Promise<{ id: string; metadata: Record<string, unknown> | null } | null> {
    const [requested] = await db.select({ id: messages.id }).from(messages)
      .where(planRowFilter(threadId, planId, revision)).limit(1) as Array<{ id: string }>
    if (!requested) return null
    const [first] = revision === 1 ? [requested] : await db.select({ id: messages.id }).from(messages)
      .where(planRowFilter(threadId, planId, 1)).limit(1) as Array<{ id: string }>
    if (!first) return null
    if (!messages.metadata) throw new Error('planOriginUserTurn needs the message table\'s metadata column')
    const [userTurn] = await db.select({ id: messages.id, metadata: messages.metadata }).from(messages)
      .where(and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        sql`${messages}.rowid < (SELECT rowid FROM ${messages} WHERE ${messages.id} = ${first.id})`,
      ))
      .orderBy(sql`${messages}.rowid DESC`).limit(1) as Array<{ id: string; metadata: Record<string, unknown> | null }>
    return userTurn ?? null
  }

  return { persistedPlan, waitForPersistedPlan, reconciledConflictPlan, persistPlanStatus, planOriginUserTurn }
}
