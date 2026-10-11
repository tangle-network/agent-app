/**
 * The Worker-side pieces of `/launch-invariants`: sized reads, the auth lookup
 * cache, one job per scheduled invocation, 80% limit alarms and the
 * settlement rule, each against the failure it answers.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  AUTH_LOOKUP_TTL_MS,
  AuthLookupRefused,
  checkIsolatedJobs,
  checkSettlementScenarios,
  checkTurnSettlement,
  createAuthLookupCache,
  createLimitAlarms,
  createScheduledDispatch,
  credentialCacheKey,
  estimatedBytes,
  cronDailyFirings,
  longestGapMinutes,
  parseWranglerCrons,
  SETTLEMENT_SCENARIOS,
  sizedBatches,
  slotsOf,
  withD1LimitAlarms,
  type LimitBudgets,
  type SettledTurnRecord,
} from '../../src/launch-invariants/index'
import type { TurnHealthAlert } from '../../src/turn-health/sink'
import { sqliteD1 } from './sqlite-d1'

const MB = 1024 * 1024

describe('sized batches', () => {
  it('keeps each batch within the byte budget and reads an oversized row alone', () => {
    const rows = [1.5, 1.5, 1.5, 9, 0.5, null].map((size, key) => ({ key, size: size === null ? null : size * MB }))
    expect(sizedBatches(rows)).toEqual([[0, 1], [2], [3], [4, 5]])
  })

  it('binds at most the row cap, and Infinity rows for a range read', () => {
    const rows = Array.from({ length: 120 }, (_, key) => ({ key, size: 10 }))
    expect(sizedBatches(rows).map((batch) => batch.length)).toEqual([50, 50, 20])
    expect(sizedBatches(rows, { rows: 40 }).map((batch) => batch.length)).toEqual([40, 40, 40])
    expect(sizedBatches(rows, { rows: Infinity })).toHaveLength(1)
  })
})

describe('the auth lookup cache', () => {
  let clock = 0
  const cache = () => createAuthLookupCache<{ id: string }>({ label: 'test', now: () => clock, deadlineMs: 50, warn: () => {} })
  const down = () => Promise.reject(new Error('D1_ERROR: storage operation exceeded timeout'))
  beforeEach(() => { clock = 1_000_000 })

  it('serves the last valid result only while the store errors, for the TTL from its verification', async () => {
    const lookups = cache()
    expect(await lookups.lookup('k', async () => ({ id: 'owner' }))).toEqual({ id: 'owner' })
    clock += AUTH_LOOKUP_TTL_MS - 1000
    expect(await lookups.lookup('k', down)).toEqual({ id: 'owner' })
    clock += 2000
    await expect(lookups.lookup('k', down)).rejects.toThrow('D1_ERROR')
  })

  it('serves the verified object itself, so identity-keyed state still finds it', async () => {
    const lookups = cache()
    const verified = { id: 'owner' }
    const claims = new WeakMap([[verified, 'claim']])
    await lookups.lookup('k', async () => verified)
    expect(claims.get((await lookups.lookup('k', down))!)).toBe('claim')
  })

  it('never answers from the cache once the store refuses, nor past expiry, nor past a 60 s TTL', async () => {
    const lookups = createAuthLookupCache<{ id: string }>({ label: 'test', now: () => clock, ttlMs: 10 * 60_000, warn: () => {} })
    await lookups.lookup('revoked', async () => ({ id: 'a' }))
    expect(await lookups.lookup('revoked', async () => null)).toBeNull()
    await expect(lookups.lookup('revoked', down)).rejects.toThrow('D1_ERROR')
    await lookups.lookup('refused', async () => ({ id: 'a' }))
    await expect(lookups.lookup('refused', () => Promise.reject(new AuthLookupRefused('refused')))).rejects.toThrow('refused')
    await expect(lookups.lookup('refused', down)).rejects.toThrow('D1_ERROR')
    await lookups.lookup('expiring', async () => ({ id: 'a' }), { expiresAt: () => clock + 5000 })
    await lookups.lookup('long', async () => ({ id: 'a' }))
    clock += 61_000
    await expect(lookups.lookup('expiring', down)).rejects.toThrow('D1_ERROR')
    await expect(lookups.lookup('long', down)).rejects.toThrow('D1_ERROR')
  })

  it('treats a stalled store as unavailable after the deadline', async () => {
    const lookups = cache()
    await lookups.lookup('k', async () => ({ id: 'owner' }))
    expect(await lookups.lookup('k', () => new Promise(() => {}))).toEqual({ id: 'owner' })
    await expect(lookups.lookup('other', () => new Promise(() => {}))).rejects.toThrow('did not answer within 50 ms')
  })

  it('keys credentials by SHA-256', async () => {
    expect(await credentialCacheKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('one job per scheduled invocation', () => {
  const noop = async () => {}
  const jobs = { 'post-scheduler': noop, reliability: noop, 'turn-recovery': noop, 'orphan-settlement': noop, digest: noop }
  const entries = [
    { cron: '0,3 * * * *', minutes: { 0: 'post-scheduler', 3: 'reliability' } },
    { cron: '7,22,37,52 * * * *', job: 'turn-recovery' },
    { cron: '8,23,38,53 * * * *', job: 'orphan-settlement' },
    { cron: '0 7 * * *', job: 'digest' },
  ]

  it('runs the job for the tick\'s minute, alone, and reports a tick no entry handles', async () => {
    const ran: string[] = []
    const dispatch = createScheduledDispatch<null>({
      entries,
      jobs: Object.fromEntries(Object.keys(jobs).map((name) => [name, async () => { ran.push(name) }])),
      log: { info: () => {}, error: () => {} },
    })
    expect((await dispatch.dispatch({ cron: '0,3 * * * *', scheduledTime: Date.UTC(2026, 9, 10, 21, 3) }, null)).job).toBe('reliability')
    expect(ran).toEqual(['reliability'])
    expect(await dispatch.dispatch({ cron: '0 * * * *', scheduledTime: Date.UTC(2026, 9, 10, 21, 0) }, null)).toMatchObject({ handled: false, job: null })
    expect(ran).toEqual(['reliability'])
  })

  it('retries a failed job and never rejects the tick', async () => {
    let calls = 0
    const dispatch = createScheduledDispatch<null>({
      entries: [{ cron: '0 7 * * *', job: 'digest' }],
      jobs: { digest: async () => { calls += 1; if (calls < 3) throw new Error('D1_ERROR: overloaded') } },
      retryDelaysMs: [0, 0],
      sleep: async () => {},
      log: { info: () => {}, error: () => {} },
    })
    const result = await dispatch.dispatch({ cron: '0 7 * * *', scheduledTime: Date.UTC(2026, 9, 10, 7) }, null)
    expect(await result.done).toMatchObject({ job: 'digest', ok: true, attempts: 3 })
  })

  it('refuses a table whose minutes disagree with its cron, or that names an unknown job', () => {
    expect(() => createScheduledDispatch({ entries: [{ cron: '0,1 * * * *', minutes: { 0: 'digest' } }], jobs })).toThrow('lists minutes 0,1 but maps jobs to 0')
    expect(() => createScheduledDispatch({ entries: [{ cron: '0 * * * *', job: 'missing' }], jobs })).toThrow('"missing", which is not defined')
  })

  it('passes a table that matches the deployment and recovers every 15 minutes', () => {
    const verdict = checkIsolatedJobs({
      configuredCrons: entries.map((entry) => entry.cron),
      slots: slotsOf(entries).map((slot) => ({ ...slot, jobs: [slot.job] })),
      recoveryJobs: ['turn-recovery', 'orphan-settlement'],
    })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
  })

  it('fails three recovery sweeps in one invocation, an unconfigured cron, and an hourly settlement', () => {
    const verdict = checkIsolatedJobs({
      configuredCrons: ['7,22,37,52 * * * *', '0 * * * *'],
      slots: [
        { cron: '7,22,37,52 * * * *', jobs: ['completion-recovery', 'abandoned-turns', 'orphaned-turn-streams'] },
        { cron: '0 * * * *', jobs: ['orphan-settlement'] },
        { cron: '0 3 * * *', jobs: ['spend'] },
      ],
      recoveryJobs: ['completion-recovery', 'orphan-settlement'],
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.details.join('\n')).toContain('runs 3 jobs in one invocation')
    expect(verdict.details.join('\n')).toContain('schedule cron "0 3 * * *" is not configured')
    expect(verdict.details.join('\n')).toContain('"orphan-settlement" can wait 60 minutes')
    expect(verdict.details.join('\n')).toContain('"completion-recovery" is not scheduled to run every day on its own')
  })

  it('reads cron firings and the longest gap between them', () => {
    expect(longestGapMinutes(cronDailyFirings('*/15 * * * *')!)).toBe(15)
    expect(longestGapMinutes(cronDailyFirings('7,22,37,52 * * * *')!)).toBe(15)
    expect(longestGapMinutes(cronDailyFirings('0 */4 * * *')!)).toBe(240)
    expect(cronDailyFirings('0 3 * * SUN')).toBeNull()
  })

  it('reads crons from wrangler.toml and wrangler.jsonc, per environment', () => {
    const toml = [
      '[triggers]',
      'crons = [',
      '  "0,1,2 * * * *",   # hourly, one sweep per minute',
      "  '7,22,37,52 * * * *',",
      ']',
      '[env.staging.triggers]',
      'crons = ["0 */4 * * *"] # staging',
    ].join('\n')
    expect(parseWranglerCrons(toml, 'toml')).toEqual({ top: ['0,1,2 * * * *', '7,22,37,52 * * * *'], envs: { staging: ['0 */4 * * *'] } })
    const jsonc = '{\n // the worker\n "triggers": { "crons": ["*/5 * * * *",] },\n "env": { "stage": { "triggers": { "crons": [] } } }\n}'
    expect(parseWranglerCrons(jsonc, 'json')).toEqual({ top: ['*/5 * * * *'], envs: { stage: [] } })
  })
})

describe('platform-limit alarms', () => {
  const budgets: LimitBudgets = {
    'worker-memory': 128 * MB,
    'd1-rows-per-query': 100_000,
    'sandbox-disk': 10 * 1024 * MB,
    'snapshot-count': 25,
    'key-rate': 60,
  }

  it('warns at 80%, not at 79%, and pages at the limit', async () => {
    const delivered: TurnHealthAlert[] = []
    const alarms = createLimitAlarms({ product: 'gtm', budgets, sink: { deliver: async (alert) => { delivered.push(alert) } } })
    expect((await alarms.observe('snapshot-count', 19)).level).toBe('ok')
    expect((await alarms.observe('snapshot-count', 20)).level).toBe('warning')
    expect((await alarms.observe('snapshot-count', 25)).level).toBe('critical')
    expect(delivered.map((alert) => [alert.severity, alert.key])).toEqual([
      ['warning', 'limit:gtm:snapshot-count'],
      ['critical', 'limit:gtm:snapshot-count'],
    ])
  })

  it('refuses a resource without a limit', () => {
    expect(() => createLimitAlarms({ product: 'gtm', budgets: { ...budgets, 'sandbox-disk': 0 }, sink: { deliver: async () => {} } })).toThrow('sandbox-disk needs a positive limit')
  })

  it('estimates a response\'s size from sampled rows, without serializing all of it', () => {
    const rows = Array.from({ length: 1_000 }, (_, n) => ({ n, parts: 'x'.repeat(1_000) }))
    const exact = JSON.stringify(rows).length
    expect(Math.abs(estimatedBytes(rows) - exact) / exact).toBeLessThan(0.01)
  })

  it('hands D1 batch() its own statements, not the observed wrappers', async () => {
    const { d1, sqlite } = sqliteD1('CREATE TABLE t (n INTEGER)')
    // Like D1, accept only statements this binding prepared or bound, never a wrapper around one.
    const issued = new WeakSet<object>()
    const track = <S extends { bind(...values: unknown[]): S }>(stmt: S): S => {
      issued.add(stmt)
      const bind = stmt.bind.bind(stmt)
      stmt.bind = (...values: unknown[]) => track(bind(...values))
      return stmt
    }
    const binding = {
      prepare: (sql: string) => track(d1.prepare(sql)),
      batch: async (statements: object[]) => {
        if (!statements.every((stmt) => issued.has(stmt))) throw new TypeError('D1_TYPE_ERROR: batch() received a statement it did not prepare')
        return d1.batch(statements as never)
      },
    }
    const alarms = createLimitAlarms({ product: 'gtm', budgets, sink: { deliver: async () => {} } })
    const watched = withD1LimitAlarms(binding, alarms)
    await watched.batch([watched.prepare('INSERT INTO t VALUES (?)').bind(1), watched.prepare('INSERT INTO t VALUES (?)').bind(2)] as never)
    expect(sqlite.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 })
  })

  it('observes the rows each D1 query reads', async () => {
    const delivered: TurnHealthAlert[] = []
    const alarms = createLimitAlarms({ product: 'gtm', budgets: { ...budgets, 'd1-rows-per-query': 10 }, sink: { deliver: async (alert) => { delivered.push(alert) } } })
    const { d1, sqlite } = sqliteD1('CREATE TABLE t (n INTEGER)')
    for (let n = 0; n < 9; n += 1) sqlite.prepare('INSERT INTO t VALUES (?)').run(n)
    const watched = withD1LimitAlarms(d1, alarms, { subject: 'reliability' })
    await watched.prepare('SELECT n FROM t WHERE n < ?').bind(7).all()
    expect(delivered).toHaveLength(0)
    await watched.prepare('SELECT n FROM t').all()
    expect(delivered.map((alert) => alert.data?.resource)).toEqual(['d1-rows-per-query'])
    expect(delivered[0]!.details).toContain('in reliability')
  })
})

describe('honest settlement', () => {
  const now = Date.UTC(2026, 9, 10, 23, 0)
  const min = 60_000

  it('names a stale running turn, a late notice, a second terminal, an aborted tool counted as an answer and a failure without Retry', () => {
    const turns: SettledTurnRecord[] = [
      { turnId: 'stale', requestedAt: now - 125 * min, terminals: [], ownerEndedAt: now - 120 * min },
      { turnId: 'late', requestedAt: now - 11 * 60 * min, terminals: [{ state: 'failed', at: now, code: 'stream.orphaned', retryable: true }], ownerEndedAt: now - 8 * 60 * min },
      { turnId: 'twice', requestedAt: now - 20 * min, terminals: [{ state: 'failed', at: now - 10 * min, code: 'x', retryable: true }, { state: 'answered', at: now - 5 * min }], ownerEndedAt: now - 12 * min },
      { turnId: 'aborted', requestedAt: now - 20 * min, terminals: [{ state: 'answered', at: now - 15 * min }], ownerEndedAt: now - 16 * min, abortedToolCall: true },
      { turnId: 'no-retry', requestedAt: now - 20 * min, terminals: [{ state: 'failed', at: now - 15 * min, code: 'x', retryable: false, attributedTo: now - 15 * min }], ownerEndedAt: now - 16 * min },
    ]
    const verdict = checkTurnSettlement(turns, { now })
    const text = verdict.details.join('\n')
    expect(verdict.pass).toBe(false)
    expect(text).toContain('turn stale is still open 120 min after its owner stopped')
    expect(text).toContain('turn late was settled 480 min after its owner stopped')
    expect(text).toContain('turn twice has 2 terminal states')
    expect(text).toContain('turn aborted is counted as an answer')
    expect(text).toContain('turn no-retry failed without offering Retry')
    expect(text).toContain('not its request time')
  })

  it('passes each scenario settled to its honest state, and fails one that is not', () => {
    const settled = (state: SettledTurnRecord['terminals'][number]['state'] | 'open', minutesAgo: number, endedAgo: number | null): SettledTurnRecord => ({
      turnId: `t-${minutesAgo}`,
      requestedAt: now - minutesAgo * min,
      terminals: state === 'open' ? [] : [{ state, at: now, ...(state === 'failed' ? { code: 'turn.failed', retryable: true } : {}) }],
      ownerEndedAt: endedAgo === null ? null : now - Math.min(endedAgo, 10) * min,
    })
    const records = Object.fromEntries(SETTLEMENT_SCENARIOS.map((scenario) => [scenario.id, settled(scenario.expect, scenario.requestedMinutesAgo, scenario.ownerEndedMinutesAgo)]))
    expect(checkSettlementScenarios(records, { now }).pass).toBe(true)
    const answeredWithAbort = { ...records, 'completed-with-aborted-tool': settled('answered', 20, 18) }
    expect(checkSettlementScenarios(answeredWithAbort, { now }).details.join('\n')).toContain('scenario completed-with-aborted-tool: ended answered, expected failed')
  })
})
