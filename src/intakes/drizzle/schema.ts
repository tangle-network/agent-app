/**
 * Drizzle schema factory for the intake tables. The product owns the user (and
 * optionally workspace) tables; this factory creates the intake tables and
 * wires their foreign keys into the passed-in tables so the whole graph lives
 * in one drizzle schema with real cascade semantics.
 *
 * Two tables, two scopes:
 *   - `user_intake`    — the one-time onboarding interview, keyed on `user.id`
 *     (UNIQUE per user: one onboarding payload per user). ALWAYS created.
 *   - `project_intake` — the structured intake attached to a workspace, keyed
 *     on `workspace.id` (UNIQUE per workspace). Created ONLY when a
 *     `workspaceTable` is passed.
 *
 * `workspaceTable` is OPTIONAL by design: a non-workspace app (a single-user
 * tool, tax-without-workspaces) adopts per-user onboarding alone with zero
 * teams and zero workspace concept. When omitted, `createIntakeTables` returns
 * `{ userIntake }` and no `projectIntake` — the FK to a workspace table that
 * does not exist is never created.
 *
 * Imports `drizzle-orm` at module top — that is WHY this lives behind the
 * `/intakes/drizzle` sub-subpath. The pure `./intakes` leaf imports none of
 * this, so a consumer that never touches the DB never pulls the optional peer.
 */

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'

/** A product table referenced by FK — only the `id` column is touched. */
export type IntakeParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

export interface CreateIntakeTablesOptions {
  /** The product's user table — user-intake rows reference `userTable.id`. */
  userTable: IntakeParentTable
  /**
   * The product's workspace table — project-intake rows reference
   * `workspaceTable.id`. OPTIONAL: omit it for a single-user / non-workspace
   * app that wants per-user onboarding only. When omitted, no `projectIntake`
   * table is created.
   */
  workspaceTable?: IntakeParentTable
}

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

const createdAt = () => integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

const updatedAt = () => integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

function createUserIntakeTable(userTable: IntakeParentTable) {
  return sqliteTable('user_intake', {
    id: hexId(),
    userId: text('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    /** The intake definition id the payload was collected against. */
    graphId: text('graph_id').notNull(),
    /** The IntakePayload JSON blob. */
    payload: text('payload', { mode: 'json' }).notNull(),
    /** Set when the user finishes the onboarding interview; null while open. */
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    uniqueIndex('uniq_user_intake_user').on(table.userId),
  ])
}

function createProjectIntakeTable(workspaceTable: IntakeParentTable) {
  return sqliteTable('project_intake', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    graphId: text('graph_id').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    uniqueIndex('uniq_project_intake_workspace').on(table.workspaceId),
    index('idx_project_intake_graph').on(table.graphId),
  ])
}

/**
 * Build the intake tables wired to the product's tables. Always returns
 * `userIntake`; returns `projectIntake` only when `workspaceTable` is passed.
 * The return type carries `projectIntake?` so a consumer that passes no
 * workspace table cannot reference a table that does not exist.
 */
export function createIntakeTables<O extends CreateIntakeTablesOptions>(
  opts: O,
): IntakeTables<O> {
  const userIntake = createUserIntakeTable(opts.userTable)
  const result: { userIntake: ReturnType<typeof createUserIntakeTable>; projectIntake?: ReturnType<typeof createProjectIntakeTable> } = {
    userIntake,
  }
  if (opts.workspaceTable) {
    result.projectIntake = createProjectIntakeTable(opts.workspaceTable)
  }
  return result as IntakeTables<O>
}

export type UserIntakeTable = ReturnType<typeof createUserIntakeTable>
export type ProjectIntakeTable = ReturnType<typeof createProjectIntakeTable>

/**
 * The tables returned for a given options shape: `projectIntake` is present in
 * the type exactly when `workspaceTable` was provided.
 */
export type IntakeTables<O extends CreateIntakeTablesOptions> =
  O extends { workspaceTable: IntakeParentTable }
    ? { userIntake: UserIntakeTable; projectIntake: ProjectIntakeTable }
    : { userIntake: UserIntakeTable; projectIntake?: ProjectIntakeTable }

/** The union table shape, for code that handles either scope generically. */
export type AnyIntakeTables = { userIntake: UserIntakeTable; projectIntake?: ProjectIntakeTable }

export type UserIntakeRow = UserIntakeTable['$inferSelect']
export type ProjectIntakeRow = ProjectIntakeTable['$inferSelect']
