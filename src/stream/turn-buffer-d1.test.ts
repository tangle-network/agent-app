import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from './turn-buffer'

/**
 * A D1 statement takes at most 100 bound variables. The append used one
 * multi-row insert per flush, three variables a row, so a flush of 34 or more
 * events failed outright and took the turn with it. Real SQLite enforces the
 * same cap when told to, which is what makes this test bite.
 */
function d1Like(limit = 100) {
  const sqlite = new Database(':memory:')
  sqlite.exec(TURN_EVENTS_MIGRATION_SQL)
  return {
    sqlite,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (values.length > limit) throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR`)
            const statement = sqlite.prepare(sql)
            return {
              async run() { statement.run(...values); return { success: true } },
              async all() { return { results: statement.all(...values) } },
              async first() { return statement.get(...values) ?? null },
            }
          },
        }
      },
    },
  }
}

describe('createD1TurnEventStore.append', () => {
  it('writes a flush larger than D1 allows in one statement, in order', async () => {
    const { sqlite, db } = d1Like()
    const store = createD1TurnEventStore(db as never)
    const events = Array.from({ length: 120 }, (_, seq) => ({ seq: seq + 1, event: JSON.stringify({ type: 'text', seq: seq + 1 }) }))
    await store.append('turn-1', events)
    const rows = sqlite.prepare('SELECT seq FROM turn_events WHERE turnId = ? ORDER BY seq').all('turn-1') as Array<{ seq: number }>
    expect(rows.map((row) => row.seq)).toEqual(events.map((event) => event.seq))
  })

  it('keeps a single-statement flush for a small batch', async () => {
    const { sqlite, db } = d1Like()
    const store = createD1TurnEventStore(db as never)
    await store.append('turn-2', [{ seq: 1, event: '{}' }, { seq: 2, event: '{}' }])
    expect((sqlite.prepare('SELECT count(*) AS n FROM turn_events').get() as { n: number }).n).toBe(2)
  })
})
