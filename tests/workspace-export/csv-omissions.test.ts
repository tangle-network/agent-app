import { inflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  createExportEngine,
  createMemoryExportStorage,
  type ExportRowsSource,
} from '../../src/workspace-export'

const WS = 'csv-workspace'

function setup(source: ExportRowsSource) {
  const storage = createMemoryExportStorage()
  const engine = createExportEngine({ app: 'test', storage, plan: () => ({ sources: [source] }) })
  return { engine, storage }
}

describe('workspace export CSV omissions', () => {
  it('drops omitted headers and cells while preserving declared order and CSV quoting', async () => {
    const columns = Object.freeze(['internal', 'note,"label"', 'hidden', 'name', 'total', 'private'])
    const { engine, storage } = setup({
      kind: 'rows',
      name: 'records',
      dataClass: 'records',
      format: 'csv',
      columns,
      omitColumns: ['internal', 'hidden', 'private', 'not-in-schema'],
      async *rows() {
        yield []
        yield { name: 'Ada', total: 12, hidden: 'excluded-one', 'note,"label"': 'Hello, "guest"\nWelcome', internal: 'excluded-two', private: 'excluded-three' }
        yield [{ name: '=SUM(A1:A2)', 'note,"label"': 'Second', total: null, hidden: 'excluded-four' }]
      },
    })
    const started = await engine.start(WS, 'owner')
    const job = await engine.advance(WS, started.id)
    expect(job?.status).toBe('complete')
    expect(job?.units[0]).toMatchObject({ status: 'done', rows: 2, redactions: 0 })
    const entries = job!.units[0]!.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('spreadsheets/records.csv')
    const csv = inflateRawSync(Buffer.concat(entries[0]!.segments.map((segment) => storage.objects.get(segment.key)!))).toString('utf8')
    expect(csv).toBe('"note,""label""",name,total\r\n"Hello, ""guest""\nWelcome",Ada,12\r\nSecond,\'=SUM(A1:A2),\r\n')
    for (const omitted of ['internal', 'hidden', 'private', 'excluded-']) expect(csv).not.toContain(omitted)
    expect(columns).toEqual(['internal', 'note,"label"', 'hidden', 'name', 'total', 'private'])
  })

  it.each([undefined, [], ['absent']])('retains the declared schema for nonmatching omissions %j', async (omitColumns) => {
    const { engine, storage } = setup({
      kind: 'rows',
      name: 'records',
      dataClass: 'records',
      format: 'csv',
      columns: ['name', 'count'],
      omitColumns,
      async *rows() { yield { count: 0, name: 'Ada' } },
    })
    const started = await engine.start(WS, 'owner')
    const job = await engine.advance(WS, started.id)
    expect(job?.status).toBe('complete')
    const entry = job!.units[0]!.entries[0]!
    const csv = inflateRawSync(Buffer.concat(entry.segments.map((segment) => storage.objects.get(segment.key)!))).toString('utf8')
    expect(csv).toBe('name,count\r\nAda,0\r\n')
  })

  it('fails the existing needs-columns contract when every declared column is omitted', async () => {
    const rows = vi.fn(async function* () { yield { internal: 'excluded' } })
    const { engine, storage } = setup({
      kind: 'rows',
      name: 'records',
      dataClass: 'records',
      format: 'csv',
      columns: ['internal'],
      omitColumns: ['internal'],
      rows,
    })
    let job = await engine.start(WS, 'owner')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      job = (await engine.advance(WS, job.id))!
      expect(job.status).toBe(attempt < 3 ? 'running' : 'failed')
      expect(job.units[0]).toMatchObject({
        status: attempt < 3 ? 'pending' : 'failed',
        attempts: attempt,
        error: 'workspace-export: csv source "records" needs columns',
        entries: [],
      })
    }
    expect(rows).not.toHaveBeenCalled()
    expect([...storage.objects.keys()].some((key) => key.includes('/u/'))).toBe(false)
    expect(() => engine.zip(job)).toThrow('workspace-export: export is not complete')
  })

  it('still records an empty source when a retained column has no rows', async () => {
    const { engine } = setup({
      kind: 'rows',
      name: 'records',
      dataClass: 'records',
      format: 'csv',
      columns: ['internal', 'name'],
      omitColumns: ['internal'],
      async *rows() { yield [] },
    })
    const started = await engine.start(WS, 'owner')
    const job = await engine.advance(WS, started.id)
    expect(job?.status).toBe('complete')
    expect(job?.units[0]).toMatchObject({ status: 'empty', rows: 0, entries: [] })
  })
})
