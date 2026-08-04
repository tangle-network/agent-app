import { describe, expect, it } from 'vitest'
import {
  createRecordStore,
  createRecordTable,
  type RecordDatabase,
  type RecordStore,
} from '../../src/record/drizzle'
import { recordUlid, type RecordWritePolicy } from '../../src/record'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { openDatabase, rawClient, reviewersTable, scopesTable, sourcesTable, withBatchSupport } from './db-helper'
import {
  fixturePeriodScope,
  fixturePolicy,
  fixtureRules,
  HEADER_COUNT,
  HEADER_LABEL,
  ITEM_AMOUNT,
  ITEM_COLLECTION,
} from './fixtures'

const table = createRecordTable({
  tableName: 'demo_entry',
  scopeTable: scopesTable,
  sourceTable: sourcesTable,
  reviewerTable: reviewersTable,
})

const SCOPE = 'w1'

interface Harness {
  db: RecordDatabase
  store: RecordStore
  countRows(): number
}

function setup(options: { batch?: boolean; newId?: () => string; now?: () => number } = {}): Harness {
  const base = openDatabase([scopesTable, sourcesTable, reviewersTable, table])
  const sqlite = rawClient(base)
  sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run(SCOPE, 'W1')
  sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run('w2', 'W2')
  sqlite.prepare('INSERT INTO source_document (id, title) VALUES (?, ?)').run('doc-1', 'D')
  sqlite.prepare('INSERT INTO app_user (id, email) VALUES (?, ?)').run('u1', 'u@x.test')

  const db = (options.batch ? withBatchSupport(base) : base) as unknown as RecordDatabase
  const store = createRecordStore({
    db,
    table,
    policy: fixturePolicy,
    periodScope: fixturePeriodScope,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  return {
    db,
    store,
    countRows: () => (sqlite.prepare('SELECT COUNT(*) AS n FROM demo_entry').get() as { n: number }).n,
  }
}

describe('driver strategy', () => {
  it('prefers batch when the driver has it — the only atomic primitive on D1', () => {
    expect(setup({ batch: true }).store.atomicStrategy).toBe('batch')
  })

  it('falls to an explicit BEGIN IMMEDIATE on a driver with no batch', () => {
    expect(setup().store.atomicStrategy).toBe('begin-immediate')
  })
})

describe('the write allowlist', () => {
  it('refuses a path that is not a key of the schema map', async () => {
    const { store } = setup()
    const result = await store.write({ scopeId: SCOPE, path: 'not.declared', value: 1, sourceKind: 'direct' })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.code).toBe('unknown-path')
  })

  it('refuses a source kind the policy never declared', async () => {
    const { store } = setup()
    const result = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'invented' })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.code).toBe('unknown-source-kind')
    expect(result.error).toContain('direct')
  })

  it('rejects a value the consumer schema refuses (safeParse form)', async () => {
    const { store, countRows } = setup()
    const result = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: -3, sourceKind: 'direct' })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.code).toBe('invalid-value')
    expect(countRows()).toBe(0)
  })

  it('rejects a value the consumer schema refuses (function form)', async () => {
    const { store, countRows } = setup()
    const result = await store.write({ scopeId: SCOPE, path: HEADER_LABEL, value: '   ', sourceKind: 'direct' })
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.code).toBe('invalid-value')
    expect(result.error).toContain('non-empty string')
    expect(countRows()).toBe(0)
  })

  it('stores the value the schema returned, not the raw input', async () => {
    const { store } = setup()
    const written = await store.write({ scopeId: SCOPE, path: HEADER_LABEL, value: '  spaced  ', sourceKind: 'direct' })
    expect(written.succeeded).toBe(true)
    if (!written.succeeded) return
    expect(written.value.entry.valueJson).toBe('"spaced"')
  })

  it('requires a source ref for the kinds the policy names', async () => {
    const { store } = setup()
    const missing = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'extracted' })
    expect(missing.succeeded).toBe(false)
    if (missing.succeeded) return
    expect(missing.code).toBe('invalid-input')

    const present = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(present.succeeded).toBe(true)
  })

  it('canonicalizes the item key and refuses one the consumer rejects', async () => {
    const { store } = setup()
    const ok = await store.write({ scopeId: SCOPE, path: ITEM_AMOUNT, itemKey: ' ab ', value: 5, sourceKind: 'direct' })
    expect(ok.succeeded).toBe(true)
    if (!ok.succeeded) return
    expect(ok.value.entry.itemKey).toBe('AB')

    const bad = await store.write({ scopeId: SCOPE, path: ITEM_AMOUNT, value: 5, sourceKind: 'direct' })
    expect(bad.succeeded).toBe(false)
    if (bad.succeeded) return
    expect(bad.code).toBe('invalid-input')
    expect(bad.error).toContain('requires an itemKey')
  })

  it('refuses a period outside the policy range and a non-integer one', async () => {
    const { store } = setup()
    for (const period of [-1, 10_000, 2000.5]) {
      const result = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct', period })
      expect(result.succeeded, `period ${period}`).toBe(false)
      if (result.succeeded) return
      expect(result.code).toBe('invalid-input')
    }
  })

  it('refuses an affirmedEmpty entry on a path that is not affirmable, and one carrying a value', async () => {
    const { store } = setup()
    const notAffirmable = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, affirmedEmpty: true, sourceKind: 'direct',
    })
    expect(notAffirmable.succeeded).toBe(false)
    if (notAffirmable.succeeded) return
    expect(notAffirmable.code).toBe('unknown-path')

    const withValue = await store.write({
      scopeId: SCOPE, path: ITEM_COLLECTION, affirmedEmpty: true, value: 1, sourceKind: 'direct',
    })
    expect(withValue.succeeded).toBe(false)
    if (withValue.succeeded) return
    expect(withValue.code).toBe('invalid-input')
  })
})

describe('review state on write', () => {
  it('is read from the policy map, per source kind', async () => {
    const { store } = setup()
    const direct = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    const extracted = await store.write({
      scopeId: SCOPE, path: HEADER_LABEL, value: 'x', sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(direct.succeeded && extracted.succeeded).toBe(true)
    if (!direct.succeeded || !extracted.succeeded) return
    expect(direct.value.entry.reviewState).toBe('accepted')
    expect(extracted.value.entry.reviewState).toBe('proposed')
  })
})

describe('conflict detection', () => {
  it('flags a different source kind asserting a materially different value', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 4, sourceKind: 'direct' })
    const clash = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 9, sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(clash.succeeded).toBe(true)
    if (!clash.succeeded) return
    expect(clash.value.conflict).toBe(true)
    expect(clash.value.entry.conflict).toBe(true)
    expect(clash.value.entry.reviewState).toBe('proposed')
  })

  it('forces an otherwise-accepted write down to proposed rather than superseding', async () => {
    const { store } = setup()
    const head = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 4, sourceKind: 'imported' })
    expect(head.succeeded).toBe(true)
    if (!head.succeeded) return
    const accepted = await store.review({ scopeId: SCOPE, entryId: head.value.entry.id, action: 'accept' })
    expect(accepted.succeeded).toBe(true)

    const rival = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 7, sourceKind: 'direct' })
    expect(rival.succeeded).toBe(true)
    if (!rival.succeeded) return
    expect(rival.value.entry.reviewState).toBe('proposed')
    expect(rival.value.conflict).toBe(true)
    expect(rival.value.supersededEntryId).toBe(null)

    const heads = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(heads.succeeded).toBe(true)
    if (!heads.succeeded) return
    expect(heads.value.map((row) => row.valueJson)).toEqual(['4'])
  })

  it('does not flag the same source kind restating a value', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 4, sourceKind: 'direct' })
    const restated = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 8, sourceKind: 'direct' })
    expect(restated.succeeded).toBe(true)
    if (!restated.succeeded) return
    expect(restated.value.conflict).toBe(false)
    expect(restated.value.supersededEntryId).not.toBe(null)
  })

  it('does not flag a different source kind corroborating the same value', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 4, sourceKind: 'direct' })
    const corroborating = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 4, sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(corroborating.succeeded).toBe(true)
    if (!corroborating.succeeded) return
    expect(corroborating.value.conflict).toBe(false)
  })

  it('does not flag on key order alone — values are compared canonically', async () => {
    const { db } = setup()
    const objectStore = createRecordStore({
      db,
      table,
      policy: {
        schemas: { 'blob.value': (value) => ({ succeeded: true, value }) },
        reviewStateOnWrite: { direct: 'accepted', extracted: 'proposed' },
      },
    })
    await objectStore.write({ scopeId: SCOPE, path: 'blob.value', value: { b: 2, a: 1 }, sourceKind: 'direct' })
    const reordered = await objectStore.write({
      scopeId: SCOPE, path: 'blob.value', value: { a: 1, b: 2 }, sourceKind: 'extracted',
    })
    expect(reordered.succeeded).toBe(true)
    if (!reordered.succeeded) return
    expect(reordered.value.conflict).toBe(false)
  })
})

describe('supersede', () => {
  for (const batch of [false, true]) {
    const label = batch ? 'batch' : 'begin-immediate'

    it(`[${label}] marks the old head and installs the new one`, async () => {
      const { store, countRows } = setup({ batch })
      const first = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
      const second = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'direct' })
      expect(first.succeeded && second.succeeded).toBe(true)
      if (!first.succeeded || !second.succeeded) return
      expect(second.value.supersededEntryId).toBe(first.value.entry.id)
      expect(countRows()).toBe(2)

      const heads = await store.heads({ scopeId: SCOPE, period: 0 })
      expect(heads.succeeded).toBe(true)
      if (!heads.succeeded) return
      expect(heads.value).toHaveLength(1)
      expect(heads.value[0]?.id).toBe(second.value.entry.id)

      const all = await store.list({ scopeId: SCOPE, includeSuperseded: true })
      expect(all.succeeded).toBe(true)
      if (!all.succeeded) return
      expect(all.value.find((row) => row.id === first.value.entry.id)?.supersededById).toBe(second.value.entry.id)
    })

    it(`[${label}] survives a writer that takes the head between the read and the write`, async () => {
      // `newId` is called AFTER the store reads the live head and BEFORE the
      // guarded supersede — the exact window a second worker lands in. The
      // rival commits real SQL through the real index: it marks the head this
      // write is about to guard on, and installs its own live head.
      let calls = 0
      let sqlite: ReturnType<typeof rawClient> | undefined
      const harness = setup({
        batch,
        newId: () => {
          calls += 1
          if (calls === 2 && sqlite) {
            sqlite.prepare('UPDATE demo_entry SET superseded_by_id = ? WHERE superseded_by_id IS NULL AND review_state = ?')
              .run('RIVAL', 'accepted')
            sqlite.prepare(
              `INSERT INTO demo_entry
                (id, scope_id, seq, dimension, period, path, item_key, value_json, affirmed_empty, review_state, conflict, source_kind, created_at)
               VALUES ('RIVAL', ?, 2, '', 0, ?, '', '50', 0, 'accepted', 0, 'direct', 0)`,
            ).run(SCOPE, HEADER_COUNT)
          }
          return recordUlid()
        },
      })
      sqlite = rawClient(harness.db as unknown as Parameters<typeof rawClient>[0])

      const seed = await harness.store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
      expect(seed.succeeded).toBe(true)
      if (!seed.succeeded) return

      const mine = await harness.store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 99, sourceKind: 'direct' })
      expect(mine.succeeded).toBe(true)
      if (!mine.succeeded) return
      expect(calls).toBeGreaterThan(2)

      const heads = await harness.store.heads({ scopeId: SCOPE, period: 0 })
      expect(heads.succeeded).toBe(true)
      if (!heads.succeeded) return
      expect(heads.value).toHaveLength(1)
      expect(heads.value[0]?.id).toBe(mine.value.entry.id)
      expect(heads.value[0]?.valueJson).toBe('99')

      const trail = await harness.store.list({ scopeId: SCOPE, includeSuperseded: true })
      expect(trail.succeeded).toBe(true)
      if (!trail.succeeded) return
      expect(trail.value.find((row) => row.id === seed.value.entry.id)?.supersededById).toBe('RIVAL')
      expect(trail.value.find((row) => row.id === 'RIVAL')?.supersededById).toBe(mine.value.entry.id)
      // Seed + rival + mine. A lost race that left its insert committed and
      // retried anyway would leave a fourth row behind.
      expect(harness.countRows()).toBe(3)
    })
  }

  it('keeps one live head per sentinel key, so the defaults never collide silently', async () => {
    const { store, countRows } = setup()
    for (const value of [1, 2, 3]) {
      const written = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value, sourceKind: 'direct' })
      expect(written.succeeded).toBe(true)
    }
    expect(countRows()).toBe(3)
    const heads = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(heads.succeeded).toBe(true)
    if (!heads.succeeded) return
    expect(heads.value).toHaveLength(1)
    expect(heads.value[0]?.valueJson).toBe('3')
  })

  it('treats a different dimension as a different key', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'direct', dimension: 'EU' })
    const heads = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(heads.succeeded).toBe(true)
    if (!heads.succeeded) return
    expect(heads.value.map((row) => row.dimension).sort()).toEqual(['', 'eu'])
  })

  it('scopes every head to its own tenant', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    await store.write({ scopeId: 'w2', path: HEADER_COUNT, value: 2, sourceKind: 'direct' })
    const mine = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(mine.succeeded).toBe(true)
    if (!mine.succeeded) return
    expect(mine.value.map((row) => row.valueJson)).toEqual(['1'])
  })

  it('assigns seq per scope, independently', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    const other = await store.write({ scopeId: 'w2', path: HEADER_COUNT, value: 2, sourceKind: 'direct' })
    const mine = await store.write({ scopeId: SCOPE, path: HEADER_LABEL, value: 'x', sourceKind: 'direct' })
    expect(other.succeeded && mine.succeeded).toBe(true)
    if (!other.succeeded || !mine.succeeded) return
    expect(other.value.entry.seq).toBe(1)
    expect(mine.value.entry.seq).toBe(2)
  })
})

describe('review', () => {
  it('accepting supersedes the live head', async () => {
    const { store } = setup()
    const head = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    const proposal = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 5, sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(head.succeeded && proposal.succeeded).toBe(true)
    if (!head.succeeded || !proposal.succeeded) return

    const accepted = await store.review({
      scopeId: SCOPE, entryId: proposal.value.entry.id, action: 'accept', reviewedBy: 'u1',
    })
    expect(accepted.succeeded).toBe(true)
    if (!accepted.succeeded) return
    expect(accepted.value.reviewState).toBe('accepted')
    expect(accepted.value.reviewedBy).toBe('u1')
    expect(accepted.value.conflict).toBe(false)

    const heads = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(heads.succeeded).toBe(true)
    if (!heads.succeeded) return
    expect(heads.value.map((row) => row.id)).toEqual([proposal.value.entry.id])
  })

  it('rejecting leaves the head alone', async () => {
    const { store } = setup()
    const head = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    const proposal = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 5, sourceKind: 'extracted', sourceRef: 'doc-1',
    })
    expect(head.succeeded && proposal.succeeded).toBe(true)
    if (!head.succeeded || !proposal.succeeded) return

    const rejected = await store.review({ scopeId: SCOPE, entryId: proposal.value.entry.id, action: 'reject' })
    expect(rejected.succeeded).toBe(true)
    if (!rejected.succeeded) return
    expect(rejected.value.reviewState).toBe('rejected')

    const heads = await store.heads({ scopeId: SCOPE, period: 0 })
    expect(heads.succeeded).toBe(true)
    if (!heads.succeeded) return
    expect(heads.value.map((row) => row.id)).toEqual([head.value.entry.id])
  })

  it('refuses to re-review anything that is not proposed', async () => {
    const { store } = setup()
    const head = await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
    expect(head.succeeded).toBe(true)
    if (!head.succeeded) return
    const again = await store.review({ scopeId: SCOPE, entryId: head.value.entry.id, action: 'accept' })
    expect(again.succeeded).toBe(false)
    if (again.succeeded) return
    expect(again.code).toBe('not-reviewable')
  })

  it('refuses an entry from another scope without revealing it', async () => {
    const { store } = setup()
    const other = await store.write({ scopeId: 'w2', path: HEADER_COUNT, value: 1, sourceKind: 'imported' })
    expect(other.succeeded).toBe(true)
    if (!other.succeeded) return
    const cross = await store.review({ scopeId: SCOPE, entryId: other.value.entry.id, action: 'accept' })
    expect(cross.succeeded).toBe(false)
    if (cross.succeeded) return
    expect(cross.code).toBe('not-found')
  })

  for (const batch of [false, true]) {
    const label = batch ? 'batch' : 'begin-immediate'

    it(`[${label}] leaves the live head intact when a second reviewer rejects the proposal mid-accept`, async () => {
      // `now()` is called AFTER review() read the entry as 'proposed' and
      // BEFORE the guarded accept pair — the window a second reviewer lands
      // in. Checking only the guard's row count lets the head-marking half
      // commit alone, which stamps the live head as superseded by a REJECTED
      // entry and destroys the record's value while the caller is told
      // nothing was written.
      let sqlite: ReturnType<typeof rawClient> | undefined
      let nowCalls = 0
      const harness = setup({
        batch,
        now: () => {
          nowCalls += 1
          if (nowCalls === 1 && sqlite) {
            sqlite.prepare("UPDATE demo_entry SET review_state = 'rejected' WHERE review_state = 'proposed'").run()
          }
          return 1
        },
      })
      sqlite = rawClient(harness.db as unknown as Parameters<typeof rawClient>[0])

      const head = await harness.store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct' })
      const proposal = await harness.store.write({
        scopeId: SCOPE, path: HEADER_COUNT, value: 5, sourceKind: 'extracted', sourceRef: 'doc-1',
      })
      expect(head.succeeded && proposal.succeeded).toBe(true)
      if (!head.succeeded || !proposal.succeeded) return

      const accepted = await harness.store.review({ scopeId: SCOPE, entryId: proposal.value.entry.id, action: 'accept' })
      expect(accepted.succeeded).toBe(false)
      if (accepted.succeeded) return
      expect(accepted.code).toBe('not-reviewable')

      // The refusal has to be a true no-op: the head still live, still
      // holding the value it held before anyone reviewed anything.
      const heads = await harness.store.heads({ scopeId: SCOPE, period: 0 })
      expect(heads.succeeded).toBe(true)
      if (!heads.succeeded) return
      expect(heads.value.map((row) => row.valueJson)).toEqual(['1'])
      expect(heads.value[0]?.id).toBe(head.value.entry.id)

      const rows = sqlite.prepare('SELECT id, superseded_by_id FROM demo_entry ORDER BY seq').all() as Array<{
        id: string
        superseded_by_id: string | null
      }>
      expect(rows.find((row) => row.id === head.value.entry.id)?.superseded_by_id).toBeNull()
    })
  }
})

describe('list', () => {
  async function seeded() {
    const harness = setup()
    await harness.store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct', period: 2000 })
    await harness.store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'direct', period: 2000 })
    const proposal = await harness.store.write({
      scopeId: SCOPE, path: HEADER_LABEL, value: 'p', sourceKind: 'extracted', sourceRef: 'doc-1', period: 2000,
    })
    if (proposal.succeeded) {
      await harness.store.review({ scopeId: SCOPE, entryId: proposal.value.entry.id, action: 'reject' })
    }
    return harness
  }

  it('hides superseded and rejected entries by default', async () => {
    const { store } = await seeded()
    const rows = await store.list({ scopeId: SCOPE })
    expect(rows.succeeded).toBe(true)
    if (!rows.succeeded) return
    expect(rows.value.map((row) => row.valueJson)).toEqual(['2'])
  })

  it('returns superseded entries on request, in seq order', async () => {
    const { store } = await seeded()
    const rows = await store.list({ scopeId: SCOPE, includeSuperseded: true, includeRejected: true })
    expect(rows.succeeded).toBe(true)
    if (!rows.succeeded) return
    expect(rows.value.map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it('narrows to one review state without resurrecting superseded rows', async () => {
    const { store } = await seeded()
    const rows = await store.list({ scopeId: SCOPE, reviewState: 'accepted' })
    expect(rows.succeeded).toBe(true)
    if (!rows.succeeded) return
    expect(rows.value.map((row) => row.valueJson)).toEqual(['2'])
  })

  it('resolves period visibility with the store scope resolver', async () => {
    const { store } = await seeded()
    const later = await store.list({ scopeId: SCOPE, period: 2001, includeRejected: true })
    expect(later.succeeded).toBe(true)
    if (!later.succeeded) return
    // header.count is exact (invisible in 2001); the rejected carry-forward
    // label is visible but filtered out by review state.
    expect(later.value.map((row) => row.path)).toEqual([HEADER_LABEL])
  })

  it('agrees with heads() about which entries are live at a period', async () => {
    // `period` means one thing, not two. header.count is `exact`: an entry
    // written at 2023 is not true at 2024, and a caller rendering "the record
    // as of 2024" from heads() must not be shown it.
    const { store } = setup()
    const written = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 7, period: 2023, sourceKind: 'direct',
    })
    expect(written.succeeded).toBe(true)

    const heads = await store.heads({ scopeId: SCOPE, period: 2024 })
    const rows = await store.list({ scopeId: SCOPE, period: 2024 })
    expect(heads.succeeded && rows.succeeded).toBe(true)
    if (!heads.succeeded || !rows.succeeded) return
    expect(heads.value.map((row) => row.id)).toEqual(rows.value.map((row) => row.id))
    expect(heads.value).toHaveLength(0)

    // …and both still see it in its own period.
    const atWrite = await store.heads({ scopeId: SCOPE, period: 2023 })
    expect(atWrite.succeeded).toBe(true)
    if (!atWrite.succeeded) return
    expect(atWrite.value.map((row) => row.valueJson)).toEqual(['7'])
  })
})

describe('materialize', () => {
  it('folds live heads and counts the review backlog', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 2, sourceKind: 'direct', period: 2000 })
    await store.write({ scopeId: SCOPE, path: ITEM_AMOUNT, itemKey: 'a', value: 10, sourceKind: 'direct', period: 2000 })
    await store.write({ scopeId: SCOPE, path: ITEM_AMOUNT, itemKey: 'b', value: 5, sourceKind: 'direct', period: 2000 })
    await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 77, sourceKind: 'extracted', sourceRef: 'doc-1', period: 2000,
    })

    const folded = await store.materialize({ scopeId: SCOPE, rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.header.count).toBe(2)
    expect(folded.value.value.items.map((item) => item.key)).toEqual(['A', 'B'])
    expect(folded.value.value.total).toBe(15)
    expect(folded.value.entryCount).toBe(3)
    expect(folded.value.pendingProposed).toBe(1)
    expect(folded.value.conflicts).toBe(1)
  })

  it('carries a carry-forward head into a later period and leaves exact ones behind', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: HEADER_LABEL, value: 'kept', sourceKind: 'direct', period: 2000 })
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 3, sourceKind: 'direct', period: 2000 })

    const later = await store.materialize({ scopeId: SCOPE, rules: fixtureRules, period: 2001 })
    expect(later.succeeded).toBe(true)
    if (!later.succeeded) return
    expect(later.value.value.header.label).toBe('kept')
    expect(later.value.value.header.count).toBe(null)
  })

  it('folds a negative assertion that a human accepted', async () => {
    const { store } = setup()
    await store.write({ scopeId: SCOPE, path: ITEM_AMOUNT, itemKey: 'a', value: 10, sourceKind: 'direct', period: 2000 })
    const affirm = await store.write({
      scopeId: SCOPE, path: ITEM_COLLECTION, affirmedEmpty: true, sourceKind: 'direct', period: 2000,
    })
    expect(affirm.succeeded).toBe(true)
    if (!affirm.succeeded) return
    expect(affirm.value.entry.valueJson).toBe('null')

    const folded = await store.materialize({ scopeId: SCOPE, rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.items).toEqual([])
    expect(folded.value.value.emptied).toEqual([ITEM_COLLECTION])
  })

  it('surfaces a fold failure instead of returning a half-built shape', async () => {
    const { store, db } = setup()
    void db
    await store.write({ scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct', period: 2000 })
    const folded = await store.materialize({
      scopeId: SCOPE,
      rules: { ...fixtureRules, apply: () => ({ succeeded: false, error: 'no rule', code: 'fold-failed' }) },
      period: 2000,
    })
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.code).toBe('fold-failed')
  })
})

describe('product columns on a write', () => {
  const messagesTable = sqliteTable('chat_message', {
    id: text('id').primaryKey(),
    body: text('body').notNull(),
  })

  const twoRefTable = createRecordTable({
    tableName: 'two_ref_entry',
    scopeTable: scopesTable,
    reviewerTable: reviewersTable,
    extraColumns: {
      sourceDocumentId: text('source_document_id').references(() => sourcesTable.id, { onDelete: 'set null' }),
      sourceMessageId: text('source_message_id').references(() => messagesTable.id, { onDelete: 'set null' }),
    },
  })

  // Two source kinds citing two different tables — the shape `requireSourceRef`
  // cannot express, because it can only require THE one built-in ref.
  const twoRefPolicy: RecordWritePolicy = {
    ...fixturePolicy,
    requireSourceRef: [],
    requireExtras: {
      extracted: ['sourceDocumentId'],
      imported: ['sourceMessageId'],
    },
  }

  function twoRefSetup() {
    const base = openDatabase([scopesTable, sourcesTable, reviewersTable, messagesTable, twoRefTable])
    const sqlite = rawClient(base)
    sqlite.prepare('INSERT INTO workspace (id, name) VALUES (?, ?)').run(SCOPE, 'W1')
    sqlite.prepare('INSERT INTO source_document (id, title) VALUES (?, ?)').run('doc-1', 'D')
    sqlite.prepare('INSERT INTO chat_message (id, body) VALUES (?, ?)').run('msg-1', 'hello')
    const store = createRecordStore({
      db: base as unknown as RecordDatabase,
      table: twoRefTable,
      policy: twoRefPolicy,
      periodScope: fixturePeriodScope,
    })
    return { sqlite, store }
  }

  it('carries each kind’s own ref onto the row', async () => {
    const { sqlite, store } = twoRefSetup()
    const fromDocument = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'extracted', extras: { sourceDocumentId: 'doc-1' },
    })
    const fromChat = await store.write({
      scopeId: SCOPE, path: HEADER_LABEL, value: 'x', sourceKind: 'imported', extras: { sourceMessageId: 'msg-1' },
    })
    expect(fromDocument.succeeded && fromChat.succeeded).toBe(true)
    if (!fromDocument.succeeded || !fromChat.succeeded) return

    const rows = sqlite
      .prepare('SELECT path, source_document_id, source_message_id FROM two_ref_entry ORDER BY seq')
      .all()
    expect(rows).toEqual([
      { path: HEADER_COUNT, source_document_id: 'doc-1', source_message_id: null },
      { path: HEADER_LABEL, source_document_id: null, source_message_id: 'msg-1' },
    ])
  })

  it('requires the ref its source kind declares, per kind', async () => {
    const { store } = twoRefSetup()
    const missing = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'extracted', extras: { sourceMessageId: 'msg-1' },
    })
    expect(missing.succeeded).toBe(false)
    if (missing.succeeded) return
    expect(missing.code).toBe('invalid-input')
    expect(missing.error).toContain('extras.sourceDocumentId')
  })

  it('refuses a key with no column instead of dropping it', async () => {
    const { store } = twoRefSetup()
    const unknown = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct', extras: { sourceEmailId: 'mail-1' },
    })
    expect(unknown.succeeded).toBe(false)
    if (unknown.succeeded) return
    expect(unknown.code).toBe('invalid-input')
    expect(unknown.error).toContain("extras key 'sourceEmailId' has no column")
  })

  it('refuses a key that names a column the store owns', async () => {
    const { store } = twoRefSetup()
    const shadowed = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'direct', extras: { reviewState: 'accepted' },
    })
    expect(shadowed.succeeded).toBe(false)
    if (shadowed.succeeded) return
    expect(shadowed.error).toContain("extras key 'reviewState' has no column")
  })

  it('honours the product foreign key rather than storing a dangling ref', async () => {
    const { store } = twoRefSetup()
    const dangling = await store.write({
      scopeId: SCOPE, path: HEADER_COUNT, value: 1, sourceKind: 'extracted', extras: { sourceDocumentId: 'nope' },
    })
    expect(dangling.succeeded).toBe(false)
    if (dangling.succeeded) return
    expect(dangling.code).toBe('storage-failed')
    expect(dangling.error).toContain('FOREIGN KEY')
  })
})
