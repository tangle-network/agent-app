import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, createSandboxChatProducer, type ChatTurnMessageStore } from '../src/chat-routes/index'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_RULER_MIGRATION_SQL, ROLLOUT_TURN_TIMING_SCHEMA_SQL, ROLLOUT_TURN_TIMING_VARIANT_MIGRATION_SQL, type D1LikeForRollout } from '../src/rollout/d1'
import { assignRolloutArm, decideRollout } from '../src/rollout/index'
import { createMemoryTurnEventStore } from '../src/stream/index'

// Frozen E8 decision measurement: creative-rollout.result, closed seven-day window
// 2026-10-13T23:48:49.733Z through 2026-10-20T23:48:49.733Z. No live reads or paid calls.
const frozen = JSON.parse(readFileSync(new URL('./fixtures/rollout/creative-e8.json', import.meta.url), 'utf8'))
// Frozen install's prepare builds the exact CLI named by the package bin.
const cli = fileURLToPath(new URL('../dist/rollout/cli.js', import.meta.url))

function frozenRolloutFixture(dir: string) {
  writeFileSync(join(dir, 'wrangler.toml'), `[vars]\n${frozen.variable} = "*"\n`)
  const plan = { name: frozen.rollout, variable: frozen.variable, stages: [
    { name: 'qa', value: frozen.from.value, minSamples: 20, kill: {
      first_visible_p50_delta_ms: { max: 0 }, failure_rate_delta: { max: 0.01 },
    } },
    { name: 'all', value: '*', minSamples: 100, kill: { failure_rate_delta: { max: 0.01 } } },
  ] }
  // `from`: 'since' measures from the CLI's `since`, as a product reading only rows at or after it does; an ISO time is a
  // fixed window the instrument chose; absent keeps the frozen seven-day window.
  const run = (breach: boolean, args: string[], from?: string) => {
    const measured = structuredClone(frozen.measured)
    if (breach) measured.metrics.failure_rate_delta = 0.02
    const window = from === 'since' ? '{ ...m.window, from: new Date(since).toISOString() }'
      : from ? `{ ...m.window, from: ${JSON.stringify(from)} }` : 'm.window'
    const measure = `async measure({ since }) { const m = ${JSON.stringify(measured)}; return { ...m, window: ${window} } }`
    writeFileSync(join(dir, 'rollout.config.mjs'), `export default { plans: ${JSON.stringify([plan])}, ${measure} }`)
    const child = spawnSync(process.execPath, [cli, dir, ...args, '--record', 'decisions.jsonl'], { encoding: 'utf8' })
    const records = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n')
    return { ...child, decision: JSON.parse(records.at(-1)!) }
  }
  return run
}

it('the CLI reports frozen lane deficits and permits hold or narrowing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruler-e8-'))
  try {
    const run = frozenRolloutFixture(dir)
    const qa = ['--from', frozen.from.value]
    const widening = run(false, [...qa, '--to', '*'])
    expect(widening.status, widening.stderr).toBe(3)
    expect(widening.stdout).toContain('UNDECIDED')
    console.info(widening.stdout.trim())
    expect(widening.decision).toMatchObject({ decision: 'undecided', turnsNeeded: { router: 14, sandbox: 2 } })
    const hold = run(false, [...qa, '--to', frozen.from.value])
    expect(hold.status).toBe(0)
    expect(hold.stdout).toContain('UNDECIDED')
    expect(hold.decision.measured.window).toEqual(frozen.measured.window)
    const narrowing = run(true, [...qa, '--to', ''])
    expect(narrowing.status).toBe(0)
    expect(narrowing.decision).toMatchObject({ decision: 'allowed', recommendation: 'narrow', measured: { samples: 6 } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('the CLI refuses a hold only on turns since the deployed commit went live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruler-e8-'))
  try {
    const run = frozenRolloutFixture(dir)
    // The value's history: empty, set to the QA stage inside the frozen window, then the deployed (base) commit after it closed.
    const commit = (at: string, value: string, message: string) => {
      writeFileSync(join(dir, 'wrangler.toml'), `[vars]\n${frozen.variable} = "${value}"\nOTHER = "${message}"\n`)
      const env = { ...process.env, GIT_ALLOW_TEST_IDENTITY: '1', GIT_AUTHOR_NAME: 'rollout', GIT_AUTHOR_EMAIL: 'rollout@example.com',
        GIT_COMMITTER_NAME: 'rollout', GIT_COMMITTER_EMAIL: 'rollout@example.com', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
      for (const args of [['add', 'wrangler.toml'], ['commit', '-q', '-m', message]]) {
        const git = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
        expect(git.status, git.stderr).toBe(0)
      }
    }
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
    const live = '2026-10-21T00:00:00.000Z'
    commit('2026-10-01T00:00:00Z', '', 'empty')
    commit('2026-10-15T00:00:00Z', frozen.from.value, 'qa')
    commit(live, frozen.from.value, 'deployed')
    const freshBreach = run(true, ['--base', 'HEAD'], 'since')
    expect(freshBreach.status, freshBreach.stderr).toBe(1)
    expect(freshBreach.stdout).toContain('(narrow)')
    console.info(freshBreach.stdout.trim())
    expect(freshBreach.decision).toMatchObject({ decision: 'refused', recommendation: 'narrow', measured: { window: { from: live } } })
    // Legal, 2026-10-22: a 7-day window of turns served before the deployed commit went live, none since.
    const staleBreach = run(true, ['--base', 'HEAD'])
    expect(staleBreach.status, staleBreach.stderr).toBe(0)
    expect(staleBreach.stdout).toContain('UNDECIDED')
    expect(staleBreach.stdout).toContain('(narrow)')
    console.info(staleBreach.stdout.trim())
    expect(staleBreach.decision).toMatchObject({ decision: 'undecided', recommendation: 'narrow' })
    expect(staleBreach.decision.reasons).toEqual(expect.arrayContaining([
      'failure_rate_delta 0.02 over kill line 0.01', expect.stringContaining(`went live at ${live}`)]))
    // Breach rows only before the base deploy, in a window that opens after the value changed.
    const sinceChange = run(true, ['--base', 'HEAD'], '2026-10-16T00:00:00.000Z')
    expect(sinceChange.status, sinceChange.stderr).toBe(0)
    expect(sinceChange.decision).toMatchObject({ decision: 'undecided', recommendation: 'narrow' })
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
    writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nIDS = ""\n')
    writeFileSync(join(dir, 'rollout.config.mjs'), `export default {
      measurementTimeoutMs: 500,
      plans: [{ name: 'hung', variable: 'IDS', stages: [{ name: 'qa', value: 'w', minSamples: 2,
        kill: { failure_rate: { max: 0 } } }] }],
      async measure() { return (await fetch(${JSON.stringify(endpoint)})).json() },
    }`)
    const started = Date.now()
    const child = spawn('timeout', ['3', process.execPath, cli, dir, '--from', 'w', '--to', ''])
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

it('records an experiment variant apart from the cohort arm, and keeps recording on a table without the column', async () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`CREATE TABLE rollout_turn_timing (
      turn_id TEXT PRIMARY KEY, rollout TEXT, workspace_id TEXT, lane TEXT,
      first_visible_ms INTEGER, first_text_ms INTEGER, settled_ms INTEGER,
      failed INTEGER, failure_code TEXT, at INTEGER
    );`)
    sqlite.exec(ROLLOUT_TURN_TIMING_RULER_MIGRATION_SQL)
    const store = createD1TurnTimingStore({ db: { prepare: sql => ({ bind: (...values) => ({
      run: async () => sqlite.prepare(sql).run(...values),
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    }) }) } })
    const row = { rollout: 'r', workspaceId: 'w', lane: 'router', settledMs: 10, failed: false, arm: 'synthetic-router', at: 1 }
    // Before the variant migration: a row without a variant still lands.
    await store.record({ ...row, turnId: 'before' })
    sqlite.exec(ROLLOUT_TURN_TIMING_VARIANT_MIGRATION_SQL)
    await store.record({ ...row, turnId: 'after', variant: 'billing_in_gate=1' })
    expect(sqlite.prepare('SELECT turn_id, arm, variant FROM rollout_turn_timing ORDER BY turn_id').all())
      .toEqual([{ turn_id: 'after', arm: 'synthetic-router', variant: 'billing_in_gate=1' }, { turn_id: 'before', arm: 'synthetic-router', variant: null }])
  } finally { sqlite.close() }
})

it('a product writer that omits timing still records first visible, admission and the served model, on a full table and on a pre-ruler one', async () => {
  // Full schema; the Tax 0022 table (no first_visible_ms, ruler or variant columns); and an opted-out store on the full schema.
  const full = new Database(':memory:'), legacy = new Database(':memory:'), optedOut = new Database(':memory:')
  full.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  optedOut.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  legacy.exec(`CREATE TABLE rollout_turn_timing (turn_id TEXT PRIMARY KEY, rollout TEXT NOT NULL, workspace_id TEXT NOT NULL,
    lane TEXT NOT NULL, first_text_ms INTEGER, settled_ms INTEGER NOT NULL, failed INTEGER NOT NULL, failure_code TEXT, at INTEGER NOT NULL);`)
  const d1 = (sqlite: Database.Database): D1LikeForRollout => ({ prepare: sql => ({ bind: (...values) => ({
    run: async () => sqlite.prepare(sql).run(...values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  }) }) })
  const stores = [createD1TurnTimingStore({ db: d1(full) }), createD1TurnTimingStore({ db: d1(legacy) }),
    createD1TurnTimingStore({ db: d1(optedOut), measuredFacts: false })]
  const store: ChatTurnMessageStore = { async listMessages() { return [] }, async appendMessage() { return { id: 'm' } } }
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes<Record<string, never>>({
    projectId: 'timing-default', store, turnStore: createMemoryTurnEventStore(), log: () => {},
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'u-1', context: {} }),
    produce: () => ({
      model: 'served-model',
      stream: (async function* () {
        for (const text of ['Four', ' rooms.']) {
          await new Promise(resolve => setTimeout(resolve, 30))
          yield { type: 'text', text } as never
        }
      })(),
      finalText: () => 'Four rooms.',
    }),
    // The Legal writer (legal-agent chat-vertical.ts): lane, words and settle time, nothing else.
    lifecycle: { onTurnComplete: async info => { await Promise.all(stores.map(timing => timing.record({ turnId: info.turnStreamId,
      rollout: 'r', workspaceId: 'ws-1', lane: 'sandbox', firstTextMs: info.firstTextMs, settledMs: info.durationMs, failed: false }))) } },
  })
  try {
    const response = await routes.turn(new Request('http://app.test/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content: 'hi' }) }),
    { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    await response.text()
    await Promise.all(pending)
    const row = full.prepare('SELECT lane, admission_ms, first_visible_ms, first_text_ms, model FROM rollout_turn_timing').get() as Record<string, unknown>
    expect(row).toMatchObject({ lane: 'sandbox', model: 'served-model' })
    expect(row.admission_ms).toBeGreaterThanOrEqual(0)
    expect(row.first_visible_ms).toBeGreaterThanOrEqual(25)
    expect(row.first_visible_ms).toBeLessThanOrEqual(row.first_text_ms as number)
    const measured = await stores[0]!.measureStage({ rollout: 'r', stage: { name: 'qa', value: 'ws-1', minSamples: 1, kill: {} }, lane: 'sandbox', since: 0 })
    expect(measured.metrics.first_visible_p50_ms).toBe(row.first_visible_ms)
    // The pre-ruler table keeps recording the columns it has instead of losing the row.
    expect(legacy.prepare('SELECT lane, first_text_ms FROM rollout_turn_timing').get()).toEqual({ lane: 'sandbox', first_text_ms: row.first_text_ms })
    // measuredFacts: false writes only what the product passed.
    expect(optedOut.prepare('SELECT admission_ms, first_visible_ms, model FROM rollout_turn_timing').get())
      .toEqual({ admission_ms: null, first_visible_ms: null, model: null })
  } finally { full.close(); legacy.close(); optedOut.close() }
})

it.each([
  { code: 'MODEL_REFUSED', message: 'The selected model is outside the delegated key allow-list.' },
  { code: 'E', message: 'Error while connecting' },
].flatMap(error => [undefined, '', '[object Object]', 'product.refused'].map(failureCode => ({ ...error, failureCode })) ))('records the sandbox failure through the route lifecycle and real timing table ($code, product code=$failureCode)', async ({ code, message, failureCode }) => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const timing = createD1TurnTimingStore({ db: { prepare: sql => ({ bind: (...values) => ({
    run: async () => sqlite.prepare(sql).run(...values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  }) }) } })
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'failure-default',
    store: { async listMessages() { return [] }, async appendMessage() { return { id: 'm' } } },
    turnStore: createMemoryTurnEventStore(), log: () => {},
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: {} }),
    produce: () => createSandboxChatProducer({ errorNotice: true, events: (async function* () {
      yield { type: 'error', data: { code, message } }
    })() }),
    lifecycle: { onTurnError: info => timing.record({
      turnId: info.turnStreamId, rollout: 'reliability', workspaceId: 'workspace', lane: 'sandbox',
      settledMs: info.durationMs, failed: true, ...(failureCode === undefined ? {} : { failureCode }),
    }) },
  })
  try {
    const response = await routes.turn(new Request('https://app.test/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Continue.' }) }),
    { waitUntil: promise => { pending.push(promise) } })
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    await Promise.all(pending)
    expect(events.find(event => event.type === 'session.run.failed')?.data.code).toBe(code)
    expect(events.some(event => event.type === 'session.run.completed')).toBe(false)
    expect(sqlite.prepare('SELECT failed, failure_code FROM rollout_turn_timing').get()).toEqual({
      failed: 1,
      failure_code: failureCode === 'product.refused' ? failureCode
        : `${code}: ${message}`,
    })
  } finally { sqlite.close() }
})

it('shared timing lifecycle records real route outcomes and current revision, excluding a gated turn', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const timing = createD1TurnTimingStore({ db: { prepare: sql => ({ bind: (...values) => ({
    run: async () => sqlite.prepare(sql).run(...values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  }) }) } })
  const before = process.env.DEPLOY_SHA
  process.env.DEPLOY_SHA = 'not-the-settled-revision'
  const lifecycle = timing.lifecycle<{ mode: string }>({ rollout: 'defaults', identify: info => ({
    workspaceId: 'workspace', lane: info.context.mode === 'failure' ? 'sandbox' : 'router', arm: 'control',
  }) })
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes<{ mode: string }>({
    projectId: 'lifecycle-default',
    store: { async listMessages() { return [] }, async appendMessage() { return { id: crypto.randomUUID() } } },
    turnStore: createMemoryTurnEventStore(), log: () => {},
    authorize: async args => ({ ok: true, tenantId: 'workspace', userId: 'user', context: { mode: String(args.body?.content) } }),
    contextGate: args => args.context.mode === 'gated' ? { proceed: false, response: Response.json({ declined: true }) } : { proceed: true },
    produce: args => createSandboxChatProducer({ events: (async function* () {
      yield args.context.mode === 'failure'
        ? { type: 'error', data: { code: 'MODEL_REFUSED', message: 'Outside the allowed models.' } }
        : { type: 'message.part.updated', data: { part: { type: 'text', text: 'Done.' }, delta: 'Done.' } }
    })(), model: 'served-model' }),
    lifecycle,
  })
  try {
    process.env.DEPLOY_SHA = 'settled-revision'
    for (const mode of ['success', 'failure', 'gated']) {
      const response = await routes.turn(new Request('https://app.test/api/chat', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: mode, content: mode }) }),
      { waitUntil: promise => { pending.push(promise) } })
      await response.text()
      await Promise.all(pending)
    }
    const rows = sqlite.prepare('SELECT lane, failed, model, revision, arm, failure_code FROM rollout_turn_timing ORDER BY failed').all()
    expect(rows).toEqual([
      { lane: 'router', failed: 0, model: 'served-model', revision: 'settled-revision', arm: 'control', failure_code: null },
      { lane: 'sandbox', failed: 1, model: 'served-model', revision: 'settled-revision', arm: 'control', failure_code: 'MODEL_REFUSED: Outside the allowed models.' },
    ])
  } finally {
    if (before === undefined) delete process.env.DEPLOY_SHA
    else process.env.DEPLOY_SHA = before
    sqlite.close()
  }
})

it('records native settlement facts without an ephemeral route trace, using the shared redacted typed failure', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const timing = createD1TurnTimingStore({ db: { prepare: sql => ({ bind: (...values) => ({
    run: async () => sqlite.prepare(sql).run(...values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  }) }) } })
  try {
    const lifecycle = timing.lifecycle<{ model: string }>({ rollout: 'native',
      identify: ({ context }) => ({ workspaceId: 'workspace', lane: 'sandbox', model: context.model }),
      revision: () => 'native-settlement-revision',
    })
    await lifecycle.onTurnError?.({
      identity: { tenantId: 'workspace', sessionId: 'thread', userId: 'user', turnIndex: 0 },
      executionId: 'native-execution', turnStreamId: 'native-unrecorded', context: { model: 'native-served-model' },
      error: { code: 'NATIVE_REFUSED', message: 'Refused request with Authorization: Bearer native-fixture-secret' }, durationMs: 42,
    })
    const row = sqlite.prepare('SELECT model, revision, failed, failure_code FROM rollout_turn_timing').get() as Record<string, unknown>
    expect(row).toMatchObject({ model: 'native-served-model', revision: 'native-settlement-revision', failed: 1 })
    expect(row.failure_code).toContain('NATIVE_REFUSED:')
    expect(row.failure_code).not.toContain('native-fixture-secret')
  } finally { sqlite.close() }
})
