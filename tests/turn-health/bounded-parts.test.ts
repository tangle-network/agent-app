import { describe, expect, it } from 'vitest'
import type { AlertSink } from '../../src/turn-health/sink.js'
import {
  createD1TurnHealthSource,
  sweepSilentFailures,
  TURN_HEALTH_PARTS_BATCH_SIZE,
} from '../../src/turn-health/sweep.js'

const silentSink: AlertSink = { async deliver() {} }

/**
 * A D1 stand-in over stored assistant rows. It answers the source's listing and
 * parts reads and records how much of `parts` each query returned.
 */
function messageDb(rows: Array<{ id: string; content: string; parts: string }>) {
  const listings: string[] = []
  const partsReads: number[] = []
  return {
    listings,
    partsReads,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              if (sql.includes('FROM message') && sql.includes('partsSize')) {
                listings.push(sql)
                return {
                  results: rows.map((row, i) => ({
                    id: row.id,
                    threadId: 't1',
                    content: row.content,
                    partsSize: row.parts.length,
                    outputTokens: 10,
                    model: 'm',
                    createdAt: 1_800_000_000 - i,
                  })),
                }
              }
              if (sql.startsWith('SELECT id, parts FROM message')) {
                const read = rows.filter((row) => params.includes(row.id))
                partsReads.push(read.reduce((sum, row) => sum + row.parts.length, 0))
                return { results: read.map((row) => ({ id: row.id, parts: row.parts })) }
              }
              return { results: [] }
            },
          }
        },
      }
    },
  }
}

describe('the turn-health sweep reads parts a bounded batch at a time', () => {
  it('judges every row while no query returns more than one batch of parts', async () => {
    // gtm-agent on 2026-10-10: the 500 newest assistant rows carried 122 MB of
    // parts, the largest 2.8 MB. One query for all of them exceeded the
    // Worker's 128 MB and stopped the hourly cron after 6 s.
    const text = (size: number) => JSON.stringify([{ type: 'text', text: 'x'.repeat(size) }])
    const malformed = JSON.stringify([
      { type: 'tool', id: 'call_0', tool: 'submit_proposal', state: { status: 'completed', input: '{"a":1}{"b":2}' } },
    ])
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `big-${i}`, content: 'Done.', parts: text(1_500_000) })),
      { id: 'oversize', content: 'Done.', parts: text(TURN_HEALTH_PARTS_BATCH_SIZE + 1_000_000) },
      { id: 'malformed', content: '', parts: malformed },
    ]
    const db = messageDb(rows)

    const result = await sweepSilentFailures({
      product: 'gtm-agent',
      source: createD1TurnHealthSource(db),
      sink: silentSink,
      now: 1_800_000_000_000,
    })

    // The listing carries sizes, never the parts themselves.
    expect(db.listings).toHaveLength(1)
    expect(db.listings[0]).toContain('length(parts) AS partsSize')
    expect(db.listings[0]).not.toMatch(/content, parts,/)
    // Every read fits one batch, except a single row larger than a batch, read alone.
    const oversize = rows.find((row) => row.id === 'oversize')!.parts.length
    for (const size of db.partsReads) {
      expect(size === oversize || size <= TURN_HEALTH_PARTS_BATCH_SIZE).toBe(true)
    }
    expect(db.partsReads.reduce((sum, size) => sum + size, 0)).toBe(rows.reduce((sum, row) => sum + row.parts.length, 0))
    // The verdicts come from the parts read in batches.
    expect(result.turnsJudged).toBe(rows.length)
    expect(result.malformedToolCalls).toBe(1)
  })
})
