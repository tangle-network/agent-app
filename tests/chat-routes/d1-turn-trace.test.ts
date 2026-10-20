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
    projectId: 'd1-app', store, turnStore: createMemoryTurnEventStore(), incrementalPersistence: false,
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
