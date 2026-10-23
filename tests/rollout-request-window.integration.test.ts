import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_REQUEST_WINDOW_INDEX_MIGRATION_SQL,
  ROLLOUT_TURN_TIMING_SCHEMA_SQL, type TurnTimingRow } from '../src/rollout/d1'

/** Execute the production reader and its query plans against actual SQLite. */
function fixture() {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const plans: Array<{ sql: string; details: string[] }> = []
  const store = createD1TurnTimingStore({ measuredFacts: false, db: {
    prepare: sql => ({ bind: (...values) => ({
      run: async () => sqlite.prepare(sql).run(...values),
      all: async <T>() => {
        if (sql.startsWith('SELECT') && sql.includes('rollout_turn_timing')) {
          const explanation = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>
          plans.push({ sql, details: explanation.map(row => row.detail) })
        }
        return { results: sqlite.prepare(sql).all(...values) as T[] }
      },
    }) }),
  } })
  const record = (row: Pick<TurnTimingRow, 'turnId'> & Partial<TurnTimingRow>) => store.record({
    rollout: 'r', workspaceId: 'w', lane: 'sandbox', settledMs: 500, failed: false,
    admissionMs: 10, firstVisibleMs: 100, firstTextMs: 110, ...row,
  }, { throwOnError: true })
  return { sqlite, store, plans, record }
}

it('selects request receipt boundaries even when settlement is in another window and keeps unknown origins unassigned', async () => {
  const { sqlite, store, record } = fixture()
  try {
    await record({ turnId: 'before', requestReceivedAt: 99, at: 150, failed: true })
    await record({ turnId: 'since', requestReceivedAt: 100, at: 500 })
    await record({ turnId: 'inside', requestReceivedAt: 199, at: 50, failed: true, firstVisibleMs: 300 })
    await record({ turnId: 'missing-visibility', requestReceivedAt: 150, at: 800, firstVisibleMs: undefined, firstTextMs: undefined })
    await record({ turnId: 'until', requestReceivedAt: 200, at: 150 })
    await record({ turnId: 'legacy-since', at: 100, failed: true })
    await record({ turnId: 'legacy-inside', lane: 'loop', at: 199 })
    await record({ turnId: 'legacy-before', at: 99, failed: true })
    await record({ turnId: 'legacy-until', at: 200, failed: true })
    expect(await store.measureRequestOrigin({ rollout: 'r', since: 100, until: 200 })).toMatchObject({
      samples: 3, failed: 1, failureRate: 1 / 3, requestOriginFirstVisibleP50Ms: 110,
      selection: { clock: 'request-received-at' }, truncated: false,
      coverage: { firstVisible: 2, requestOriginFirstVisible: 2 }, unknownCoverage: { firstVisible: 1 },
      unassignedOrigins: { samples: 2, failed: 1, truncated: false, selection: { clock: 'settled-at' },
        window: { from: new Date(100).toISOString(), to: new Date(200).toISOString() } },
    })
    expect(await store.measureRequestOrigin({ rollout: 'r', lane: 'loop', since: 100, until: 200 })).toMatchObject({
      samples: 0, failed: 0, failureRate: null, requestOriginFirstVisibleP50Ms: null,
      unassignedOrigins: { samples: 1, failed: 0 },
    })
  } finally { sqlite.close() }
})

it('uses range indexes without a temporary sort for all-lane and selected-lane request and unassigned windows', async () => {
  const { sqlite, store, record, plans } = fixture()
  try {
    await record({ turnId: 'known', requestReceivedAt: 150, at: 500, revision: 'release' })
    await record({ turnId: 'empty-revision', requestReceivedAt: 150, at: 500, revision: '' })
    await record({ turnId: 'null-revision', requestReceivedAt: 150, at: 500 })
    await record({ turnId: 'unknown', at: 150 })
    for (const lane of [undefined, 'sandbox']) {
      for (const revision of [undefined, 'release', null]) {
        plans.length = 0
        const measured = await store.measureRequestOrigin({ rollout: 'r', lane, revision, since: 100, until: 200 })
        expect(measured.samples).toBe(revision === undefined ? 3 : revision === null ? 2 : 1)
        expect(measured.unassignedOrigins.samples).toBe(revision === 'release' ? 0 : 1)
        expect(plans).toHaveLength(2)
        for (const [index, plan] of plans.entries()) {
          const details = plan.details.join('\n')
          expect(details).not.toContain('TEMP B-TREE')
          if (index === 0) {
            expect(details).toMatch(/USING (?:COVERING )?INDEX rollout_turn_timing_by_(?:lane_)?request_origin \(/)
            expect(details).toMatch(/rollout=\?.*request_received_at>\? AND request_received_at<\?/)
          } else if (/INDEX rollout_turn_timing_by_lane \(/.test(details)) {
            // SQLite may prefer the existing lane/settlement index for this
            // NULL-origin bucket; both plans bound the actual settlement range.
            expect(lane).toBeDefined()
            expect(details).toMatch(/rollout=\? AND lane=\? AND at>\? AND at<\?/)
          } else {
            expect(details).toMatch(/USING (?:COVERING )?INDEX rollout_turn_timing_by_(?:lane_)?request_origin \(/)
            expect(details).toMatch(/request_received_at=\? AND at>\? AND at<\?/)
          }
          expect(plan.sql).not.toContain('? IS NULL')
          expect(plan.sql.includes('lane = ?')).toBe(lane !== undefined)
          if (revision === 'release') expect(plan.sql).toContain('revision = ?')
          if (revision === null) expect(plan.sql).toContain("(revision IS NULL OR revision = '')")
        }
      }
    }
  } finally { sqlite.close() }
})

it('reports independent truncation and orders limited samples by the clock assigned to each population', async () => {
  const { sqlite, store } = fixture()
  try {
    sqlite.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 20001)
      INSERT INTO rollout_turn_timing(turn_id, rollout, workspace_id, lane, revision, request_received_at, admission_ms,
        first_visible_ms, first_text_ms, settled_ms, failed, at)
      SELECT 'known-' || n, 'r', 'w', 'sandbox', 'release', n, 0, n, n, 1, n = 1, 30000 - n FROM numbers;
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 20001)
      INSERT INTO rollout_turn_timing(turn_id, rollout, workspace_id, lane, settled_ms, failed, at)
      SELECT 'unknown-' || n, 'r', 'w', 'sandbox', 1, n = 1, n FROM numbers;`)
    expect(await store.measureRequestOrigin({ rollout: 'r', since: 0, until: 30000 })).toMatchObject({
      samples: 20000, failed: 0, truncated: true, requestOriginFirstVisibleP50Ms: 10001,
      unassignedOrigins: { samples: 20000, failed: 0, truncated: true },
    })
    expect(await store.measureRequestOrigin({ rollout: 'r', since: 20000, until: 30000 })).toMatchObject({
      samples: 2, truncated: false, unassignedOrigins: { samples: 2, truncated: false },
    })
    expect(await store.measureRequestOrigin({ rollout: 'r', revision: 'release', since: 0, until: 30000 })).toMatchObject({
      samples: 20000, truncated: true, unassignedOrigins: { samples: 0, truncated: false },
    })
    expect(await store.measureRequestOrigin({ rollout: 'r', revision: null, since: 0, until: 30000 })).toMatchObject({
      samples: 0, truncated: false, unassignedOrigins: { samples: 20000, truncated: true },
    })
  } finally { sqlite.close() }
})

it('adds idempotent request-window indexes to an existing table without backfilling historical origins', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL.replace(ROLLOUT_TURN_TIMING_REQUEST_WINDOW_INDEX_MIGRATION_SQL, ''))
    sqlite.exec("INSERT INTO rollout_turn_timing(turn_id, rollout, workspace_id, lane, settled_ms, failed, at) VALUES ('old','r','w','sandbox',1,0,10)")
    sqlite.exec(ROLLOUT_TURN_TIMING_REQUEST_WINDOW_INDEX_MIGRATION_SQL)
    sqlite.exec(ROLLOUT_TURN_TIMING_REQUEST_WINDOW_INDEX_MIGRATION_SQL)
    expect(sqlite.prepare('SELECT request_received_at FROM rollout_turn_timing').get()).toEqual({ request_received_at: null })
    const indexes = sqlite.prepare('PRAGMA index_list(rollout_turn_timing)').all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      'rollout_turn_timing_by_request_origin', 'rollout_turn_timing_by_lane_request_origin',
    ]))
  } finally { sqlite.close() }
})
