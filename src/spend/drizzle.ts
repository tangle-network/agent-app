/**
 * Drizzle (SQLite / D1) implementations of the spend module's persistence:
 * the expectation-ledger `SpendLedgerStorePort`, the ledger reads a settlement
 * sweep needs, and the per-workspace budget opt-in. This optional subpath keeps
 * the core `./spend` entry free of Drizzle.
 *
 * The product owns its migration. {@link createSpendBoxLedgerTable} builds the
 * standard `spend_box_ledger` table; a product with its own table needs the
 * columns of {@link SpendBoxLedgerTable}. Every timestamp is epoch
 * MILLISECONDS, matching `SpendBoxRecord`, so they are plain `integer` columns
 * (a drizzle `{ mode: 'timestamp' }` column would silently divide by 1000).
 * `openDetachedRunIds` is a JSON-mode text column defaulting to `[]`; `extras`
 * is a nullable JSON-mode text column carrying `{ billingOwnerId }`.
 *
 * `update()` is deliberately NOT a read-modify-write. It runs on the live turn
 * path from a Worker, where two isolates recording activity for the same box
 * are ordinary, so every column is computed in ONE atomic SQL statement using
 * the exact merge rule `foldSpendBoxRecord` states for that field (moves
 * forward only / latest-wins-but-never-behind-activity / set-once). A lost race
 * under a read-modify-write could rewind the ceiling; under this fold a lost
 * race can only tighten it, which surfaces as a false alarm rather than a
 * missed charge.
 */
import { and, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable, BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { DEFAULT_WORKSPACE_SPEND_BUDGET_NANO_USD } from './budget'
import type { SpendLedgerStorePort } from './store'
import type { SpendBoxPatch, SpendBoxRecord, SpendWindow } from './types'

/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit. */
export type SpendDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/** Required Drizzle column properties of the expectation ledger; SQL column
 *  names, foreign keys and indexes remain product-owned. */
export type SpendBoxLedgerTable = AnySQLiteTable & {
  sandboxId: AnySQLiteColumn
  workspaceId: AnySQLiteColumn
  createdAt: AnySQLiteColumn
  idleTimeoutSeconds: AnySQLiteColumn
  maxLifetimeSeconds: AnySQLiteColumn
  lastActivityAt: AnySQLiteColumn
  openDetachedRunIds: AnySQLiteColumn
  stoppedAt: AnySQLiteColumn
  deletedAt: AnySQLiteColumn
  extras: AnySQLiteColumn
}

/**
 * Build the standard `spend_box_ledger` table. With `workspaceTable`, a box row
 * cascades with its workspace; without it, `workspace_id` is a plain column so
 * the ledger outlives a deleted workspace whose boxes may still be on the
 * platform's books.
 */
export function createSpendBoxLedgerTable(options: { workspaceTable?: AnySQLiteTable & { id: AnySQLiteColumn } } = {}) {
  const { workspaceTable } = options
  return sqliteTable('spend_box_ledger', {
    sandboxId: text('sandbox_id').primaryKey(),
    workspaceId: workspaceTable
      ? text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' })
      : text('workspace_id').notNull(),
    createdAt: integer('created_at').notNull(),
    idleTimeoutSeconds: integer('idle_timeout_seconds').notNull(),
    maxLifetimeSeconds: integer('max_lifetime_seconds'),
    lastActivityAt: integer('last_activity_at').notNull(),
    openDetachedRunIds: text('open_detached_run_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    stoppedAt: integer('stopped_at'),
    deletedAt: integer('deleted_at'),
    // Opaque product columns written verbatim on insert: `billingOwnerId`, the
    // platform user whose wallet the box bills, which the platform's own
    // settlement row does not name.
    extras: text('extras', { mode: 'json' }).$type<Record<string, unknown>>(),
  }, (table) => [
    index('idx_spend_box_ledger_workspace').on(table.workspaceId),
  ])
}

/** The ledger a store or query reads: a database and the product's table. */
export interface SpendLedgerTableOptions {
  readonly db: SpendDatabase
  readonly table: SpendBoxLedgerTable
}

interface SpendBoxLedgerRow {
  sandboxId: string
  workspaceId: string
  createdAt: number
  idleTimeoutSeconds: number
  maxLifetimeSeconds: number | null
  lastActivityAt: number
  openDetachedRunIds: string[] | null
  stoppedAt: number | null
  deletedAt: number | null
  extras: Record<string, unknown> | null
}

function rowToRecord(row: SpendBoxLedgerRow): SpendBoxRecord {
  return {
    sandboxId: row.sandboxId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    maxLifetimeSeconds: row.maxLifetimeSeconds,
    lastActivityAt: row.lastActivityAt,
    openDetachedRunIds: row.openDetachedRunIds ?? [],
    stoppedAt: row.stoppedAt,
    deletedAt: row.deletedAt,
    ...(row.extras ? { extras: row.extras } : {}),
  }
}

/** Build the expectation-ledger store over the product's drizzle table. */
export function createDrizzleSpendStore(options: SpendLedgerTableOptions): SpendLedgerStorePort {
  const { db, table } = options

  async function load(sandboxId: string): Promise<SpendBoxRecord | null> {
    const [row] = await db.select().from(table).where(eq(table.sandboxId, sandboxId)).limit(1)
    return row ? rowToRecord(row as SpendBoxLedgerRow) : null
  }

  return {
    load,

    /**
     * Every box that could have been live at some point inside `window`.
     *
     * Deliberately COARSE: the box existed by the window's end and was not
     * recorded deleted before it began. The reconciler re-derives liveness from
     * the same fold `computeExpectedCeiling` uses (delete, stop, open detached
     * run, last activity plus idle timeout, capped by max lifetime), so this
     * only has to be a superset it can filter down. Encoding the real rule here
     * would put a second definition of "live" in SQL, free to drift from the one
     * the ceiling check uses. `stopped_at` is therefore not a filter: later
     * activity can clear a stop, and the fold decides which stop closed the box.
     *
     * Over-returning is correct; under-returning is the only real failure — a
     * box this query omits is a box the pass never notices went unbilled.
     */
    async listLiveBetween(window: SpendWindow): Promise<readonly SpendBoxRecord[]> {
      const rows = await db
        .select()
        .from(table)
        .where(and(lte(table.createdAt, window.endAt), or(isNull(table.deletedAt), gte(table.deletedAt, window.startAt))))
      return rows.map((row) => rowToRecord(row as SpendBoxLedgerRow))
    },

    async insert(record: SpendBoxRecord, extras?: Record<string, unknown>): Promise<SpendBoxRecord> {
      const [row] = await db
        .insert(table)
        .values({
          sandboxId: record.sandboxId,
          workspaceId: record.workspaceId,
          createdAt: record.createdAt,
          idleTimeoutSeconds: record.idleTimeoutSeconds,
          maxLifetimeSeconds: record.maxLifetimeSeconds,
          lastActivityAt: record.lastActivityAt,
          openDetachedRunIds: [...record.openDetachedRunIds],
          stoppedAt: record.stoppedAt,
          deletedAt: record.deletedAt,
          // Written in the SAME statement — a second UPDATE to attach extras
          // would leave a window where the reconciler cannot tell whose wallet
          // this box bills.
          extras: extras ?? null,
        } as never)
        .returning()
      return rowToRecord(row as SpendBoxLedgerRow)
    },

    async update(sandboxId: string, patch: SpendBoxPatch): Promise<SpendBoxRecord | null> {
      const hasActivity = patch.observedActivityAt !== undefined
      const hasStop = patch.stoppedAt !== undefined
      const activityValue = patch.observedActivityAt
      const stopValue = patch.stoppedAt

      const set: Partial<Record<keyof SpendBoxLedgerRow, SQL>> = {}

      // last_activity_at moves forward only. SQLite's two-argument MAX() is the
      // SCALAR max, not the aggregate, so this needs no GROUP BY — and a
      // replayed or out-of-order event therefore cannot rewind the ceiling.
      if (hasActivity) {
        set.lastActivityAt = sql`MAX(${table.lastActivityAt}, ${activityValue})`
      }

      // stopped_at is touched whenever activity might CLEAR it (work observed
      // after a recorded stop means the box is running again, and keeping the
      // stale stop would invent an over-ceiling finding out of the product's
      // own bookkeeping) or a new stop is being recorded (latest-wins, but never
      // behind the newly computed activity — a stop reported behind observed
      // work is not the stop that closed this box, so it does not move the column).
      //
      // The "new last_activity_at" sub-expression is repeated verbatim rather
      // than referenced, because SQLite evaluates every SET-clause expression
      // against the row's PRE-update values: one clause can never see
      // another's result.
      if (hasActivity || hasStop) {
        const newLastActivityAtExpr = hasActivity
          ? sql`MAX(${table.lastActivityAt}, ${activityValue})`
          : sql`${table.lastActivityAt}`
        const afterActivityClearExpr = hasActivity
          ? sql`(CASE WHEN ${table.stoppedAt} IS NOT NULL AND ${activityValue} > ${table.stoppedAt} THEN NULL ELSE ${table.stoppedAt} END)`
          : sql`${table.stoppedAt}`
        set.stoppedAt = hasStop
          ? sql`(CASE WHEN ${stopValue} >= (${newLastActivityAtExpr}) THEN ${stopValue} ELSE ${afterActivityClearExpr} END)`
          : afterActivityClearExpr
      }

      // deleted_at is set-once: a deleted sandbox id never returns, so a second
      // observation is duplicate delivery, not a second deletion.
      if (patch.deletedAt !== undefined) {
        set.deletedAt = sql`COALESCE(${table.deletedAt}, ${patch.deletedAt})`
      }

      // open_detached_run_ids is a SET encoded as a JSON array. Add is
      // insert-if-absent; remove rebuilds the array excluding the value. Both
      // read and write the same column expression inside one statement, and the
      // remove chains off whatever the add branch produced so the fold's own
      // field order holds: a patch that both adds and removes the same id nets
      // to removed.
      let runIdsExpr: SQL | undefined
      if (patch.openDetachedRunAdd !== undefined) {
        runIdsExpr = sql`(
          CASE
            WHEN EXISTS (SELECT 1 FROM json_each(${table.openDetachedRunIds}) WHERE value = ${patch.openDetachedRunAdd})
            THEN ${table.openDetachedRunIds}
            ELSE json_insert(${table.openDetachedRunIds}, '$[#]', ${patch.openDetachedRunAdd})
          END
        )`
      }
      if (patch.openDetachedRunRemove !== undefined) {
        const source = runIdsExpr ?? sql`${table.openDetachedRunIds}`
        runIdsExpr = sql`(
          SELECT COALESCE(json_group_array(value), '[]') FROM json_each(${source}) WHERE value != ${patch.openDetachedRunRemove}
        )`
      }
      if (runIdsExpr) set.openDetachedRunIds = runIdsExpr

      // A patch with every field undefined is a no-op — return the current row
      // rather than issuing an empty UPDATE.
      if (Object.keys(set).length === 0) return await load(sandboxId)

      const rows = await db
        .update(table)
        .set(set as never)
        .where(eq(table.sandboxId, sandboxId))
        .returning()
      // Absent row returns null, never a throw: the ledger legitimately does
      // not know every box (see the `unknown-box` finding class).
      const [row] = rows as SpendBoxLedgerRow[]
      return row ? rowToRecord(row) : null
    },
  }
}

/** Every distinct platform-user id the ledger has recorded as a box's
 *  `extras.billingOwnerId` — the set of wallets a full pass needs to read. */
export async function listLedgerBillingOwnerIds(options: SpendLedgerTableOptions): Promise<string[]> {
  const { db, table } = options
  const rows = await db
    .select({ billingOwnerId: sql<string | null>`json_extract(${table.extras}, '$.billingOwnerId')` })
    .from(table)
    .where(sql`json_extract(${table.extras}, '$.billingOwnerId') IS NOT NULL`)
  return [...new Set(rows.map((row) => row.billingOwnerId).filter((id): id is string => Boolean(id)))]
}

/** Every sandbox id the ledger attributes to this workspace — the only place
 *  the workspace-to-sandbox mapping exists; the platform does not model a workspace. */
export async function listWorkspaceSandboxIds(
  options: SpendLedgerTableOptions & { readonly workspaceId: string },
): Promise<Set<string>> {
  const { db, table, workspaceId } = options
  const rows = await db.select({ sandboxId: table.sandboxId }).from(table).where(eq(table.workspaceId, workspaceId))
  return new Set(rows.map((row) => row.sandboxId as string))
}

/** The product's workspace table columns holding the compute-budget opt-in. */
export type SpendBudgetWorkspaceTable = AnySQLiteTable & {
  id: AnySQLiteColumn
  spendBudgetEnabled: AnySQLiteColumn
  spendBudgetLimitNanoUsd: AnySQLiteColumn
}

export interface WorkspaceSpendBudgetConfig {
  readonly enabled: boolean
  readonly limitNanoUsd: number
}

/**
 * Opt-in per-workspace budget read. Absent or disabled — the default for every
 * workspace until it opts in — short-circuits the caller before any settlement
 * read runs, so an unopted workspace's provisioning path makes no extra network
 * call. A null limit falls back to {@link DEFAULT_WORKSPACE_SPEND_BUDGET_NANO_USD}.
 */
export async function loadWorkspaceSpendBudgetConfig(options: {
  readonly db: SpendDatabase
  readonly workspaces: SpendBudgetWorkspaceTable
  readonly workspaceId: string
}): Promise<WorkspaceSpendBudgetConfig> {
  const { db, workspaces, workspaceId } = options
  const [row] = await db
    .select({ enabled: workspaces.spendBudgetEnabled, limit: workspaces.spendBudgetLimitNanoUsd })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return {
    enabled: (row?.enabled as boolean | null | undefined) ?? false,
    limitNanoUsd: (row?.limit as number | null | undefined) ?? DEFAULT_WORKSPACE_SPEND_BUDGET_NANO_USD,
  }
}
