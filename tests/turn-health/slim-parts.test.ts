import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createD1TurnHealthSource, sweepSilentFailures, type SweepResult } from '../../src/turn-health/sweep.js'

/**
 * better-sqlite3 behind the D1 statement surface the source uses, counting the bytes each read returns.
 * better-sqlite3 treats D1's numbered `?1` placeholders as named ones, so each becomes `?` with its value
 * placed in the order it appears.
 */
function d1(db: Database.Database, bytes: number[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>(): Promise<{ results: T[] }> {
              const order: number[] = []
              const positional = sql.replace(/\?(\d+)/g, (_, n: string) => (order.push(Number(n) - 1), '?'))
              const results = db.prepare(positional).all(...order.map((i) => params[i])) as T[]
              if (sql.includes('json_each(CASE') || sql.startsWith('SELECT id, parts FROM')) bytes.push(Buffer.byteLength(JSON.stringify(results)))
              return { results }
            },
          }
        },
      }
    },
  }
}

const big = 'y'.repeat(400_000)
const tool = (state: unknown, extra: Record<string, unknown> = {}) => ({ type: 'tool', tool: 'bash', state, ...extra })
// Every shape classifyTurnOutcome distinguishes, most carrying a large output the projection must not return.
const SHAPES: unknown[][] = [
  [{ type: 'text', text: 'Done.' }, tool({ status: 'completed', input: { command: 'ls' }, output: big })],
  [tool({ status: 'error', input: { command: 'curl' }, error: 'HTTP 403 Forbidden', output: big })],
  [tool({ status: 'completed', input: '{"a":1}{"b":2}' })],
  [tool({ status: 'completed', input: '{"command":"ls"}', output: big })],
  [{ type: 'tool', tool: 'invalid', state: { status: 'completed', input: { tool: 'submit_proposal', error: "Model tried to call unavailable tool 'submit_proposal'" } } }],
  [{ type: 'reasoning', text: big }],
  [{ type: 'session-artifact', data: big }],
  [tool({ status: 'running', input: {} })],
  [tool({ status: 'error', input: { command: 'x' }, error: { message: 'not a string' } })],
  [{ type: 'text', text: ' \n\t ' }],
  ['a bare string part', 42, null, ['an', 'array', 'part']],
  [{ type: 7, text: 'typed by a number' }],
  [tool({ status: 'completed', input: ['an', 'array'] }), tool(['state', 'array']), tool('state string')],
  [{ type: 'file', url: 'https://example.test/a.pdf' }, { type: 'text', text: big }],
]

function seed(db: Database.Database) {
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, parts TEXT, output_tokens INTEGER, model TEXT, created_at INTEGER)`)
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const now = Math.floor(1_800_000_000_000 / 1000)
  SHAPES.forEach((parts, i) => insert.run(`m${i}`, `t${i}`, 'assistant', i === 0 ? 'Done.' : '', JSON.stringify(parts), 10, 'm', now - i))
  insert.run('invalid-json', 'tx', 'assistant', '', '{not json', 0, 'm', now - 100)
  insert.run('null-parts', 'ty', 'assistant', '', null, 0, 'm', now - 101)
  insert.run('object-parts', 'tz', 'assistant', '', '{"type":"text"}', 0, 'm', now - 102)
}

const sink = { async deliver() {} }
async function sweep(fullParts: boolean): Promise<{ result: SweepResult; bytes: number }> {
  const db = new Database(':memory:')
  seed(db)
  const bytes: number[] = []
  const result = await sweepSilentFailures({ product: 'p', source: createD1TurnHealthSource(d1(db, bytes), { fullParts }), sink, now: 1_800_000_000_000 })
  return { result, bytes: bytes.reduce((sum, n) => sum + n, 0) }
}

describe('the turn-health source reads only the part fields the classifier uses', () => {
  it('judges every stored shape exactly as the full parts do, from a small fraction of the bytes', async () => {
    const full = await sweep(true)
    const slim = await sweep(false)
    const { alerts: fullAlerts, ...fullCounts } = full.result
    const { alerts: slimAlerts, ...slimCounts } = slim.result
    expect(slimCounts).toEqual(fullCounts)
    expect(slimAlerts.map((alert) => [alert.key, alert.severity, alert.title])).toEqual(fullAlerts.map((alert) => [alert.key, alert.severity, alert.title]))
    // The fixture holds rejected, malformed, no-effect, empty, opaque and unreadable turns.
    expect(fullCounts.rejectedToolCalls).toBeGreaterThan(0)
    expect(fullCounts.malformedToolCalls).toBe(1)
    expect(fullCounts.toolCallsWithoutEffect).toBeGreaterThan(0)
    expect(fullCounts.opaquePartsTurns).toBeGreaterThan(0)
    // 2026-10-11: the full read returned 141.9 MB per run on production.
    expect(full.bytes).toBeGreaterThan(2_000_000)
    expect(slim.bytes).toBeLessThan(full.bytes / 100)
  })
})
