/**
 * The checks apps run in their own suites, each shown to fail on the defect it
 * exists for and to pass on the fix.
 */
import { describe, expect, it } from 'vitest'

import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createAuthLookupCache, createLimitAlarms, credentialCacheKey, isEdgeBlock, type LimitBudgets } from '../../src/launch-invariants/index'
import {
  checkAuthorizeBeforeStream,
  checkAuthSurvivesStall,
  checkChatAcceptsCode,
  checkCoalescedTurn,
  checkLimitAlarms,
  checkScheduledJobBudgets,
  recordedLongTurn,
  stallingD1,
} from '../../src/launch-invariants/testing'
import { coalesceDeltas, createBufferedTurnTap, createD1TurnEventStore, createMemoryTurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { sqliteD1 } from './sqlite-d1'

const MB = 1024 * 1024

describe('bounded reads and the memory budget on a day-sized fixture', () => {
  // 60 replies of 1 MB each, as a day of long tool-heavy turns stores them.
  const { d1, sqlite } = sqliteD1('CREATE TABLE message (id TEXT PRIMARY KEY, parts TEXT)')
  const insert = sqlite.prepare('INSERT INTO message VALUES (?, ?)')
  for (let n = 0; n < 60; n += 1) insert.run(`m${n}`, JSON.stringify([{ type: 'tool', output: `${n}`.padEnd(MB, 'x') }]))
  let db: typeof d1 = d1
  const install = (measured: object) => { db = measured as typeof d1 }

  const unbounded = async () => {
    const { results } = await db.prepare('SELECT id, parts FROM message').all<{ parts: string }>()
    return results.filter((row) => row.parts.includes('"5')).length
  }
  const sized = async () => {
    const { sizedBatches } = await import('../../src/launch-invariants/index')
    const { results: listed } = await db.prepare('SELECT id, length(parts) AS size FROM message').all<{ id: string; size: number }>()
    let matches = 0
    for (const ids of sizedBatches(listed.map((row) => ({ key: row.id, size: row.size })))) {
      const { results } = await db.prepare(`SELECT parts FROM message WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ parts: string }>()
      matches += results.filter((row) => row.parts.includes('"5')).length
    }
    return matches
  }
  const kept: string[] = []
  const keeper = async () => {
    const { results: listed } = await db.prepare('SELECT id FROM message').all<{ id: string }>()
    for (const { id } of listed) {
      const row = await db.prepare('SELECT parts FROM message WHERE id = ?').bind(id).first<{ parts: string }>()
      kept.push(row!.parts)
    }
  }

  it('fails a job that reads the day in one query, naming the query, and passes the sized read', async () => {
    const verdicts = await checkScheduledJobBudgets({
      d1, install, scheduled: ['unbounded', 'sized'],
      jobs: [{ name: 'unbounded', run: unbounded }, { name: 'sized', run: sized }],
    })
    const reads = verdicts.filter((verdict) => verdict.invariant === 'bounded-reads')
    expect(reads.map((verdict) => [verdict.subject, verdict.pass])).toEqual([['unbounded', false], ['sized', true]])
    expect(reads[0]!.details[0]).toMatch(/one query returned 60\.\d MB .*SELECT id, parts FROM message/)
  }, 60_000)

  it('fails a job that keeps what it read, at the query where the heap peaked', async () => {
    const [, memory] = await checkScheduledJobBudgets({ d1, install, scheduled: ['keeper'], jobs: [{ name: 'keeper', run: keeper }] })
    kept.length = 0
    expect(memory!.pass).toBe(false)
    expect(memory!.details[0]).toMatch(/the live heap grew \d+\.\d MB .*SELECT parts FROM message WHERE id = \?/)
  }, 60_000)

  it('fails coverage when a scheduled job is not run on the fixture', async () => {
    const verdicts = await checkScheduledJobBudgets({ d1, install, scheduled: ['sized', 'turn-health'], jobs: [{ name: 'sized', run: sized }] })
    expect(verdicts.at(-1)).toMatchObject({ invariant: 'memory-budget', subject: 'coverage', pass: false, details: ['turn-health is scheduled but not run on the fixture'] })
  }, 60_000)
})

describe('auth survives a D1 stall', () => {
  function app(options: { cache: boolean }) {
    const { d1, sqlite } = sqliteD1('CREATE TABLE api_key (hash TEXT PRIMARY KEY, owner TEXT, revoked INTEGER DEFAULT 0)')
    const flaky = stallingD1(d1)
    const keys = createAuthLookupCache<{ owner: string; hash: string }>({ label: 'api-key', warn: () => {} })
    const read = (hash: string) => async () => flaky.d1.prepare('SELECT owner, hash FROM api_key WHERE hash = ? AND revoked = 0').bind(hash).first<{ owner: string; hash: string }>()
    return {
      sqlite,
      flaky,
      keys,
      async issue(secret: string) {
        sqlite.prepare('INSERT INTO api_key (hash, owner) VALUES (?, ?)').run(await credentialCacheKey(secret), 'owner')
      },
      async verify(secret: string) {
        const hash = await credentialCacheKey(secret)
        return options.cache ? keys.lookup(hash, read(hash)) : read(hash)()
      },
      async revoke(secret: string) {
        const hash = await credentialCacheKey(secret)
        sqlite.prepare('UPDATE api_key SET revoked = 1 WHERE hash = ?').run(hash)
        keys.invalidate((value) => value.hash === hash)
      },
    }
  }

  async function check(subject: ReturnType<typeof app>, hang: boolean) {
    for (const secret of ['key-a', 'key-b', 'key-c']) await subject.issue(secret)
    return checkAuthSurvivesStall({
      subject: 'api key',
      credentials: { cached: 'key-a', revoked: 'key-b', aged: 'key-c' },
      verify: (secret) => subject.verify(secret),
      revoke: (secret) => subject.revoke(secret),
      stall: (mode) => subject.flaky.stall(mode),
      cacheKeys: () => subject.keys.keys(),
      hang,
    })
  }

  it('passes a lookup behind the shared cache, including a stall that never answers', async () => {
    const verdict = await check(app({ cache: true }), true)
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
  }, 15_000)

  it('fails a lookup that reads D1 alone', async () => {
    const verdict = await check(app({ cache: false }), false)
    expect(verdict.pass).toBe(false)
    expect(verdict.details).toContain('a credential verified moments before was refused while D1 errored')
  })
})

describe('authorization before any stream', () => {
  const store: ChatTurnMessageStore = { async listMessages() { return [] }, async appendMessage() { return { id: 'm' } } }
  const refusals = [{ name: 'no session', request: () => new Request('http://app.test/api/chat', { method: 'POST', body: JSON.stringify({ threadId: 't', content: 'hi' }) }) }]

  it('passes the shared turn route with a refusing authorize', async () => {
    const routes = createChatTurnRoutes({
      projectId: 'probe',
      authorize: async () => ({ ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
      store,
      turnStore: createMemoryTurnEventStore(),
      incrementalPersistence: false,
      produce: () => { throw new Error('produced before authorize') },
      log: () => {},
    })
    const verdict = await checkAuthorizeBeforeStream({ subject: 'POST /api/chat', handle: (request) => routes.turn(request, { waitUntil: () => {} }), refused: refusals })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
  })

  it('fails a route that opens its stream before it refuses', async () => {
    const touched: string[] = []
    const verdict = await checkAuthorizeBeforeStream({
      subject: 'POST /api/chat',
      handle: async () => {
        touched.push('stream')
        return new Response('{"type":"turn"}\n{"error":"Unauthorized"}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
      },
      refused: refusals,
      touched: () => touched,
    })
    expect(verdict.details).toEqual([
      'no session: answered 200, expected 401 or 403 or 404',
      'no session: opened a application/x-ndjson stream before refusing',
      'no session: touched stream before refusing',
    ])
  })
})

describe('coalesced turn events on the recorded long turn', () => {
  it('reproduces the recorded turn\'s 59,659 events', () => {
    expect(recordedLongTurn()).toHaveLength(59_659)
  })

  function persistence(coalesce: (events: unknown[]) => unknown[]) {
    const { d1 } = sqliteD1(TURN_EVENTS_MIGRATION_SQL)
    const store = createD1TurnEventStore(d1)
    return {
      open: async (turnId: string) => {
        const tap = createBufferedTurnTap({ store, turnId, scopeId: 'thread', coalesce })
        return { onEvent: tap.onEvent, detach: tap.detach, done: () => tap.done('complete') }
      },
      count: async (turnId: string) => (await d1.prepare('SELECT count(*) AS n FROM turn_events WHERE turnId = ?').bind(turnId).first<{ n: number }>())!.n,
    }
  }

  it('passes the shared turn buffer, attached and after a handoff', async () => {
    const verdict = await checkCoalescedTurn({ subject: 'turn buffer', ...persistence(coalesceDeltas) })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
    expect(Object.values(verdict.data!.stored as Record<string, number>).every((count) => count > 0 && count <= 5_000)).toBe(true)
  }, 120_000)

  it('fails a buffer that stores every delta', async () => {
    const verdict = await checkCoalescedTurn({ subject: 'turn buffer', ...persistence((events) => events) })
    expect(verdict.pass).toBe(false)
    expect(verdict.details[0]).toMatch(/^attached: the recorded long turn \(59,659 events\) stored \d{2},\d{3}; the most is 5,000$/)
  }, 120_000)
})

describe('platform-limit alarms', () => {
  const budgets: LimitBudgets = { 'worker-memory': 128 * MB, 'd1-rows-per-query': 100_000, 'sandbox-disk': 10 * 1024 * MB, 'snapshot-count': 25, 'key-rate': 60 }

  it('passes alarms at 80% within the platform limits', async () => {
    const verdict = await checkLimitAlarms({ subject: 'gtm', create: (sink) => createLimitAlarms({ product: 'gtm', budgets, sink }) })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
  })

  it('fails alarms tuned to 90%, and a memory limit above the Worker\'s', async () => {
    const verdict = await checkLimitAlarms({
      subject: 'gtm',
      create: (sink) => createLimitAlarms({ product: 'gtm', budgets: { ...budgets, 'worker-memory': 256 * MB }, sink, ratio: 0.9 }),
    })
    expect(verdict.details).toContain('worker-memory: the declared limit 268435456 is above the platform\'s 134217728')
    expect(verdict.details).toContain('key-rate: did not warn at 80% of its limit')
  })
})

describe('pasted code reaches the chat', () => {
  const chatRequest = (text: string) => new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'session=valid' },
    body: JSON.stringify({ threadId: 't', content: text }),
  })
  const store: ChatTurnMessageStore = { async listMessages() { return [] }, async appendMessage() { return { id: 'm' } } }
  const routes = (authorize: (content: string) => Response | null) => createChatTurnRoutes({
    projectId: 'probe',
    authorize: async ({ body }) => {
      const refusal = authorize(String(body?.content ?? ''))
      return refusal ? { ok: false as const, response: refusal } : { ok: true as const, tenantId: 'ws', userId: 'user', context: {} }
    },
    store,
    turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false,
    produce: () => ({ stream: (async function* () { yield { type: 'text', text: 'ok' } as { type: string } })(), finalText: () => 'ok' }),
    log: () => {},
  })

  it('passes a route that answers every sample normally', async () => {
    const turns = routes(() => null)
    const verdict = await checkChatAcceptsCode({ subject: 'POST /api/chat', handle: (request) => turns.turn(request, { waitUntil: () => {} }), request: chatRequest })
    expect(verdict.pass, verdict.details.join('\n')).toBe(true)
  })

  it('fails an app filter that refuses shell text, and an edge block page', async () => {
    const filtered = routes((content) => (/\/etc\//.test(content) ? Response.json({ error: 'Request blocked' }, { status: 400 }) : null))
    const verdict = await checkChatAcceptsCode({ subject: 'POST /api/chat', handle: (request) => filtered.turn(request, { waitUntil: () => {} }), request: chatRequest })
    expect(verdict.details).toEqual([
      'file read: answered 400: {"error":"Request blocked"}',
      'fenced bash block: answered 400: {"error":"Request blocked"}',
      'path traversal: answered 400: {"error":"Request blocked"}',
    ])
    const blocked = await checkChatAcceptsCode({
      subject: 'edge',
      handle: async () => new Response('<title>Attention Required! | Cloudflare</title>', { status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' } }),
      request: chatRequest,
      samples: [{ name: 'file read', text: 'cat /etc/passwd' }],
    })
    expect(blocked.details).toEqual(['file read: an edge rule blocked it (403)'])
  })

  it('tells an edge block from the app\'s own refusal', async () => {
    expect(await isEdgeBlock(new Response('x', { status: 403, headers: { 'cf-mitigated': 'challenge' } }))).toBe(true)
    expect(await isEdgeBlock(new Response('<h1>Sorry, you have been blocked</h1>', { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' } }))).toBe(true)
    expect(await isEdgeBlock(Response.json({ error: 'Unauthorized' }, { status: 401, headers: { server: 'cloudflare' } }))).toBe(false)
  })
})
