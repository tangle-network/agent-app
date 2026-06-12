import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, getTableName, is, SQL } from 'drizzle-orm'
import { getTableConfig, sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteTable, ForeignKey, SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { createDesignCanvasTables } from '../../src/design-canvas/schema'
import type { DesignCanvasTables } from '../../src/design-canvas/schema'
import { createDrizzleSceneStore } from '../../src/design-canvas/drizzle-store'
import type { DesignCanvasDatabase } from '../../src/design-canvas/drizzle-store'
import { createEmptyDocument } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Fixture: product-owned tables + DDL generated FROM the drizzle table objects
// so the executed schema can never drift from the factory.
// ---------------------------------------------------------------------------

const workspaces = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const tables = createDesignCanvasTables({ workspaceTable: workspaces, userTable: users })

const dialect = new SQLiteSyncDialect()

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
    statements.push(`CREATE ${idx.config.unique ? 'UNIQUE ' : ''}INDEX "${idx.config.name}" ON "${config.name}" (${columns})`)
  }
  return statements
}

function openDatabase(allTables: AnySQLiteTable[]): DesignCanvasDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const table of allTables) {
    for (const statement of tableDdl(table)) sqlite.exec(statement)
  }
  return drizzle(sqlite)
}

// ---------------------------------------------------------------------------
// Shared fixture setup
// ---------------------------------------------------------------------------

const scopeA = { workspaceId: 'ws-a', documentId: 'doc-a', userId: 'user-a' }
const scopeB = { workspaceId: 'ws-b', documentId: 'doc-b', userId: 'user-b' }

async function setup() {
  const db = openDatabase([
    workspaces,
    users,
    tables.designDocuments,
    tables.designDecisions,
    tables.designExports,
  ])
  await db.insert(workspaces).values([
    { id: 'ws-a', name: 'Workspace A' },
    { id: 'ws-b', name: 'Workspace B' },
  ])
  await db.insert(users).values([
    { id: 'user-a', email: 'a@example.com' },
    { id: 'user-b', email: 'b@example.com' },
  ])
  await db.insert(tables.designDocuments).values([
    {
      id: 'doc-a',
      workspaceId: 'ws-a',
      title: 'Document A',
      document: createEmptyDocument('Document A'),
      createdBy: 'user-a',
    },
    {
      id: 'doc-b',
      workspaceId: 'ws-b',
      title: 'Document B',
      document: createEmptyDocument('Document B'),
      createdBy: 'user-b',
    },
  ])
  const storeA = createDrizzleSceneStore({ db, tables, scope: scopeA })
  const storeB = createDrizzleSceneStore({ db, tables, scope: scopeB })
  return { db, storeA, storeB }
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe('createDesignCanvasTables', () => {
  it('generates 32-char hex ids and applies column defaults', async () => {
    const { db } = await setup()
    const [row] = await db.insert(tables.designDocuments).values({
      workspaceId: 'ws-a',
      title: 'Defaults test',
      document: createEmptyDocument('Defaults test'),
      createdBy: 'user-a',
    }).returning()
    expect(row).toBeDefined()
    expect(row!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(row!.rev).toBe(1)
    expect(row!.isTemplate).toBe(false)
    expect(row!.document.title).toBe('Defaults test')
    expect(row!.createdAt).toBeInstanceOf(Date)
    expect(row!.updatedAt).toBeInstanceOf(Date)
  })

  it('cascades deletes from workspace to all child rows', async () => {
    const { db } = await setup()
    await db.delete(workspaces).where(eq(workspaces.id, 'ws-a'))
    const docs = await db.select().from(tables.designDocuments)
      .where(eq(tables.designDocuments.workspaceId, 'ws-a'))
    expect(docs).toHaveLength(0)
    const decisions = await db.select().from(tables.designDecisions)
      .where(eq(tables.designDecisions.workspaceId, 'ws-a'))
    expect(decisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Round-trip and basic getDocument
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — round-trip', () => {
  it('getDocument returns the stored document and rev', async () => {
    const { storeA } = await setup()
    const record = await storeA.getDocument()
    expect(record.rev).toBe(1)
    expect(record.document.title).toBe('Document A')
    expect(record.document.schemaVersion).toBe(1)
    expect(record.document.pages).toHaveLength(1)
  })

  it('saveDocument bumps rev and persists the new document', async () => {
    const { storeA } = await setup()
    const initial = await storeA.getDocument()
    const updated = {
      ...initial.document,
      title: 'Updated Title',
    }
    const saved = await storeA.saveDocument(updated, initial.rev)
    expect(saved.rev).toBe(2)
    expect(saved.document.title).toBe('Updated Title')

    const refetched = await storeA.getDocument()
    expect(refetched.rev).toBe(2)
    expect(refetched.document.title).toBe('Updated Title')
  })

  it('saveDocument increments rev monotonically across multiple saves', async () => {
    const { storeA } = await setup()
    let record = await storeA.getDocument()
    for (let i = 2; i <= 5; i++) {
      record = await storeA.saveDocument({ ...record.document, title: `Rev ${i}` }, record.rev)
      expect(record.rev).toBe(i)
    }
    const final = await storeA.getDocument()
    expect(final.rev).toBe(5)
    expect(final.document.title).toBe('Rev 5')
  })
})

// ---------------------------------------------------------------------------
// Optimistic concurrency — stale rev throws
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — rev conflict', () => {
  it('throws a stale-rev error when two writers race', async () => {
    const { storeA } = await setup()

    // Two writers both read rev 1.
    const record = await storeA.getDocument()
    expect(record.rev).toBe(1)

    // Writer 1 succeeds.
    const w1 = await storeA.saveDocument({ ...record.document, title: 'Writer 1' }, record.rev)
    expect(w1.rev).toBe(2)

    // Writer 2 tries the same expectedRev — must throw.
    await expect(
      storeA.saveDocument({ ...record.document, title: 'Writer 2' }, record.rev),
    ).rejects.toThrow(/Stale revision.*expected rev 1.*rev 2/)
  })

  it('stale error message includes both expected and current rev', async () => {
    const { storeA } = await setup()
    const r = await storeA.getDocument()
    // Advance rev twice.
    const r2 = await storeA.saveDocument({ ...r.document }, r.rev)
    await storeA.saveDocument({ ...r2.document }, r2.rev)
    // Now try to save with the original rev.
    await expect(
      storeA.saveDocument({ ...r.document }, r.rev),
    ).rejects.toThrow(/expected rev 1.*rev 3/)
  })

  it('saveDocument on a missing document throws a not-found error, not stale-rev', async () => {
    const db = openDatabase([workspaces, users, tables.designDocuments, tables.designDecisions, tables.designExports])
    await db.insert(workspaces).values([{ id: 'ws-x', name: 'X' }])
    await db.insert(users).values([{ id: 'user-x', email: 'x@example.com' }])
    const store = createDrizzleSceneStore({
      db,
      tables,
      scope: { workspaceId: 'ws-x', documentId: 'no-such-doc', userId: 'user-x' },
    })
    await expect(
      store.saveDocument(createEmptyDocument('ghost'), 1),
    ).rejects.toThrow(/not found/)
    await expect(
      store.saveDocument(createEmptyDocument('ghost'), 1),
    ).rejects.not.toThrow(/Stale revision/)
  })
})

// ---------------------------------------------------------------------------
// Cross-workspace isolation
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — cross-workspace isolation', () => {
  it('getDocument throws when the document belongs to another workspace', async () => {
    const { db } = await setup()
    // Scope scoped to ws-a but document id is doc-b (owned by ws-b).
    const crossStore = createDrizzleSceneStore({
      db,
      tables,
      scope: { workspaceId: 'ws-a', documentId: 'doc-b', userId: 'user-a' },
    })
    await expect(crossStore.getDocument()).rejects.toThrow(
      'Design document doc-b not found in workspace ws-a',
    )
  })

  it('saveDocument cannot overwrite a document in another workspace', async () => {
    const { storeA, storeB } = await setup()
    // storeB sees doc-b at rev 1; storeA scope tries to save to doc-b.
    const { db } = await setup()
    const crossStore = createDrizzleSceneStore({
      db,
      tables,
      scope: { workspaceId: 'ws-a', documentId: 'doc-b', userId: 'user-a' },
    })
    await expect(
      crossStore.saveDocument(createEmptyDocument('hijack'), 1),
    ).rejects.toThrow(/not found/)
  })

  it('listDecisions only returns decisions for the bound document + workspace', async () => {
    const { storeA, storeB } = await setup()
    await storeA.recordDecision({ kind: 'note', instruction: 'A note' })
    await storeB.recordDecision({ kind: 'note', instruction: 'B note' })

    const decA = await storeA.listDecisions()
    expect(decA).toHaveLength(1)
    expect(decA[0]!.instruction).toBe('A note')

    const decB = await storeB.listDecisions()
    expect(decB).toHaveLength(1)
    expect(decB[0]!.instruction).toBe('B note')
  })

  it('listExports only returns exports for the bound document + workspace', async () => {
    const { storeA, storeB } = await setup()
    await storeA.createExport('png')
    await storeB.createExport('jpeg')

    const exA = await storeA.listExports()
    expect(exA).toHaveLength(1)
    expect(exA[0]!.format).toBe('png')

    const exB = await storeB.listExports()
    expect(exB).toHaveLength(1)
    expect(exB[0]!.format).toBe('jpeg')
  })
})

// ---------------------------------------------------------------------------
// Decision rows
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — decisions', () => {
  it('records decisions with all fields and lists newest-first', async () => {
    const { db, storeA } = await setup()
    const d1 = await storeA.recordDecision({
      kind: 'agent_proposal',
      instruction: 'first',
      reasoningSummary: 'because reasons',
      metadata: { source: 'mcp' },
    })
    const d2 = await storeA.recordDecision({
      kind: 'agent_edit',
      instruction: 'second',
    })
    const d3 = await storeA.recordDecision({
      kind: 'human_edit',
      instruction: 'third',
    })

    expect(d1.id).toMatch(/^[0-9a-f]{32}$/)
    expect(d1.reasoningSummary).toBe('because reasons')
    expect(d1.metadata).toEqual({ source: 'mcp' })
    expect(d2.reasoningSummary).toBeNull()
    expect(d2.metadata).toEqual({})

    const list = await storeA.listDecisions()
    expect(list.map((d) => d.instruction)).toEqual(['third', 'second', 'first'])
    expect(list[0]!.createdAt).toBeInstanceOf(Date)

    // Attribution in the raw row.
    const [rawRow] = await db.select().from(tables.designDecisions)
      .where(eq(tables.designDecisions.instruction, 'second'))
      .limit(1)
    expect(rawRow!.createdBy).toBe('user-a')
    expect(rawRow!.documentId).toBe('doc-a')
    expect(rawRow!.workspaceId).toBe('ws-a')
  })

  it('listDecisions respects the limit', async () => {
    const { storeA } = await setup()
    for (let i = 0; i < 5; i++) {
      await storeA.recordDecision({ kind: 'note', instruction: `note ${i}` })
    }
    const all = await storeA.listDecisions()
    expect(all).toHaveLength(5)
    const limited = await storeA.listDecisions(3)
    expect(limited).toHaveLength(3)
  })

  it('listDecisions rejects a non-positive limit', async () => {
    const { storeA } = await setup()
    await expect(storeA.listDecisions(0)).rejects.toThrow('limit must be a positive integer')
  })

  it('recordDecision fails when document is absent', async () => {
    const db = openDatabase([workspaces, users, tables.designDocuments, tables.designDecisions, tables.designExports])
    await db.insert(workspaces).values([{ id: 'ws-x', name: 'X' }])
    await db.insert(users).values([{ id: 'user-x', email: 'x@example.com' }])
    const store = createDrizzleSceneStore({
      db,
      tables,
      scope: { workspaceId: 'ws-x', documentId: 'ghost-doc', userId: 'user-x' },
    })
    await expect(store.recordDecision({ kind: 'note', instruction: 'orphan' }))
      .rejects.toThrow(/not found/)
  })
})

// ---------------------------------------------------------------------------
// Export rows
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — exports', () => {
  it('queues exports with initial status and lists newest-first', async () => {
    const { storeA } = await setup()
    const png = await storeA.createExport('png', { quality: 3 })
    expect(png.id).toMatch(/^[0-9a-f]{32}$/)
    expect(png.status).toBe('queued')
    expect(png.resultUrl).toBeNull()
    expect(png.metadata).toEqual({ quality: 3 })
    expect(png.createdAt).toBeInstanceOf(Date)

    const jpeg = await storeA.createExport('jpeg')
    expect(jpeg.metadata).toEqual({})

    const list = await storeA.listExports()
    expect(list.map((e) => e.format)).toEqual(['jpeg', 'png'])
  })

  it('createExport for all supported formats', async () => {
    const { storeA } = await setup()
    for (const format of ['png', 'jpeg', 'json'] as const) {
      const record = await storeA.createExport(format)
      expect(record.format).toBe(format)
    }
    const list = await storeA.listExports()
    expect(list).toHaveLength(3)
  })

  it('listExports respects the limit', async () => {
    const { storeA } = await setup()
    await storeA.createExport('png')
    await storeA.createExport('jpeg')
    await storeA.createExport('json')
    const limited = await storeA.listExports(2)
    expect(limited).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// isTemplate flag
// ---------------------------------------------------------------------------

describe('createDrizzleSceneStore — isTemplate flag', () => {
  it('defaults to false and can be set to true at insert', async () => {
    const { db } = await setup()
    const [row] = await db.insert(tables.designDocuments).values({
      workspaceId: 'ws-a',
      title: 'My Template',
      document: createEmptyDocument('My Template'),
      isTemplate: true,
      createdBy: 'user-a',
    }).returning()
    expect(row!.isTemplate).toBe(true)

    const [regular] = await db.insert(tables.designDocuments).values({
      workspaceId: 'ws-a',
      title: 'Regular',
      document: createEmptyDocument('Regular'),
      createdBy: 'user-a',
    }).returning()
    expect(regular!.isTemplate).toBe(false)
  })

  it('can query only templates via the isTemplate index column', async () => {
    const { db } = await setup()
    await db.insert(tables.designDocuments).values([
      {
        workspaceId: 'ws-a',
        title: 'T1',
        document: createEmptyDocument('T1'),
        isTemplate: true,
        createdBy: 'user-a',
      },
      {
        workspaceId: 'ws-a',
        title: 'T2',
        document: createEmptyDocument('T2'),
        isTemplate: true,
        createdBy: 'user-a',
      },
      {
        workspaceId: 'ws-a',
        title: 'Regular',
        document: createEmptyDocument('Regular'),
        createdBy: 'user-a',
      },
    ])
    const templates = await db.select().from(tables.designDocuments)
      .where(eq(tables.designDocuments.isTemplate, true))
    // 2 inserted above + the initial doc-a fixture which is not a template.
    expect(templates).toHaveLength(2)
    expect(templates.every((r) => r.isTemplate)).toBe(true)
  })
})
