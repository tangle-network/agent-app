import Database from 'better-sqlite3'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { createRecordTable } from '../../src/record/drizzle'
import { openDatabase, reviewersTable, scopesTable, sourcesTable, tableStatements } from './db-helper'

const table = createRecordTable({
  tableName: 'demo_entry',
  scopeTable: scopesTable,
  sourceTable: sourcesTable,
  reviewerTable: reviewersTable,
})

describe('key columns carry sentinels, never NULL', () => {
  it('marks dimension, item_key and period NOT NULL with a default', () => {
    const config = getTableConfig(table)
    for (const name of ['dimension', 'item_key', 'period']) {
      const column = config.columns.find((candidate) => candidate.name === name)
      expect(column, `${name} column`).toBeDefined()
      expect(column?.notNull, `${name} NOT NULL`).toBe(true)
      expect(column?.default, `${name} default`).toBeDefined()
    }
  })

  it('a nullable key column would NOT dedupe — which is why the sentinels exist', () => {
    // SQLite treats every NULL as distinct inside a unique index. This is the
    // hazard the sentinels avoid, asserted against the real engine so the rule
    // is not folklore.
    const sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE nullable_key (a TEXT, b TEXT)')
    sqlite.exec('CREATE UNIQUE INDEX nullable_key_uidx ON nullable_key (a, b)')
    sqlite.prepare('INSERT INTO nullable_key (a, b) VALUES (?, ?)').run('k', null)
    sqlite.prepare('INSERT INTO nullable_key (a, b) VALUES (?, ?)').run('k', null)
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM nullable_key').get() as { n: number }
    expect(rows.n).toBe(2)

    sqlite.exec("CREATE TABLE sentinel_key (a TEXT NOT NULL, b TEXT NOT NULL DEFAULT '')")
    sqlite.exec('CREATE UNIQUE INDEX sentinel_key_uidx ON sentinel_key (a, b)')
    sqlite.prepare('INSERT INTO sentinel_key (a, b) VALUES (?, ?)').run('k', '')
    expect(() => sqlite.prepare('INSERT INTO sentinel_key (a, b) VALUES (?, ?)').run('k', '')).toThrow(/UNIQUE/)
  })
})

describe('the live-head index is partial', () => {
  it('renders its predicate, so it constrains only accepted live rows', () => {
    const statements = tableStatements(table)
    const headIndex = statements.find((statement) => statement.includes('demo_entry_live_head_uidx'))
    expect(headIndex).toBeDefined()
    expect(headIndex).toContain('UNIQUE INDEX')
    expect(headIndex).toContain("WHERE review_state = 'accepted' AND superseded_by_id IS NULL")
    expect(headIndex).toContain('"scope_id", "dimension", "path", "item_key", "period"')
  })

  it('refuses a second live accepted row on one key but allows proposed siblings', () => {
    const db = openDatabase([scopesTable, sourcesTable, reviewersTable, table])
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session.client
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w1', 'W')

    const insert = sqlite.prepare(
      `INSERT INTO demo_entry
        (id, scope_id, seq, dimension, period, path, item_key, value_json, affirmed_empty, review_state, conflict, source_kind, created_at)
       VALUES (?, 'w1', ?, '', 0, 'p', '', '1', 0, ?, 0, 'direct', 0)`,
    )
    insert.run('a', 1, 'accepted')
    expect(() => insert.run('b', 2, 'accepted')).toThrow(/UNIQUE/)
    expect(() => insert.run('c', 3, 'proposed')).not.toThrow()
    expect(() => insert.run('d', 4, 'rejected')).not.toThrow()
  })

  it('frees the key once the head is superseded', () => {
    const db = openDatabase([scopesTable, sourcesTable, reviewersTable, table])
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session.client
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w1', 'W')
    const insert = sqlite.prepare(
      `INSERT INTO demo_entry
        (id, scope_id, seq, dimension, period, path, item_key, value_json, affirmed_empty, review_state, conflict, source_kind, created_at)
       VALUES (?, 'w1', ?, '', 0, 'p', '', '1', 0, 'accepted', 0, 'direct', 0)`,
    )
    insert.run('a', 1)
    sqlite.prepare('UPDATE demo_entry SET superseded_by_id = ? WHERE id = ?').run('b', 'a')
    expect(() => insert.run('b', 2)).not.toThrow()
  })
})

describe('per-scope sequence', () => {
  it('is unique inside a scope and independent across scopes', () => {
    const db = openDatabase([scopesTable, sourcesTable, reviewersTable, table])
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session.client
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w1', 'W1')
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w2', 'W2')
    const insert = sqlite.prepare(
      `INSERT INTO demo_entry
        (id, scope_id, seq, dimension, period, path, item_key, value_json, affirmed_empty, review_state, conflict, source_kind, created_at)
       VALUES (?, ?, ?, '', 0, ?, '', '1', 0, 'proposed', 0, 'direct', 0)`,
    )
    insert.run('a', 'w1', 1, 'p1')
    expect(() => insert.run('b', 'w1', 1, 'p2')).toThrow(/UNIQUE/)
    expect(() => insert.run('c', 'w2', 1, 'p1')).not.toThrow()
  })
})

describe('foreign keys', () => {
  it('cascades entries with their scope', () => {
    const db = openDatabase([scopesTable, sourcesTable, reviewersTable, table])
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session.client
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w1', 'W')
    sqlite.prepare(
      `INSERT INTO demo_entry
        (id, scope_id, seq, dimension, period, path, item_key, value_json, affirmed_empty, review_state, conflict, source_kind, created_at)
       VALUES ('a', 'w1', 1, '', 0, 'p', '', '1', 0, 'proposed', 0, 'direct', 0)`,
    ).run()
    sqlite.prepare('DELETE FROM workspace WHERE id = ?').run('w1')
    const remaining = sqlite.prepare('SELECT COUNT(*) AS n FROM demo_entry').get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('leaves superseded_by_id unconstrained, because the marking write precedes the replacement insert', () => {
    const config = getTableConfig(table)
    const referenced = config.foreignKeys.map((fk) => fk.reference().columns.map((column) => column.name)).flat()
    expect(referenced).toContain('scope_id')
    expect(referenced).toContain('source_ref')
    expect(referenced).toContain('reviewed_by')
    expect(referenced).not.toContain('superseded_by_id')
  })

  it('omits the optional foreign keys when no parent table is supplied', () => {
    const bare = createRecordTable({ tableName: 'bare_entry', scopeTable: scopesTable })
    const config = getTableConfig(bare)
    const referenced = config.foreignKeys.map((fk) => fk.reference().columns.map((column) => column.name)).flat()
    expect(referenced).toEqual(['scope_id'])
    expect(config.columns.map((column) => column.name)).toContain('source_ref')
    expect(config.columns.map((column) => column.name)).toContain('reviewed_by')
  })
})

describe('table naming', () => {
  it('names the table and derives every index name from it, so two record tables coexist', () => {
    const other = createRecordTable({ tableName: 'other_entry', scopeTable: scopesTable })
    const config = getTableConfig(other)
    expect(config.name).toBe('other_entry')
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([
      'other_entry_live_head_uidx',
      'other_entry_scope_path_idx',
      'other_entry_scope_period_idx',
      'other_entry_scope_review_idx',
      'other_entry_scope_seq_uidx',
    ])
  })

  it('both tables build side by side in one database', () => {
    const other = createRecordTable({ tableName: 'other_entry', scopeTable: scopesTable })
    expect(() => openDatabase([scopesTable, sourcesTable, reviewersTable, table, other])).not.toThrow()
  })
})

describe('product columns', () => {
  const messagesTable = sqliteTable('chat_message', {
    id: text('id').primaryKey(),
    body: text('body').notNull(),
  })

  const twoRefTable = createRecordTable({
    tableName: 'two_ref_entry',
    scopeTable: scopesTable,
    reviewerTable: reviewersTable,
    // The shape the single built-in `source_ref` cannot express: two refs side
    // by side, each with its own foreign key, because a chat-sourced row cites
    // a message and a document-sourced row cites a document.
    extraColumns: {
      sourceDocumentId: text('source_document_id').references(() => sourcesTable.id, { onDelete: 'set null' }),
      sourceMessageId: text('source_message_id').references(() => messagesTable.id, { onDelete: 'set null' }),
    },
  })

  it('emits the product columns with their own foreign keys and delete behaviour', () => {
    const config = getTableConfig(twoRefTable)
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['source_document_id', 'source_message_id']),
    )
    const refs = config.foreignKeys
      .map((fk) => ({
        column: fk.reference().columns[0]?.name,
        table: getTableName(fk.reference().foreignTable),
        onDelete: fk.onDelete,
      }))
      .filter((entry) => entry.column === 'source_document_id' || entry.column === 'source_message_id')
      .sort((a, b) => (a.column ?? '').localeCompare(b.column ?? ''))
    expect(refs).toEqual([
      { column: 'source_document_id', table: 'source_document', onDelete: 'set null' },
      { column: 'source_message_id', table: 'chat_message', onDelete: 'set null' },
    ])
  })

  it('names them on the returned table, so a product query type-checks', () => {
    expect(twoRefTable.sourceDocumentId.name).toBe('source_document_id')
    expect(twoRefTable.sourceMessageId.name).toBe('source_message_id')
    // …without erasing the store's own columns from the inferred shape.
    expect(twoRefTable.reviewState.name).toBe('review_state')
    expect(twoRefTable.seq.name).toBe('seq')
  })

  it('refuses a product column that would shadow one the store owns', () => {
    expect(() =>
      createRecordTable({
        tableName: 'shadowed_entry',
        scopeTable: scopesTable,
        extraColumns: { path: text('path'), reviewState: text('review_state') },
      }),
    ).toThrow(/may not redefine the store's own columns — path, reviewState/)
  })

  it('builds in a real database alongside the parent tables', () => {
    expect(() => openDatabase([scopesTable, sourcesTable, reviewersTable, messagesTable, twoRefTable])).not.toThrow()
  })
})
