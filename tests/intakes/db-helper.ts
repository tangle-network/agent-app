/**
 * Shared in-memory SQLite + drizzle fixture for the intakes DB tests. Generates
 * real DDL (columns, FKs with ON DELETE, indexes) from the drizzle table
 * definitions and opens a `:memory:` better-sqlite3 db with foreign keys ON, so
 * the tests exercise the actual FK/cascade graph the factory produces — not a
 * hand-rolled schema. Mirrors the teams test harness.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableName, is, SQL } from 'drizzle-orm'
import { getTableConfig, sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteTable, ForeignKey, SQLiteColumn } from 'drizzle-orm/sqlite-core'

const dialect = new SQLiteSyncDialect()

export const usersTable = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})

export const workspacesTable = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
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

export function tableDdl(table: AnySQLiteTable): string[] {
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
    statements.push(`CREATE ${idx.config.unique ? 'UNIQUE ' : ''}INDEX "${idx.config.name}" ON "${config.name}" (${columns})`)
  }
  return statements
}

export function openDatabase(allTables: AnySQLiteTable[]) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const table of allTables) {
    for (const statement of tableDdl(table)) sqlite.exec(statement)
  }
  return drizzle(sqlite)
}
