import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { build } from 'tsup'
import { expect, it } from 'vitest'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_RULER_MIGRATION_SQL } from '../src/rollout/d1'
import { assignRolloutArm, decideRollout } from '../src/rollout/index'

// Frozen E8 decision measurement: creative-rollout.result, closed seven-day window
// 2026-10-13T23:48:49.733Z through 2026-10-20T23:48:49.733Z. No live reads or paid calls.
const frozen = JSON.parse(readFileSync(new URL('./fixtures/rollout/creative-e8.json', import.meta.url), 'utf8'))

it('the CLI reports lane deficits on the frozen E8 window, measures holds, and narrows on an injected failure breach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruler-e8-'))
  try {
    writeFileSync(join(dir, 'wrangler.toml'), `[vars]\n${frozen.variable} = "*"\n`)
    const plan = { name: frozen.rollout, variable: frozen.variable, stages: [
      { name: 'qa', value: frozen.from.value, minSamples: 20, kill: {
        first_visible_p50_delta_ms: { max: 0 }, failure_rate_delta: { max: 0.01 },
      } },
      { name: 'all', value: '*', minSamples: 100, kill: { failure_rate_delta: { max: 0.01 } } },
    ] }
    await build({ entry: ['src/rollout/cli.ts'], outDir: dir, format: ['esm'], splitting: false, config: false, silent: true, outExtension: () => ({ js: '.mjs' }) })
    const cli = join(dir, 'cli.mjs')
    const run = (breach: boolean, to: string) => {
      const measured = structuredClone(frozen.measured)
      if (breach) measured.metrics.failure_rate_delta = 0.02
      const config = `export default { plans: ${JSON.stringify([plan])}, async measure() { return ${JSON.stringify(measured)} } }`
      writeFileSync(join(dir, 'rollout.config.mjs'), config)
      const child = spawnSync(process.execPath, [cli, dir,
        '--from', frozen.from.value, '--to', to, '--record', 'decisions.jsonl'], { encoding: 'utf8' })
      const records = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n')
      return { ...child, decision: JSON.parse(records.at(-1)!) }
    }
    const widening = run(false, '*')
    expect(widening.status, widening.stderr).toBe(3)
    expect(widening.stdout).toContain('UNDECIDED')
    console.info(widening.stdout.trim())
    expect(widening.decision).toMatchObject({ decision: 'undecided', turnsNeeded: { router: 14, sandbox: 2 } })
    const hold = run(false, frozen.from.value)
    expect(hold.status).toBe(0)
    expect(hold.stdout).toContain('UNDECIDED')
    expect(hold.decision.measured.window).toEqual(frozen.measured.window)
    const breach = run(true, frozen.from.value)
    expect(breach.status).toBe(1)
    expect(breach.stdout).toContain('(narrow)')
    console.info(breach.stdout.trim())
    expect(breach.decision).toMatchObject({ decision: 'refused', recommendation: 'narrow' })
    const narrowing = run(true, '')
    expect(narrowing.status).toBe(0)
    expect(narrowing.decision).toMatchObject({ decision: 'allowed', recommendation: 'narrow', measured: { samples: 6 } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('migrates historical SQLite rows and persists the route timing origin and arm without inventing old metadata', async () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`CREATE TABLE rollout_turn_timing (
      turn_id TEXT PRIMARY KEY, rollout TEXT, workspace_id TEXT, lane TEXT,
      first_visible_ms INTEGER, first_text_ms INTEGER, settled_ms INTEGER,
      failed INTEGER, failure_code TEXT, at INTEGER
    ); INSERT INTO rollout_turn_timing VALUES ('old', 'r', 'w', 'sandbox', 20, 30, 40, 0, NULL, 1);`)
    sqlite.exec(ROLLOUT_TURN_TIMING_RULER_MIGRATION_SQL)
    const store = createD1TurnTimingStore({ db: { prepare: sql => ({ bind: (...values) => ({
      run: async () => sqlite.prepare(sql).run(...values),
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    }) }) } })
    const arm = assignRolloutArm('new', 50)
    await store.record({ turnId: 'new', rollout: 'r', workspaceId: 'w', lane: 'router',
      admissionMs: 2000, firstVisibleMs: 7172, firstTextMs: 9000, settledMs: 10000,
      model: 'served-model', revision: 'release-sha', arm, failed: false, at: 2 })
    expect(sqlite.prepare('SELECT admission_ms, model, revision, arm FROM rollout_turn_timing WHERE turn_id = ?').get('old'))
      .toEqual({ admission_ms: null, model: null, revision: null, arm: null })
    expect(sqlite.prepare('SELECT admission_ms + first_visible_ms AS visible, model, revision, arm FROM rollout_turn_timing WHERE turn_id = ?').get('new'))
      .toEqual({ visible: 9172, model: 'served-model', revision: 'release-sha', arm })
    expect(assignRolloutArm('new', 50)).toBe(arm)
    const stage = { name: 'qa', value: 'w', minSamples: 2, kill: { failure_rate: { max: 0 } } }
    const measured = await store.measureStage({ rollout: 'r', stage, lane: 'router', since: 0 })
    const decision = await decideRollout({ plan: { name: 'r', variable: 'IDS', stages: [stage,
      { ...stage, name: 'all', value: '*' }] }, fromValue: 'w', toValue: '*', measure: async () => measured })
    expect(decision).toMatchObject({ decision: 'undecided', turnsNeeded: { router: 1 } })
  } finally { sqlite.close() }
})


it('the shipped CLI completes a narrowing when the measurement HTTP request never responds or honors cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruler-hung-measure-'))
  let requests = 0
  const server = createServer(request => { requests++; request.resume() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await build({ entry: ['src/rollout/cli.ts'], outDir: dir, format: ['esm'], splitting: false,
      config: false, silent: true, outExtension: () => ({ js: '.mjs' }) })
    writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nIDS = ""\n')
    writeFileSync(join(dir, 'rollout.config.mjs'), `export default {
      measurementTimeoutMs: 500,
      plans: [{ name: 'hung', variable: 'IDS', stages: [{ name: 'qa', value: 'w', minSamples: 2,
        kill: { failure_rate: { max: 0 } } }] }],
      async measure() { return (await fetch(${JSON.stringify(endpoint)})).json() },
    }`)
    const started = Date.now()
    const child = spawn('timeout', ['3', process.execPath, join(dir, 'cli.mjs'), dir, '--from', 'w', '--to', ''])
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    expect(requests).toBe(1)
    expect(status, output).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
    const record = JSON.parse(readFileSync(join(dir, '.rollout/decisions.jsonl'), 'utf8').trim())
    expect(record).toMatchObject({ decision: 'allowed', recommendation: 'narrow', measured: null })
    expect(record.reasons.join(' ')).toContain('measurement timed out')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
