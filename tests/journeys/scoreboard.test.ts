import { describe, expect, it } from 'vitest'
import { SCOREBOARD_STATUSES, scoreboardRows, type JourneySummary } from '../../src/journeys/scoreboard'

const RUN = '2026-10-12T03:41:00Z'
const SHA = '25c6a097319c3b9f1ae8600b23f831a7157fe2d0'
const VIDEO = 'https://github.com/drewstone/legal-underwriting-agent/releases/download/x/c3-documents--partner-full.mp4'

/** One journey per status the board knows, the way Casework's runner writes them. */
function everyStatus(): JourneySummary {
  return {
    origin: 'http://localhost:8792', sha: SHA, model: 'scripted stub', lane: 'engine', updatedAt: RUN,
    journeys: [
      { id: 'c3', status: 'pass', firstTextS: 2.5, completeS: 9.1, videoUrl: VIDEO, traceUrl: '/home/drew/.local/state/trace.zip' },
      { id: 'c9', status: 'fail', reason: 'decision line missing after reload' },
      { id: 'c2', status: 'stall', reason: "'Case name' never settled; 0 app errors" },
      { id: 'c10', status: 'blocked-host', reason: 'net::ERR_NETWORK_CHANGED on 2 asset requests' },
      { id: 'c1', status: 'blocked', reason: 'agent-app #1060 not released', evidenceUrl: 'https://github.com/tangle-network/agent-app/pull/1060' },
      { id: 'c4', status: 'skipped', reason: 'analyst run (spend)' },
      { id: 'c11', status: 'unrecorded' },
    ],
  }
}

describe('scoreboardRows', () => {
  it('maps every board status to the row schema', () => {
    const { writes, warnings } = scoreboardRows(everyStatus(), { app: 'casework' })
    const flows = writes.filter((w) => w.collection === 'flows')
    expect(flows.map((w) => w.data.status).sort()).toEqual([...SCOREBOARD_STATUSES].sort())
    for (const w of flows) {
      expect(w.doc_id).toBe(`casework-${w.data.flowId}`)
      expect(w.data.app).toBe('casework')
      expect(w.data.recordedAt).toBe(RUN)
      expect(w.data.sha).toBe(SHA)
    }
    const pass = flows.find((w) => w.data.flowId === 'C3')!
    expect(pass.data).toMatchObject({ status: 'pass', firstTextS: 2.5, completeS: 9.1, videoUrl: VIDEO })
    // A host path is no link a reviewer can open: dropped, and said so.
    expect(pass.data).not.toHaveProperty('traceUrl')
    expect(warnings).toEqual(['C3: traceUrl is not an http(s) link and was dropped'])
    expect(flows.find((w) => w.data.flowId === 'C2')!.data.blocker).toBe("'Case name' never settled; 0 app errors")
    expect(flows.find((w) => w.data.flowId === 'C1')!.data.evidenceUrl).toBe('https://github.com/tangle-network/agent-app/pull/1060')
    const meta = writes.at(-1)!
    expect(meta).toMatchObject({ op: 'set', collection: 'meta', doc_id: 'casework', data: { origin: 'http://localhost:8792', sha: SHA, updatedAt: RUN } })
  })

  it('writes an unknown status as unrecorded and says so', () => {
    const summary: JourneySummary = { updatedAt: RUN, journeys: [{ id: 'C5', status: 'flaky' }] }
    const { writes, warnings } = scoreboardRows(summary, { app: 'casework' })
    expect(writes[0]!.data.status).toBe('unrecorded')
    expect(warnings[0]).toContain('C5: status "flaky"')
  })

  it("keeps Hardware's rows where the board already has them", () => {
    const summary: JourneySummary = { updatedAt: RUN, journeys: [{ id: 'h1', status: 'blocked', reason: 'engine behind a flag' }] }
    const { writes } = scoreboardRows(summary, { app: 'hardware', versions: { 'flows/H1': 4, 'meta/board': 2 } })
    // Bare flow id and meta/board: the documents Hardware wrote before the board was shared.
    expect(writes.map((w) => `${w.op} ${w.collection}/${w.doc_id} v${w.if_version}`)).toEqual(['update flows/H1 v4', 'update meta/board v2'])
    // A merge keeps the flow and pass-bar text a person wrote, and clears what this run does not have.
    expect(writes[0]!.data).not.toHaveProperty('flow')
    expect(writes[0]!.data.firstTextS).toEqual({ __delete__: true })
    expect(writes[0]!.data.app).toBe('hardware')
  })

  it('clears an old blocker when a flow passes', () => {
    const summary: JourneySummary = { updatedAt: RUN, journeys: [{ id: 'C7', status: 'pass', reason: 'was blocked on #1060' }] }
    const { writes } = scoreboardRows(summary, { app: 'casework', versions: { 'flows/casework-C7': 3 } })
    expect(writes[0]).toMatchObject({ op: 'update', if_version: 3, data: { status: 'pass', blocker: { __delete__: true } } })
  })

  it('creates a document with no known version without delete markers', () => {
    const { writes } = scoreboardRows({ updatedAt: RUN, journeys: [{ id: 'C8', status: 'pass' }] }, { app: 'casework' })
    expect(writes[0]!.op).toBe('set')
    expect(writes[0]).not.toHaveProperty('if_version')
    expect(JSON.stringify(writes)).not.toContain('__delete__')
  })

  it('gives the same writes for the same input, in a fixed order', () => {
    const a = scoreboardRows(everyStatus(), { app: 'casework' })
    const shuffled = everyStatus()
    shuffled.journeys.reverse()
    const b = scoreboardRows(shuffled, { app: 'casework' })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect(a.writes.slice(0, -1).map((w) => w.data.flowId)).toEqual(['C1', 'C2', 'C3', 'C4', 'C9', 'C10', 'C11'])
  })

  it('refuses an app name that is not a short lowercase name, and a summary without a run time', () => {
    expect(() => scoreboardRows(everyStatus(), { app: 'Casework App' })).toThrow(/short lowercase name/)
    expect(() => scoreboardRows({ journeys: [] }, { app: 'casework' })).toThrow(/updatedAt/)
  })
})
