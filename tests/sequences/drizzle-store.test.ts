import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, getTableName, is, SQL } from 'drizzle-orm'
import { getTableConfig, sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteTable, ForeignKey, SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { createSequenceTables } from '../../src/sequences/schema'
import type { SequenceClipRow, SequenceTables } from '../../src/sequences/schema'
import { createDrizzleSequenceStore } from '../../src/sequences/drizzle-store'
import type { SequenceDatabase, SequenceMediaResolver } from '../../src/sequences/drizzle-store'
import type { SequenceClipMedia } from '../../src/sequences/model'

// ---------------------------------------------------------------------------
// Fixture: product-owned tables + DDL generated FROM the drizzle table objects
// (getTableConfig), so the executed schema can never drift from the factory.
// ---------------------------------------------------------------------------

const workspaces = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
})

const generations = sqliteTable('generation', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  result: text('result'),
})

const assets = sqliteTable('asset', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
})

const tables = createSequenceTables({
  workspaceTable: workspaces,
  userTable: users,
  generationTable: generations,
  assetTable: assets,
})

const bareTables = createSequenceTables({ workspaceTable: workspaces, userTable: users })

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

function openDatabase(allTables: AnySQLiteTable[]): SequenceDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const table of allTables) {
    for (const statement of tableDdl(table)) sqlite.exec(statement)
  }
  return drizzle(sqlite)
}

const scopeA = { workspaceId: 'ws-a', sequenceId: 'seq-a', userId: 'user-a' }
const scopeB = { workspaceId: 'ws-b', sequenceId: 'seq-b', userId: 'user-b' }

async function setup(resolveMedia?: SequenceMediaResolver) {
  const db = openDatabase([
    workspaces,
    users,
    generations,
    assets,
    tables.sequences,
    tables.sequenceTracks,
    tables.sequenceClips,
    tables.sequenceDecisions,
    tables.sequenceExports,
  ])
  await db.insert(workspaces).values([
    { id: 'ws-a', name: 'Workspace A' },
    { id: 'ws-b', name: 'Workspace B' },
  ])
  await db.insert(users).values([
    { id: 'user-a', email: 'a@example.com' },
    { id: 'user-b', email: 'b@example.com' },
  ])
  await db.insert(generations).values([{ id: 'gen-1', workspaceId: 'ws-a', result: null }])
  await db.insert(assets).values([{ id: 'asset-1', url: 'https://cdn.example.com/asset-1.png' }])
  await db.insert(tables.sequences).values([
    { id: 'seq-a', workspaceId: 'ws-a', title: 'Sequence A', createdBy: 'user-a' },
    { id: 'seq-b', workspaceId: 'ws-b', title: 'Sequence B', createdBy: 'user-b' },
  ])
  const storeA = createDrizzleSequenceStore({ db, tables, scope: scopeA, resolveMedia })
  const storeB = createDrizzleSequenceStore({ db, tables, scope: scopeB, resolveMedia })
  return { db, storeA, storeB }
}

async function sequenceUpdatedAt(db: SequenceDatabase, sequenceId: string): Promise<Date> {
  const [row] = await db.select().from(tables.sequences).where(eq(tables.sequences.id, sequenceId)).limit(1)
  if (!row) throw new Error(`fixture sequence ${sequenceId} missing`)
  return row.updatedAt
}

describe('createSequenceTables', () => {
  it('applies creative-agent defaults and generates 32-char hex ids', async () => {
    const { db } = await setup()
    const [row] = await db.insert(tables.sequences)
      .values({ workspaceId: 'ws-a', title: 'Defaults', createdBy: 'user-a' })
      .returning()
    expect(row).toBeDefined()
    expect(row!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(row!.fps).toBe(30)
    expect(row!.width).toBe(1080)
    expect(row!.height).toBe(1920)
    expect(row!.aspectRatio).toBe('9:16')
    expect(row!.durationFrames).toBe(900)
    expect(row!.status).toBe('draft')
    expect(row!.metadata).toEqual({})
    expect(row!.createdAt).toBeInstanceOf(Date)
  })

  it('enforces the generation FK when a generation table is provided', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    await expect(storeA.createClip({
      trackId: track.id,
      label: 'broken ref',
      startFrame: 0,
      durationFrames: 30,
      generationId: 'gen-missing',
    })).rejects.toThrow(/FOREIGN KEY/)
    const clip = await storeA.createClip({
      trackId: track.id,
      label: 'valid ref',
      startFrame: 0,
      durationFrames: 30,
      generationId: 'gen-1',
    })
    expect(clip.generationId).toBe('gen-1')
  })

  it('keeps generation/asset as plain text columns when parent tables are absent', async () => {
    const db = openDatabase([
      workspaces,
      users,
      bareTables.sequences,
      bareTables.sequenceTracks,
      bareTables.sequenceClips,
      bareTables.sequenceDecisions,
      bareTables.sequenceExports,
    ])
    await db.insert(workspaces).values([{ id: 'ws-a', name: 'Workspace A' }])
    await db.insert(users).values([{ id: 'user-a', email: 'a@example.com' }])
    await db.insert(bareTables.sequences).values([{ id: 'seq-a', workspaceId: 'ws-a', title: 'Bare', createdBy: 'user-a' }])
    const store = createDrizzleSequenceStore({ db, tables: bareTables, scope: scopeA })
    const track = await store.createTrack({ kind: 'video', name: 'V1' })
    const clip = await store.createClip({
      trackId: track.id,
      label: 'opaque refs',
      startFrame: 0,
      durationFrames: 30,
      generationId: 'external-gen-id',
      assetId: 'external-asset-id',
    })
    expect(clip.generationId).toBe('external-gen-id')
    expect(clip.assetId).toBe('external-asset-id')
  })
})

describe('createDrizzleSequenceStore', () => {
  it('round-trips tracks and clips through getTimeline in sortOrder/startFrame order', async () => {
    const { storeA } = await setup()
    const video = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const caption = await storeA.createTrack({ kind: 'caption', name: 'Captions' })
    expect(video.sortOrder).toBe(0)
    expect(caption.sortOrder).toBe(1)

    await storeA.createClip({ trackId: video.id, label: 'late', startFrame: 60, durationFrames: 90 })
    await storeA.createClip({ trackId: video.id, label: 'early', startFrame: 0, durationFrames: 60, sourceInFrame: 12, sourceOutFrame: 72 })
    await storeA.createClip({ trackId: caption.id, label: 'hola', startFrame: 0, durationFrames: 90, text: 'Hola mundo', language: 'es' })

    const timeline = await storeA.getTimeline()
    expect(timeline.sequence).toMatchObject({ id: 'seq-a', title: 'Sequence A', fps: 30, durationFrames: 900, status: 'draft' })
    expect(timeline.tracks.map((track) => track.name)).toEqual(['V1', 'Captions'])
    expect(timeline.clips.map((clip) => clip.label)).toEqual(['early', 'hola', 'late'])

    const early = timeline.clips[0]!
    expect(early.sourceInFrame).toBe(12)
    expect(early.sourceOutFrame).toBe(72)
    const hola = timeline.clips[1]!
    expect(hola.text).toBe('Hola mundo')
    expect(hola.language).toBe('es')
    expect(hola.sourceOutFrame).toBeNull()
    expect(hola.disabled).toBe(false)
    expect(hola.metadata).toEqual({})
  })

  it('honors an explicit track sortOrder', async () => {
    const { storeA } = await setup()
    await storeA.createTrack({ kind: 'video', name: 'V1' })
    const pinned = await storeA.createTrack({ kind: 'reference', name: 'Guides', sortOrder: 10 })
    expect(pinned.sortOrder).toBe(10)
    const next = await storeA.createTrack({ kind: 'audio', name: 'A1' })
    expect(next.sortOrder).toBe(11)
  })

  it('updateClip patches only the provided fields and supports clearing sourceOutFrame', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({
      trackId: track.id,
      label: 'original',
      startFrame: 0,
      durationFrames: 60,
      sourceOutFrame: 90,
      metadata: { origin: 'test' },
    })

    const moved = await storeA.updateClip(clip.id, { startFrame: 30 })
    expect(moved.startFrame).toBe(30)
    expect(moved.label).toBe('original')
    expect(moved.durationFrames).toBe(60)
    expect(moved.sourceOutFrame).toBe(90)
    expect(moved.metadata).toEqual({ origin: 'test' })

    const cleared = await storeA.updateClip(clip.id, { sourceOutFrame: null, disabled: true, text: 'caption text', language: 'en' })
    expect(cleared.sourceOutFrame).toBeNull()
    expect(cleared.disabled).toBe(true)
    expect(cleared.text).toBe('caption text')
    expect(cleared.language).toBe('en')
    expect(cleared.startFrame).toBe(30)
  })

  it('updateClip rejects an unknown target track', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({ trackId: track.id, label: 'clip', startFrame: 0, durationFrames: 30 })
    await expect(storeA.updateClip(clip.id, { trackId: 'no-such-track' }))
      .rejects.toThrow('Track no-such-track not found in sequence seq-a')
  })

  it('createClip rejects non-integer and out-of-range frame values', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    await expect(storeA.createClip({ trackId: track.id, label: 'bad', startFrame: -1, durationFrames: 30 }))
      .rejects.toThrow('startFrame must be a non-negative integer')
    await expect(storeA.createClip({ trackId: track.id, label: 'bad', startFrame: 0, durationFrames: 0 }))
      .rejects.toThrow('durationFrames must be a positive integer')
    await expect(storeA.createClip({ trackId: track.id, label: 'bad', startFrame: 0.5, durationFrames: 30 }))
      .rejects.toThrow('startFrame must be a non-negative integer')
  })

  it('deleteClip removes the row; getClip then fails loud', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({ trackId: track.id, label: 'clip', startFrame: 0, durationFrames: 30 })
    await storeA.deleteClip(clip.id)
    await expect(storeA.getClip(clip.id)).rejects.toThrow(`Clip ${clip.id} not found in sequence seq-a`)
  })

  it('updateSequenceDuration grows, refuses to shrink below the last clip end, and allows the exact floor', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    await storeA.createClip({ trackId: track.id, label: 'tail', startFrame: 100, durationFrames: 100 })

    const grown = await storeA.updateSequenceDuration(1800)
    expect(grown.durationFrames).toBe(1800)

    await expect(storeA.updateSequenceDuration(150))
      .rejects.toThrow('Cannot set sequence duration to 150 frames: the last clip ends at frame 200. Trim or delete clips first.')

    const floored = await storeA.updateSequenceDuration(200)
    expect(floored.durationFrames).toBe(200)
  })

  it('counts disabled clips toward the shrink floor', async () => {
    const { storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({ trackId: track.id, label: 'tail', startFrame: 500, durationFrames: 100 })
    await storeA.updateClip(clip.id, { disabled: true })
    await expect(storeA.updateSequenceDuration(300)).rejects.toThrow('the last clip ends at frame 600')
  })

  it('scopes every read and write to the bound workspace + sequence', async () => {
    const { db, storeA, storeB } = await setup()
    const trackB = await storeB.createTrack({ kind: 'video', name: 'B video' })
    const clipB = await storeB.createClip({ trackId: trackB.id, label: 'b clip', startFrame: 0, durationFrames: 30 })

    await expect(storeA.getClip(clipB.id)).rejects.toThrow(`Clip ${clipB.id} not found in sequence seq-a`)
    await expect(storeA.updateClip(clipB.id, { label: 'hijacked' })).rejects.toThrow('not found in sequence seq-a')
    await expect(storeA.deleteClip(clipB.id)).rejects.toThrow('not found in sequence seq-a')
    await expect(storeA.createClip({ trackId: trackB.id, label: 'cross-track', startFrame: 0, durationFrames: 30 }))
      .rejects.toThrow(`Track ${trackB.id} not found in sequence seq-a`)
    await expect(storeA.recordDecision({ clipId: clipB.id, kind: 'note', instruction: 'cross-ref' }))
      .rejects.toThrow('not found in sequence seq-a')

    const timelineA = await storeA.getTimeline()
    expect(timelineA.tracks).toEqual([])
    expect(timelineA.clips).toEqual([])

    // A mismatched workspace/sequence pair never resolves, even though both ids exist.
    const crossStore = createDrizzleSequenceStore({ db, tables, scope: { workspaceId: 'ws-a', sequenceId: 'seq-b', userId: 'user-a' } })
    await expect(crossStore.getTimeline()).rejects.toThrow('Sequence seq-b not found in workspace ws-a')

    const untouched = await storeB.getClip(clipB.id)
    expect(untouched.label).toBe('b clip')
  })

  it('resolves media through the product resolver and hands it raw clip rows', async () => {
    const seenRows: SequenceClipRow[][] = []
    const resolveMedia: SequenceMediaResolver = async (clipRows) => {
      seenRows.push(clipRows)
      const media = new Map<string, SequenceClipMedia>()
      for (const row of clipRows) {
        if (row.generationId) {
          media.set(row.id, { url: `https://cdn.example.com/${row.generationId}.mp4`, kind: 'video', durationSeconds: 5 })
        }
      }
      return media
    }
    const { storeA } = await setup(resolveMedia)
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const generated = await storeA.createClip({ trackId: track.id, label: 'generated', startFrame: 0, durationFrames: 30, generationId: 'gen-1' })
    const plain = await storeA.createClip({ trackId: track.id, label: 'plain', startFrame: 30, durationFrames: 30 })

    expect(generated.media).toEqual({ url: 'https://cdn.example.com/gen-1.mp4', kind: 'video', durationSeconds: 5 })
    expect(plain.media).toBeUndefined()

    const timeline = await storeA.getTimeline()
    expect(timeline.clips.find((clip) => clip.id === generated.id)?.media?.url).toBe('https://cdn.example.com/gen-1.mp4')
    expect(timeline.clips.find((clip) => clip.id === plain.id)?.media).toBeUndefined()

    const timelineBatch = seenRows.at(-1)
    expect(timelineBatch).toHaveLength(2)
    expect(timelineBatch!.map((row) => row.generationId).sort()).toEqual([null, 'gen-1'].sort())
  })

  it('bumps sequence.updatedAt on every mutation', async () => {
    const { db, storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({ trackId: track.id, label: 'clip', startFrame: 0, durationFrames: 30 })

    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['createTrack', () => storeA.createTrack({ kind: 'audio', name: 'A1' })],
      ['createClip', () => storeA.createClip({ trackId: track.id, label: 'more', startFrame: 60, durationFrames: 30 })],
      ['updateClip', () => storeA.updateClip(clip.id, { label: 'renamed' })],
      ['updateSequenceDuration', () => storeA.updateSequenceDuration(901)],
      ['recordDecision', () => storeA.recordDecision({ kind: 'note', instruction: 'log entry' })],
      ['createExport', () => storeA.createExport('mp4')],
      ['deleteClip', () => storeA.deleteClip(clip.id)],
    ]
    for (const [name, mutate] of mutations) {
      await db.update(tables.sequences).set({ updatedAt: new Date(0) }).where(eq(tables.sequences.id, 'seq-a'))
      await mutate()
      const updatedAt = await sequenceUpdatedAt(db, 'seq-a')
      expect(updatedAt.getTime(), `${name} must bump sequence.updatedAt`).toBeGreaterThan(0)
    }
  })

  it('records decisions and lists them newest-first with attribution from the scope', async () => {
    const { db, storeA } = await setup()
    const track = await storeA.createTrack({ kind: 'video', name: 'V1' })
    const clip = await storeA.createClip({ trackId: track.id, label: 'clip', startFrame: 0, durationFrames: 30 })

    await storeA.recordDecision({ kind: 'agent_proposal', instruction: 'first', reasoningSummary: 'because', accepted: null })
    await storeA.recordDecision({ kind: 'agent_edit', instruction: 'second', clipId: clip.id, accepted: true })
    await storeA.recordDecision({ kind: 'human_edit', instruction: 'third', metadata: { source: 'ui' } })

    const decisions = await storeA.listDecisions()
    expect(decisions.map((decision) => decision.instruction)).toEqual(['third', 'second', 'first'])
    expect(decisions[1]).toMatchObject({ kind: 'agent_edit', clipId: clip.id, accepted: true })
    expect(decisions[0]!.metadata).toEqual({ source: 'ui' })
    expect(decisions[0]!.createdAt).toBeInstanceOf(Date)

    const limited = await storeA.listDecisions(2)
    expect(limited.map((decision) => decision.instruction)).toEqual(['third', 'second'])

    const [rawRow] = await db.select().from(tables.sequenceDecisions)
      .where(eq(tables.sequenceDecisions.instruction, 'second'))
      .limit(1)
    expect(rawRow!.createdBy).toBe('user-a')
  })

  it('queues exports and lists them newest-first', async () => {
    const { storeA, storeB } = await setup()
    const mp4 = await storeA.createExport('mp4', { quality: 'high' })
    expect(mp4.status).toBe('queued')
    expect(mp4.resultUrl).toBeNull()
    expect(mp4.metadata).toEqual({ quality: 'high' })
    await storeA.createExport('srt')
    await storeB.createExport('edl')

    const exportsA = await storeA.listExports()
    expect(exportsA.map((record) => record.format)).toEqual(['srt', 'mp4'])
    const exportsB = await storeB.listExports()
    expect(exportsB.map((record) => record.format)).toEqual(['edl'])
  })
})
