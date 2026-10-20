import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_SCHEMA_SQL, ROLLOUT_TURN_TIMING_FIRST_VISIBLE_MIGRATION_SQL, stageMetrics, type D1LikeForRollout } from './d1'
import { decideRollout, type RolloutPlan } from './index'

function d1(): D1LikeForRollout {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => sqlite.prepare(sql).run(...(values as never[])),
  })
  return { prepare: (sql: string) => statement(sql) }
}

const plan: RolloutPlan = { name: 'routed-chat', variable: 'ROUTED_IDS', stages: [
  { name: 'qa', value: 'ws-qa', minSamples: 3, kill: { first_words_p50_ms: { max: 1500 }, failure_rate: { max: 0 } } },
  { name: 'all', value: '*', minSamples: 10, kill: { first_words_p50_ms: { max: 1500 }, failure_rate: { max: 0.01 } } },
] }

describe('rollout turn timing', () => {
  it('counts a turn with no word as failed and computes percentiles', () => {
    expect(stageMetrics([{ firstTextMs: 900, settledMs: 2000, failed: false }, { firstTextMs: 1200, settledMs: 2500, failed: false },
      { settledMs: 9000, failed: false }, { firstTextMs: 4000, settledMs: 6000, failed: true }])).toMatchObject({
      first_words_p50_ms: 1200, first_words_p90_ms: 4000, failure_rate: 0.5 })
  })

  it('migrates an existing table without inventing historical visibility and records both timings', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL.replace('  first_visible_ms INTEGER,\n', ''))
    sqlite.exec(`INSERT INTO rollout_turn_timing VALUES ('old', 'routed-chat', 'ws-qa', 'routed', 1200, 2000, 0, NULL, 5000)`)
    sqlite.exec(ROLLOUT_TURN_TIMING_FIRST_VISIBLE_MIGRATION_SQL)
    const db: D1LikeForRollout = { prepare: sql => ({ bind: (...values) => ({
      run: async () => sqlite.prepare(sql).run(...values),
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    }) }) }
    const store = createD1TurnTimingStore({ db })
    await store.record({ turnId: 'new', rollout: 'routed-chat', workspaceId: 'ws-qa', lane: 'routed',
      firstVisibleMs: 300, firstTextMs: 1500, settledMs: 2000, failed: false, at: 6000 })
    expect(sqlite.prepare('SELECT first_visible_ms, first_text_ms FROM rollout_turn_timing ORDER BY at').all()).toEqual([
      { first_visible_ms: null, first_text_ms: 1200 }, { first_visible_ms: 300, first_text_ms: 1500 },
    ])
    const measured = await store.measureStage({ rollout: 'routed-chat', stage: plan.stages[0]!, lane: 'routed', since: 0 })
    expect(measured.metrics).toMatchObject({ first_visible_p50_ms: 300, first_visible_p90_ms: 300, first_words_p50_ms: 1200 })
    sqlite.close()
  })

  it('measures a stage on its workspaces, its lane and its window, and feeds the guard', async () => {
    const store = createD1TurnTimingStore({ db: d1(), now: () => 10_000 })
    const turn = (id: string, ws: string, lane: string, firstTextMs: number, at: number) =>
      store.record({ turnId: id, rollout: 'routed-chat', workspaceId: ws, lane, firstTextMs, settledMs: firstTextMs + 800, failed: false, at })
    await turn('t1', 'ws-qa', 'routed', 1100, 5_000)
    await turn('t2', 'ws-qa', 'routed', 1300, 6_000)
    await turn('t3', 'ws-qa', 'routed', 3540, 7_000)
    await turn('t3', 'ws-qa', 'routed', 1, 7_000) // a retried record is ignored
    await turn('t4', 'ws-other', 'routed', 9000, 7_000) // not in the stage
    await turn('t5', 'ws-qa', 'sandbox', 30000, 7_000) // not the rolled-out lane
    await turn('t6', 'ws-qa', 'routed', 9000, 1_000) // before the window
    const measured = await store.measureStage({ rollout: 'routed-chat', stage: plan.stages[0]!, lane: 'routed', since: 2_000 })
    expect(measured).toMatchObject({ stage: 'qa', samples: 3, metrics: { first_words_p50_ms: 1300, failure_rate: 0 } })

    const decision = await decideRollout({ plan, fromValue: 'ws-qa', toValue: '*', measure: async () => measured })
    expect(decision).toMatchObject({ decision: 'allowed' })
  })
})
