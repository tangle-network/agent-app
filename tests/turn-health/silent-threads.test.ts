import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { classifyTurnOutcome } from '../../src/turn-health/classify.js'
import type { TurnHealthAlert } from '../../src/turn-health/sink.js'
import { createD1TurnHealthSource, SHELL_ERROR_REPLY_PREFIXES, sweepSilentFailures } from '../../src/turn-health/sweep.js'

/** better-sqlite3 behind the D1 statement surface; D1's numbered `?N` placeholders bound positionally. */
function d1(db: Database.Database) {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>(): Promise<{ results: T[] }> {
              const order: number[] = []
              const positional = sql.replace(/\?(\d+)/g, (_, n: string) => (order.push(Number(n) - 1), '?'))
              return { results: db.prepare(positional).all(...order.map((i) => params[i])) as T[] }
            },
          }
        },
      }
    },
  }
}

const NOW = 1_800_000_000_000
const ago = (hours: number) => Math.floor((NOW - hours * 3_600_000) / 1000)
// The turn-failure notice gtm-agent saved on customer thread c846885a (2026-10-10 09:17Z), with no text.
const NOTICE = JSON.stringify([{ type: 'notice', noticeKind: 'turn-failure', code: 'sandbox.native_turn_failed', text: 'Execution cancelled by user' }])

function seed() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, parts TEXT, output_tokens INTEGER, model TEXT, created_at INTEGER)')
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
  const row = (id: string, thread: string, role: string, content: string, parts: string | null, hoursAgo: number) => insert.run(id, thread, role, content, parts, 'm', ago(hoursAgo))
  // Nothing came back: operator thread 02e49c30's shape, 60 h old.
  row('u-silent', 'silent', 'user', 'Check the catalog', '[]', 60)
  // A blank row showed nothing, so it is silent too.
  row('u-blank', 'blank', 'user', 'Draft it', '[]', 3)
  row('a-blank', 'blank', 'assistant', '', '[]', 2.9)
  // A failure notice the person saw.
  row('u-notice', 'notice', 'user', 'Rewrite the hero', '[]', 30)
  row('a-notice', 'notice', 'assistant', '', NOTICE, 29.9)
  // Error prose the person saw.
  row('u-prose', 'prose', 'user', 'Plan the week', '[]', 5)
  row('a-prose', 'prose', 'assistant', `${SHELL_ERROR_REPLY_PREFIXES[0]} Error: 502`, '[]', 4.9)
  // A notice for the first message, then nothing for the second: the newest went unanswered.
  row('u-first', 'later', 'user', 'One', '[]', 8)
  row('a-first', 'later', 'assistant', '', NOTICE, 7.9)
  row('u-second', 'later', 'user', 'Two', '[]', 7)
  // Parts that are not objects are read without error.
  row('u-odd', 'odd', 'user', 'Odd', '[]', 2)
  row('a-odd', 'odd', 'assistant', '', '["a bare string", 7, null]', 1.9)
  // Answered.
  row('u-done', 'done', 'user', 'Hi', '[]', 2)
  row('a-done', 'done', 'assistant', 'Hello.', '[]', 1.9)
  return db
}

/** Records the thread alerts; the per-turn rules raise their own over these rows. */
function sink() {
  const alerts: TurnHealthAlert[] = []
  return { alerts, async deliver(alert: TurnHealthAlert) { if (/:(unanswered|failed)_threads$/.test(alert.key)) alerts.push(alert) } }
}

describe('unanswered threads, silent or ended on a failure the person saw', () => {
  it('pages only on silent threads the product selects, and leaves notified ones to its failure report', async () => {
    const source = createD1TurnHealthSource(d1(seed()))
    const unanswered = await source.findUnansweredThreads({ minAgeMs: 30 * 60_000, maxAgeMs: 7 * 24 * 3_600_000, now: NOW })
    expect(Object.fromEntries(unanswered.map((t) => [t.threadId, t.notified]))).toEqual({
      silent: false, blank: false, notice: true, prose: true, later: false, odd: false,
    })

    const reported = sink()
    const result = await sweepSilentFailures({
      product: 'gtm-agent', source, sink: reported, now: NOW, minAgeMs: 30 * 60_000,
      // gtm-agent pages on its customers' and operators' threads only.
      pageSilentThreads: (threads) => threads.filter((t) => t.threadId === 'silent'),
      failureNoticesReportedBy: 'the reliability report',
    })
    expect(result).toMatchObject({ unansweredThreads: 6, silentThreads: 4, pagedSilentThreads: 1, notifiedThreads: 2 })
    expect(reported.alerts.map((a) => [a.key, a.severity])).toEqual([['sweep:gtm-agent:unanswered_threads', 'critical']])
    expect(reported.alerts[0]!.details[1]).toBe('thread silent: 1 pending, oldest 60.0h (pages)')

    // Without a selection, a day of silence pages; without a failure report, notified threads are a warning.
    const fallback = sink()
    await sweepSilentFailures({ product: 'gtm-agent', source, sink: fallback, now: NOW, minAgeMs: 30 * 60_000 })
    expect(fallback.alerts.map((a) => [a.key, a.severity])).toEqual([
      ['sweep:gtm-agent:unanswered_threads', 'critical'],
      ['sweep:gtm-agent:failed_threads', 'warning'],
    ])
  })

  it('warns, not pages, when no silent thread is selected', async () => {
    const reported = sink()
    await sweepSilentFailures({
      product: 'gtm-agent', source: createD1TurnHealthSource(d1(seed())), sink: reported, now: NOW, minAgeMs: 30 * 60_000,
      pageSilentThreads: () => [], failureNoticesReportedBy: 'the reliability report',
    })
    expect(reported.alerts.map((a) => a.severity)).toEqual(['warning'])
  })
})

describe('tool calls that report their own failure', () => {
  const call = (state: Record<string, unknown>) => ({ type: 'tool', tool: 'bash', state })

  it('are neither rejected nor without effect: the model and the person saw the error', () => {
    const verdict = classifyTurnOutcome({
      finalText: 'The page returned 403, so I used the cached copy.',
      parts: [call({ status: 'error', input: { command: 'curl' }, error: 'HTTP 403 Forbidden' }), { type: 'text', text: 'The page returned 403, so I used the cached copy.' }],
    })
    expect(verdict.healthy).toBe(true)
  })

  it('still flag a call that settled as completed while carrying its rejection', () => {
    const verdict = classifyTurnOutcome({
      finalText: 'Filed.',
      parts: [call({ status: 'completed', input: { tool: 'submit_proposal', error: "Model tried to call unavailable tool 'submit_proposal'" } })],
    })
    expect(verdict.reasons.map((r) => r.kind)).toContain('tool_call_rejected')
  })
})
