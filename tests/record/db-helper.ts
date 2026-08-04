/**
 * In-memory SQLite + drizzle fixture for the record DB tests. DDL is generated
 * from the drizzle table definitions the factory returns, so the tests run
 * against the REAL columns, foreign keys and indexes a consumer would migrate.
 *
 * It differs from the intakes/teams harness in one load-bearing way: it renders
 * an index's `WHERE` clause. The record table's live-head guarantee is a
 * PARTIAL unique index, and a harness that dropped the predicate would create a
 * unique index over every row — turning a test of "one live head per key" into a
 * test of "one row per key ever", which the store's own behavior would fail for
 * unrelated reasons. Dropping it the other way (rendering no index at all) is
 * worse: the concurrency tests would pass with no constraint enforcing anything.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableName, is, SQL } from 'drizzle-orm'
import { getTableConfig, sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteTable, ForeignKey, SQLiteColumn } from 'drizzle-orm/sqlite-core'

const dialect = new SQLiteSyncDialect()

export const scopesTable = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const sourcesTable = sqliteTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

export const reviewersTable = sqliteTable('app_user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

function columnDdl(column: SQLiteColumn): string {
  const parts = [`"${column.name}" ${column.getSQLType()}`]
  if (column.primary) parts.push('PRIMARY KEY')
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

function tableDdl(table: AnySQLiteTable): string[] {
  const config = getTableConfig(table)
  const definitions = [
    ...config.columns.map(columnDdl),
    ...config.foreignKeys.map(foreignKeyDdl),
  ]
  const statements = [`CREATE TABLE "${config.name}" (${definitions.join(', ')})`]
  for (const idx of config.indexes) {
    if (!idx.config.name) throw new Error(`index on ${config.name} has no name`)
    const columns = idx.config.columns
      .map((column) => `"${(column as { name: string }).name}"`)
      .join(', ')
    const predicate = idx.config.where ? ` WHERE ${dialect.sqlToQuery(idx.config.where).sql}` : ''
    statements.push(
      `CREATE ${idx.config.unique ? 'UNIQUE ' : ''}INDEX "${idx.config.name}" ON "${config.name}" (${columns})${predicate}`,
    )
  }
  return statements
}

/** Open a `:memory:` database with foreign keys on and the given tables built
 *  from their real drizzle definitions. */
export function openDatabase(allTables: AnySQLiteTable[]) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const table of allTables) {
    for (const statement of tableDdl(table)) sqlite.exec(statement)
  }
  return drizzle(sqlite)
}

/** The DDL a table would produce — asserted directly by the schema tests. */
export function tableStatements(table: AnySQLiteTable): string[] {
  return tableDdl(table)
}

/** The better-sqlite3 handle underneath a drizzle instance, for raw SQL. */
export function rawClient(db: DrizzleDatabase): Database.Database {
  return (db as unknown as { session: { client: Database.Database } }).session.client
}

type DrizzleDatabase = ReturnType<typeof openDatabase>

/**
 * The same database, exposing a real `batch()`.
 *
 * D1 and libsql provide `batch` and it is the ONLY atomic primitive D1 offers;
 * better-sqlite3 provides none. Wrapping the driver's own `BEGIN IMMEDIATE` /
 * `COMMIT` / `ROLLBACK` around a sequential run reproduces D1's contract —
 * every statement commits or none does — against real SQL on a real engine, so
 * the store's production code path is the one under test.
 */
export function withBatchSupport(db: DrizzleDatabase): DrizzleDatabase & {
  batch(statements: [unknown, ...unknown[]]): Promise<unknown[]>
} {
  const sqlite = rawClient(db)
  const batch = async (statements: [unknown, ...unknown[]]): Promise<unknown[]> => {
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await (statement as Promise<unknown>))
      sqlite.exec('COMMIT')
      return results
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'batch') return batch
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(target, prop) {
      return prop === 'batch' || Reflect.has(target, prop)
    },
  }) as DrizzleDatabase & { batch(statements: [unknown, ...unknown[]]): Promise<unknown[]> }
}
