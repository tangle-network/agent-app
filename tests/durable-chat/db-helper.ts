/**
 * Real-SQLite fixture for the durable-chat store tests.
 *
 * Generates DDL from the drizzle table definitions and opens a better-sqlite3
 * database, so the tests exercise the schema the factory actually produces
 * rather than a hand-written approximation.
 *
 * ## Why this is not a copy of `tests/teams/db-helper.ts`
 *
 * That generator emits columns, foreign keys and indexes only. It silently drops
 * composite `primaryKey()` declarations, `uniqueConstraints`, and the `WHERE`
 * clause of a partial index. For a store whose entire correctness argument rests
 * on `ON CONFLICT` hitting a unique index, a silently-missing constraint means
 * every compare-and-set test passes against a database that cannot enforce the
 * thing under test — a false green of the worst kind. So this version emits all
 * three, and `drizzle-schema.test.ts` asserts the constraints are really there.
 *
 * `openWorkerDatabases` backs the concurrency cases: a shared file in WAL mode
 * with independent connections, because with the synchronous in-memory driver a
 * `Promise.all` of two claims simply serializes and proves nothing about racing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableName, is, SQL } from 'drizzle-orm'
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteTable, ForeignKey, SQLiteColumn } from 'drizzle-orm/sqlite-core'

const dialect = new SQLiteSyncDialect()

function columnDdl(column: SQLiteColumn, hasCompositePrimaryKey: boolean): string {
  const parts = [`"${column.name}" ${column.getSQLType()}`]
  // A column-level PRIMARY KEY cannot coexist with a table-level composite one.
  if (column.primary && !hasCompositePrimaryKey) parts.push('PRIMARY KEY')
  if (column.notNull) parts.push('NOT NULL')
  if (column.default !== undefined) {
    if (is(column.default, SQL)) {
      parts.push(`DEFAULT ${dialect.sqlToQuery(column.default).sql}`)
    } else {
      const driverValue = column.mapToDriverValue(column.default)
      parts.push(typeof driverValue === 'string'
        ? `DEFAULT '${driverValue.replaceAll("'", "''")}'`
        : `DEFAULT ${String(driverValue)}`)
    }
  }
  if ((column as { isUnique?: boolean }).isUnique) parts.push('UNIQUE')
  return parts.join(' ')
}

function foreignKeyDdl(fk: ForeignKey): string {
  const reference = fk.reference()
  const localColumns = reference.columns.map((column) => `"${column.name}"`).join(', ')
  const foreignColumns = reference.foreignColumns.map((column) => `"${column.name}"`).join(', ')
  let clause = `FOREIGN KEY (${localColumns}) REFERENCES "${getTableName(reference.foreignTable)}" (${foreignColumns})`
  if (fk.onDelete) clause += ` ON DELETE ${fk.onDelete}`
  return clause
}

function columnNames(columns: readonly unknown[]): string {
  return columns.map((column) => `"${(column as { name: string }).name}"`).join(', ')
}

/** Full DDL for one table: CREATE TABLE plus every index it declares. */
export function tableDdl(table: AnySQLiteTable): string[] {
  const config = getTableConfig(table)
  const primaryKeys = (config as { primaryKeys?: Array<{ columns: unknown[] }> }).primaryKeys ?? []
  const uniqueConstraints = (config as { uniqueConstraints?: Array<{ name?: string; columns: unknown[] }> }).uniqueConstraints ?? []

  const definitions = [
    ...config.columns.map((column) => columnDdl(column, primaryKeys.length > 0)),
    ...primaryKeys.map((pk) => `PRIMARY KEY (${columnNames(pk.columns)})`),
    ...uniqueConstraints.map((unique) => `UNIQUE (${columnNames(unique.columns)})`),
    ...config.foreignKeys.map(foreignKeyDdl),
  ]

  const statements = [`CREATE TABLE "${config.name}" (${definitions.join(', ')})`]
  for (const idx of config.indexes) {
    const idxConfig = idx.config as {
      name?: string
      unique?: boolean
      columns: unknown[]
      where?: SQL
    }
    if (!idxConfig.name) throw new Error(`index on ${config.name} has no name`)
    let statement = `CREATE ${idxConfig.unique ? 'UNIQUE ' : ''}INDEX "${idxConfig.name}" ON "${config.name}" (${columnNames(idxConfig.columns)})`
    // Partial indexes must keep their predicate, or the test database enforces a
    // stricter constraint than production does.
    if (idxConfig.where) statement += ` WHERE ${dialect.sqlToQuery(idxConfig.where).sql}`
    statements.push(statement)
  }
  return statements
}

function applySchema(sqlite: Database.Database, tables: AnySQLiteTable[]): void {
  sqlite.pragma('foreign_keys = ON')
  for (const table of tables) {
    for (const statement of tableDdl(table)) sqlite.exec(statement)
  }
}

/** One in-memory database. Fast; use for everything that is not a race. */
export function openDatabase(tables: AnySQLiteTable[]) {
  const sqlite = new Database(':memory:')
  applySchema(sqlite, tables)
  return drizzle(sqlite)
}

/** A file-backed database plus N independent connections to it. */
export interface WorkerDatabases {
  /** One drizzle handle per simulated worker, each on its own connection. */
  workers: ReturnType<typeof drizzle>[]
  /** Close every connection and delete the temporary directory. */
  close(): void
}

/**
 * Open `count` independent connections to one WAL-mode SQLite file, so
 * concurrent claims contend for real locks instead of sharing a single
 * JavaScript-level handle.
 */
export function openWorkerDatabases(tables: AnySQLiteTable[], count = 2): WorkerDatabases {
  const dir = mkdtempSync(join(tmpdir(), 'durable-chat-'))
  const file = join(dir, 'durable-chat.sqlite')

  const primary = new Database(file)
  primary.pragma('journal_mode = WAL')
  applySchema(primary, tables)

  const connections = [primary]
  for (let i = 1; i < count; i++) {
    const connection = new Database(file)
    connection.pragma('foreign_keys = ON')
    // Without this a contended write fails immediately with SQLITE_BUSY rather
    // than waiting for the other connection's transaction to land.
    connection.pragma('busy_timeout = 5000')
    connections.push(connection)
  }
  primary.pragma('busy_timeout = 5000')

  return {
    workers: connections.map((connection) => drizzle(connection)),
    close() {
      for (const connection of connections) {
        try { connection.close() } catch { /* already closed */ }
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
