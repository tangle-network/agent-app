/**
 * A D1 binding over better-sqlite3, with D1's 100-parameter cap and the
 * `meta.rows_read` it reports, for the launch-invariant checks' own tests.
 */
import Database from 'better-sqlite3'

export interface SqliteD1 {
  sqlite: Database.Database
  d1: {
    prepare(sql: string): SqliteStatement
    batch(statements: SqliteStatement[]): Promise<unknown[]>
  }
}

interface SqliteStatement {
  bind(...values: unknown[]): SqliteStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: { rows_read: number } }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ success: true; meta: { changes: number; rows_read: number } }>
  raw(): Promise<unknown[][]>
}

export function sqliteD1(schema = ''): SqliteD1 {
  const sqlite = new Database(':memory:')
  if (schema) sqlite.exec(schema)
  const statement = (sql: string, values: unknown[] = []): SqliteStatement => ({
    bind(...next) {
      if (next.length > 100) throw new Error('D1_ERROR: too many SQL variables')
      return statement(sql, next)
    },
    async all<T>() {
      const results = sqlite.prepare(sql).all(...values) as T[]
      return { results, meta: { rows_read: results.length } }
    },
    async first<T>() {
      return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null
    },
    async run() {
      const info = sqlite.prepare(sql).run(...values)
      return { success: true as const, meta: { changes: info.changes, rows_read: 0 } }
    },
    async raw() {
      return sqlite.prepare(sql).raw().all(...values) as unknown[][]
    },
  })
  return {
    sqlite,
    d1: {
      prepare: (sql) => statement(sql),
      async batch(statements) {
        return Promise.all(statements.map((stmt) => stmt.run()))
      },
    },
  }
}
