/** Composed chat routes over real SQLite, through the D1 binding contract.
 * No mocked database calls: queries execute, batches require original statements,
 * and SQL errors propagate through the same proxy as successful calls. */
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createProductLimitAlarms, withD1LimitAlarms, currentD1QueryCounter } from '../../src/launch-invariants/index'
import { buildTurnTraceOtelSpans, type TurnTraceSnapshot } from '../../src/turn-trace/index'

class SqliteStatement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly args: unknown[] = []) {}
  bind(...args: unknown[]) { return new SqliteStatement(this.db, this.sql, args) }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args as never[]) } }
  async first() { return this.db.prepare(this.sql).get(...this.args as never[]) ?? null }
  async raw() { const stmt = this.db.prepare(this.sql); stmt.setReturnArrays(true); return stmt.all(...this.args as never[]) }
  async run() { return { meta: this.db.prepare(this.sql).run(...this.args as never[]), results: [] } }
}

it('isolates concurrent route counters through detached drains and exports the exact D1 round trips', async () => {
  const engine = new DatabaseSync(':memory:')
  engine.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, thread TEXT, role TEXT, content TEXT)')
  const originals = new WeakSet<SqliteStatement>()
  const binding = withD1LimitAlarms({
    prepare(sql: string) { const stmt = new SqliteStatement(engine, sql); originals.add(stmt); return stmt },
    async batch(statements: SqliteStatement[]) {
      for (const stmt of statements) expect(originals.has(stmt)).toBe(true)
      return Promise.all(statements.map(stmt => stmt.all()))
    },
  }, createProductLimitAlarms({ product: 'd1-trace-integration' }))
  const store: ChatTurnMessageStore = {
    async listMessages(thread) {
      const result = await binding.prepare('SELECT id, role, content FROM messages WHERE thread = ?').bind(thread).all()
      return result.results as never
    },
    async appendMessage(input) {
      const result = await binding.prepare('INSERT INTO messages(thread, role, content) VALUES (?, ?, ?)')
        .bind(input.threadId, input.role, typeof input.content === 'string' ? input.content : '').run()
      return { id: String(result.meta.lastInsertRowid) }
    },
  }
  const snapshots: TurnTraceSnapshot[] = []
  const pending: Promise<unknown>[] = []
  const observed: Record<string, number> = {}
  const routes = createChatTurnRoutes({
    projectId: 'd1-app', store, turnStore: createMemoryTurnEventStore(),
    authorize: async () => {
      await binding.prepare('SELECT 1').first()
      return { ok: true as const, tenantId: 'workspace', userId: 'user', context: {} }
    },
    turnTrace: { sink: snapshot => { snapshots.push(snapshot) } },
    produce: ({ body: { threadId } }) => ({
      stream: (async function* () {
        await new Promise(resolve => setTimeout(resolve, threadId === 'one' ? 15 : 5))
        await binding.batch([binding.prepare('SELECT 1'), binding.prepare('SELECT 2')])
        await binding.prepare('SELECT 1').raw()
        await expect(binding.prepare('SELECT * FROM missing_table').all()).rejects.toThrow()
        if (threadId === 'two') await binding.prepare('SELECT 2').first()
        yield { type: 'text' as const, text: 'Counted.' }
      })(),
      finalText: () => 'Counted.',
    }),
    lifecycle: { onTurnComplete: info => { observed[info.executionId] = currentD1QueryCounter()!.queries } },
  })
  try {
    await binding.prepare('SELECT 1').first() // Outside any turn: never charged to one.
    const responses = await Promise.all(['one', 'two'].map(threadId => routes.turn(new Request('https://app.test/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, content: 'Count.' }),
    }), { waitUntil: promise => { pending.push(promise) } })))
    await Promise.all(responses.map(response => response.text()))
    await Promise.all(pending)
    expect(snapshots).toHaveLength(2)
    const one = snapshots.find(snapshot => snapshot.executionId.includes(':one:'))!
    const two = snapshots.find(snapshot => snapshot.executionId.includes(':two:'))!
    expect(one.summary.d1Queries).toBeGreaterThanOrEqual(7)
    expect(two.summary.d1Queries).toBe(one.summary.d1Queries! + 1)
    for (const snapshot of snapshots) {
      expect(snapshot.summary.d1Queries).toBe(observed[snapshot.executionId])
      expect(buildTurnTraceOtelSpans(snapshot)[0]!.attributes.find(attr => attr.key === 'tangle.turn.d1_queries')?.value)
        .toEqual({ intValue: String(snapshot.summary.d1Queries) })
    }
    expect(currentD1QueryCounter()).toBeUndefined()
    expect(engine.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(4)
  } finally { engine.close() }
})

it('records domain phases over actual SQL and concurrent HTTP work on the composed turn trace', async () => {
  const { createServer } = await import('node:http')
  const engine = new DatabaseSync(':memory:')
  engine.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, thread TEXT, role TEXT, content TEXT)')
  const binding = withD1LimitAlarms({
    prepare: (sql: string) => new SqliteStatement(engine, sql),
    batch: async (statements: SqliteStatement[]) => Promise.all(statements.map(statement => statement.all())),
  }, createProductLimitAlarms({ product: 'phase-integration' }))
  const store: ChatTurnMessageStore = {
    async listMessages(thread) {
      return (await binding.prepare('SELECT id,role,content FROM messages WHERE thread=?').bind(thread).all()).results as never
    },
    async appendMessage(input) {
      const result = await binding.prepare('INSERT INTO messages(thread,role,content) VALUES (?,?,?)')
        .bind(input.threadId, input.role, input.content).run()
      return { id: String(result.meta.lastInsertRowid) }
    },
  }
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => response.end('Read from the real HTTP boundary.'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable')
  let snapshot: TurnTraceSnapshot | undefined
  let originalRoot: string | undefined
  const phaseRows: Record<string, number>[] = []
  const queryRows: Record<string, number>[] = []
  const concurrentRows: Record<string, number>[] = []
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'phase-integration', store, turnStore: createMemoryTurnEventStore(),
    authorize: async ({ trace, span }) => {
      originalRoot = trace!.root.id
      const phases = trace!.timing({ prefix: 'product', kinds: { parallel_sql: 'other', parallel_http: 'network' } })
      phases.within(span)
      await binding.prepare('SELECT 1').first()
      phases.mark('identity')
      await Promise.all([
        phases.track('parallel_sql', binding.prepare('SELECT 2').first()),
        phases.track('parallel_http', fetch(`http://127.0.0.1:${address.port}/read`).then(response => response.text())),
      ])
      phases.mark('authorized')
      return { ok: true as const, tenantId: 'workspace', userId: 'member', context: phases }
    },
    produce: ({ context, trace }) => ({
      stream: (async function* () {
        const parent = trace!.start('product.producer', 'sandbox')
        context.within(parent)
        await binding.prepare('SELECT 3').first()
        context.mark('ready')
        parent.end()
        phaseRows.push(context.phases())
        queryRows.push(context.queries())
        concurrentRows.push(context.concurrent())
        yield { type: 'text' as const, text: 'Counted phases.' }
      })(),
      finalText: () => 'Counted phases.',
    }),
    turnTrace: { sink: value => { snapshot = value } },
    log: () => {},
  })
  try {
    const response = await routes.turn(new Request('http://app.test/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Measure.' }),
    }), { waitUntil: work => { pending.push(work) } })
    await response.text()
    await Promise.all(pending)
    expect(Object.keys(phaseRows[0]!).sort()).toEqual(['authorized', 'identity', 'ready'])
    expect(queryRows[0]).toMatchObject({ identity: 1, authorized: 1 })
    expect(queryRows[0]!.ready).toBeGreaterThanOrEqual(1)
    expect(Object.keys(concurrentRows[0]!).sort()).toEqual(['parallel_http', 'parallel_sql'])
    const serialized = JSON.parse(JSON.stringify(snapshot!)) as TurnTraceSnapshot
    for (const name of ['identity', 'authorized', 'ready']) {
      const child = serialized.spans.find(value => value.name === `product.${name}`)!
      const parent = serialized.spans.find(value => value.spanId === child.parentSpanId)!
      expect(child.startMs).toBeGreaterThanOrEqual(parent.startMs)
      expect(child.endMs).toBeLessThanOrEqual(parent.endMs)
    }
    const otlp = buildTurnTraceOtelSpans(serialized)
    expect(otlp.filter(value => value.name === 'agent_app.turn')).toHaveLength(1)
    expect(otlp[0]!.spanId).toBe(originalRoot)
    expect(serialized.rootSpanId).toBe(originalRoot)
    expect(serialized.summary.d1Queries).toBeGreaterThanOrEqual(Object.values(queryRows[0]!).reduce((sum, value) => sum + value, 0))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    engine.close()
  }
})
