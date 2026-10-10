/**
 * Export every D1 (SQLite) table that belongs to a workspace, without a
 * hand-kept list that silently falls behind new migrations.
 *
 * Tables are discovered from the schema. A table with one of the workspace
 * columns is exported by that column; a table reached through a parent is
 * exported by the `scoped` SQL the product supplies. Every other table is
 * listed in the coverage report as `excluded` (with the product's reason) or
 * `unscoped`, so a reviewer sees exactly what the export leaves out.
 */

import type { ExportDataClass, ExportRow, ExportRowsSource } from './types'

/** The slice of Cloudflare's `D1Database` used here. */
export interface D1ExportDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
    }
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  }
}

export interface D1TableCoverage {
  table: string
  status: 'exported' | 'excluded' | 'unscoped'
  /** The column or SQL used, or why the table is left out. */
  detail?: string
}

export interface D1WorkspaceTablesOptions {
  db: D1ExportDatabase
  workspaceId: string
  /** Columns that hold the workspace id, checked in order, e.g. `['workspace_id']`. */
  workspaceColumns: readonly string[]
  /**
   * Tables keyed through a parent. The value is a WHERE clause; every `?` binds
   * the workspace id. Example: `{ message: 'thread_id IN (SELECT id FROM thread WHERE workspace_id = ?)' }`.
   */
  scoped?: Readonly<Record<string, string>>
  /** Tables left out on purpose, with the reason recorded in coverage. */
  exclude?: Readonly<Record<string, string>>
  /** Per-table columns to drop beyond the automatic credential policy. */
  omitColumns?: Readonly<Record<string, readonly string[]>>
  /** Per-table row rewrite, e.g. to decrypt a product-encrypted column. */
  transform?: Readonly<Record<string, (row: ExportRow) => ExportRow | Promise<ExportRow>>>
  /** Data class per table. Defaults to `records`. */
  classify?: (table: string) => ExportDataClass
  /** Rows per query. Default 500. */
  pageSize?: number
}

const INTERNAL = /^(sqlite_|_cf_|d1_|__drizzle|_litestream)/

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function sourceName(table: string): string {
  return table.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^[^a-z0-9]+/, '') || 'table'
}

/** Discover workspace tables. Returns row sources and a coverage report for the manifest. */
export async function d1WorkspaceTables(
  options: D1WorkspaceTablesOptions,
): Promise<{ sources: ExportRowsSource[]; coverage: D1TableCoverage[] }> {
  const { db, workspaceId } = options
  const pageSize = options.pageSize ?? 500
  const tables = (
    await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`).all<{ name: string; sql: string | null }>()
  ).results.filter((t) => !INTERNAL.test(t.name))

  const sources: ExportRowsSource[] = []
  const coverage: D1TableCoverage[] = []
  for (const { name: table, sql } of tables) {
    const excluded = options.exclude?.[table]
    if (excluded !== undefined) {
      coverage.push({ table, status: 'excluded', detail: excluded })
      continue
    }
    let where = options.scoped?.[table]
    let detail = where
    if (!where) {
      const columns = (await db.prepare(`PRAGMA table_info(${quote(table)})`).all<{ name: string }>()).results.map((c) => c.name)
      const column = options.workspaceColumns.find((c) => columns.includes(c))
      if (!column) {
        coverage.push({ table, status: 'unscoped' })
        continue
      }
      where = `${quote(column)} = ?`
      detail = column
    }
    coverage.push({ table, status: 'exported', detail })

    const binds = Array.from({ length: (where.match(/\?/g) ?? []).length }, () => workspaceId)
    const hasRowid = !/WITHOUT\s+ROWID/i.test(sql ?? '')
    const transform = options.transform?.[table]
    sources.push({
      kind: 'rows',
      name: `db.${sourceName(table)}`,
      dataClass: options.classify?.(table) ?? 'records',
      description: `D1 table ${table} where ${detail}`,
      omitColumns: options.omitColumns?.[table],
      async expectedCount() {
        const result = await db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${where}`).bind(...binds).all<{ n: number }>()
        return Number(result.results[0]?.n ?? 0)
      },
      async *rows() {
        // Keyset pagination on rowid keeps each page an index seek; tables
        // without a rowid fall back to OFFSET.
        let after = Number.MIN_SAFE_INTEGER
        let offset = 0
        for (;;) {
          const page = hasRowid
            ? await db
                .prepare(`SELECT rowid AS "__export_rowid", * FROM ${quote(table)} WHERE (${where}) AND rowid > ? ORDER BY rowid LIMIT ?`)
                .bind(...binds, after, pageSize)
                .all<ExportRow>()
            : await db
                .prepare(`SELECT * FROM ${quote(table)} WHERE ${where} LIMIT ? OFFSET ?`)
                .bind(...binds, pageSize, offset)
                .all<ExportRow>()
          const rows = page.results
          if (!rows.length) return
          const out: ExportRow[] = []
          for (const row of rows) {
            if (hasRowid) {
              after = Number(row.__export_rowid)
              delete row.__export_rowid
            }
            out.push(transform ? await transform(row) : row)
          }
          offset += rows.length
          yield out
          if (rows.length < pageSize) return
        }
      },
    })
  }
  return { sources, coverage }
}
