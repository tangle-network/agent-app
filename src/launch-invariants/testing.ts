/**
 * `/launch-invariants/testing` — the checks an app runs in its own test suite.
 *
 * Each check drives the app's real code through a small adapter and returns an
 * {@link InvariantVerdict}. {@link recordInvariant} fails the calling test with
 * the verdict's findings and, when `agent-app-invariants` runs the suite,
 * records the verdict so the conformance report can say which invariant
 * passed. The checks need no test runner: vitest, node:test and plain scripts
 * all work.
 *
 * Node-only (`node:v8`, `node:vm`, `node:fs`): import it from tests, never from
 * a Worker.
 */
import { appendFileSync } from 'node:fs'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { AlertSink, TurnHealthAlert } from '../turn-health/sink.js'
import { describeVerdict, LAUNCH_BUDGETS, type InvariantVerdict } from './catalog.js'
import { LIMIT_RESOURCES, type LimitAlarms } from './limit-alarms.js'

export { describeVerdict } from './catalog.js'

/** Set by `agent-app-invariants` to the file it reads verdicts from. */
export const INVARIANT_RESULTS_ENV = 'AGENT_APP_INVARIANTS_RESULTS'

/**
 * Record a verdict for the conformance report and fail the caller when it did
 * not pass. Returns the verdict on a pass.
 */
export function recordInvariant(verdict: InvariantVerdict): InvariantVerdict {
  const file = process.env[INVARIANT_RESULTS_ENV]
  if (file) appendFileSync(file, `${JSON.stringify({ ...verdict, at: new Date().toISOString() })}\n`)
  if (!verdict.pass) throw new Error(describeVerdict(verdict))
  return verdict
}

/** Record several verdicts; fails after recording all of them. */
export function recordInvariants(verdicts: readonly InvariantVerdict[]): InvariantVerdict[] {
  const failures: string[] = []
  for (const verdict of verdicts) {
    try {
      recordInvariant(verdict)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return [...verdicts]
}

// ── heap ─────────────────────────────────────────────────────────────────────

let gc: (() => void) | undefined

/** Run a full garbage collection, so a heap reading counts only live objects. */
export function forceGc(): void {
  if (!gc) {
    v8.setFlagsFromString('--expose_gc')
    gc = vm.runInNewContext('gc') as () => void
  }
  gc()
}

// ── measured D1 ──────────────────────────────────────────────────────────────

const MB = 1024 * 1024

/** What a measured binding saw while one job ran. */
export interface D1Reads {
  queries: number
  maxQueryBytes: number
  /** The query that returned the most bytes. */
  largestSql: string
  peakHeapBytes: number
  /** The query running when the heap peaked: where a job holds what it read. */
  peakSql: string
}

function emptyReads(): D1Reads {
  return { queries: 0, maxQueryBytes: 0, largestSql: '', peakHeapBytes: 0, peakSql: '' }
}

/**
 * The D1 binding with every response measured (serialized bytes) and the live
 * heap sampled after a collection before and after every query. Works over
 * Cloudflare D1 and the sqlite-backed D1 shims apps test with. A database
 * engine that keeps its pages off the JS heap (node:sqlite, better-sqlite3)
 * leaves heap growth to the job's own objects.
 */
export function measureD1<D extends object>(d1: D, reads: D1Reads = emptyReads(), options: { sampleHeap?: boolean } = {}): { d1: D; reads: D1Reads } {
  const sampleHeap = options.sampleHeap ?? true
  const sample = (sql: string) => {
    if (!sampleHeap) return
    forceGc()
    const heap = process.memoryUsage().heapUsed
    if (heap > reads.peakHeapBytes) {
      reads.peakHeapBytes = heap
      reads.peakSql = sql
    }
  }
  const measure = (sql: string, result: unknown) => {
    reads.queries += 1
    const bytes = Buffer.byteLength(JSON.stringify(result) ?? '')
    if (bytes > reads.maxQueryBytes) {
      reads.maxQueryBytes = bytes
      reads.largestSql = sql
    }
  }
  const statement = (target: object, sql: string): object => new Proxy(target, {
    get(stmt, key) {
      const value = Reflect.get(stmt, key) as unknown
      if (typeof value !== 'function') return value
      if (key === 'bind') return (...params: unknown[]) => statement(value.apply(stmt, params) as object, sql)
      if (key === 'all' || key === 'raw' || key === 'first' || key === 'run') {
        return async (...args: unknown[]) => {
          sample(sql)
          const result: unknown = await value.apply(stmt, args)
          measure(sql, result)
          sample(sql)
          return result
        }
      }
      return value.bind(stmt)
    },
  })
  const unwrap = new WeakMap<object, object>()
  const proxy = new Proxy(d1, {
    get(binding, key) {
      const value = Reflect.get(binding, key) as unknown
      if (key === 'prepare') {
        return (sql: string) => {
          const stmt = (value as (sql: string) => object).call(binding, sql)
          const wrapped = statement(stmt, sql.replace(/\s+/g, ' ').trim().slice(0, 200))
          unwrap.set(wrapped, stmt)
          return wrapped
        }
      }
      if (key === 'batch') {
        return async (statements: object[]) => {
          sample('batch')
          const result: unknown = await (value as (s: object[]) => Promise<unknown>).call(binding, statements.map((stmt) => unwrap.get(stmt) ?? stmt))
          measure('batch', result)
          sample('batch')
          return result
        }
      }
      return typeof value === 'function' ? value.bind(binding) : value
    },
  })
  return { d1: proxy, reads }
}

/** One scheduled job (or report route) as the budget check runs it. */
export interface BudgetedJob {
  name: string
  run: () => Promise<unknown>
  /** False for a job that reads nothing from D1 (it then passes bounded reads vacuously). Default true. */
  readsD1?: boolean
}

export interface JobMeasurement {
  name: string
  reads: D1Reads
  heapGrowthBytes: number
  error?: string
}

export interface ScheduledJobBudgetOptions {
  /** The app's D1 over its day-sized fixture. */
  d1: object
  /** Point the app's database accessor at the measured binding (`setD1`, `setDatabase(drizzle(...))`). */
  install: (measured: object) => void
  jobs: readonly BudgetedJob[]
  /** Every job the app schedules, by the names {@link jobs} uses. Each must be measured. */
  scheduled: readonly string[]
  maxQueryBytes?: number
  maxHeapGrowthBytes?: number
  /** Silence the jobs' own logging while they run. Default true. */
  quiet?: boolean
}

/** Run one job against a measured binding. */
export async function measureJob(job: BudgetedJob, d1: object, install: (measured: object) => void, quiet = true): Promise<JobMeasurement> {
  const { d1: measured, reads } = measureD1(d1)
  install(measured)
  forceGc()
  const baseline = process.memoryUsage().heapUsed
  reads.peakHeapBytes = baseline
  const restore = quiet ? silenceConsole() : () => {}
  let error: string | undefined
  try {
    await job.run()
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    restore()
  }
  forceGc()
  const after = process.memoryUsage().heapUsed
  if (after > reads.peakHeapBytes) {
    reads.peakHeapBytes = after
    reads.peakSql = reads.peakSql ? `${reads.peakSql} (still held when the job returned)` : '(after the job returned)'
  }
  return { name: job.name, reads, heapGrowthBytes: reads.peakHeapBytes - baseline, ...(error ? { error } : {}) }
}

function silenceConsole(): () => void {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  console.log = console.info = console.warn = console.error = () => {}
  return () => Object.assign(console, saved)
}

/**
 * Bounded reads and the memory budget for every scheduled job, on the app's
 * day-sized fixture. Returns a bounded-reads and a memory-budget verdict per
 * job, and a coverage verdict naming any scheduled job that was not run.
 */
export async function checkScheduledJobBudgets(options: ScheduledJobBudgetOptions): Promise<InvariantVerdict[]> {
  const maxQueryBytes = options.maxQueryBytes ?? LAUNCH_BUDGETS.queryBytes
  const maxHeap = options.maxHeapGrowthBytes ?? LAUNCH_BUDGETS.heapGrowthBytes
  const verdicts: InvariantVerdict[] = []
  const measured = new Set<string>()
  for (const job of options.jobs) {
    const m = await measureJob(job, options.d1, options.install, options.quiet ?? true)
    measured.add(job.name)
    const failed = m.error ? [`the job threw on the fixture: ${m.error}`] : []
    const readFindings = [...failed]
    if ((job.readsD1 ?? true) && m.reads.queries === 0) readFindings.push('made no D1 query on the fixture; the fixture does not reach it, or it reads through another binding')
    if (m.reads.maxQueryBytes > maxQueryBytes) {
      readFindings.push(`one query returned ${(m.reads.maxQueryBytes / MB).toFixed(1)} MB (the most is ${(maxQueryBytes / MB).toFixed(0)} MB): ${m.reads.largestSql}`)
    }
    verdicts.push({
      invariant: 'bounded-reads',
      subject: job.name,
      pass: readFindings.length === 0,
      details: readFindings.length ? readFindings : [`${m.reads.queries} queries, largest ${(m.reads.maxQueryBytes / MB).toFixed(2)} MB`],
      data: { queries: m.reads.queries, maxQueryBytes: m.reads.maxQueryBytes, largestSql: m.reads.largestSql },
    })
    const heapFindings = [...failed]
    if (m.heapGrowthBytes > maxHeap) {
      heapFindings.push(`the live heap grew ${(m.heapGrowthBytes / MB).toFixed(1)} MB (the most is ${(maxHeap / MB).toFixed(0)} MB), at its peak around: ${m.reads.peakSql}`)
    }
    verdicts.push({
      invariant: 'memory-budget',
      subject: job.name,
      pass: heapFindings.length === 0,
      details: heapFindings.length ? heapFindings : [`heap grew ${(m.heapGrowthBytes / MB).toFixed(1)} MB`],
      data: { heapGrowthBytes: m.heapGrowthBytes, peakSql: m.reads.peakSql },
    })
  }
  const missing = options.scheduled.filter((name) => !measured.has(name))
  verdicts.push({
    invariant: 'memory-budget',
    subject: 'coverage',
    pass: missing.length === 0 && options.scheduled.length > 0,
    details: missing.length
      ? missing.map((name) => `${name} is scheduled but not run on the fixture`)
      : options.scheduled.length === 0
        ? ['no scheduled jobs were named; pass every job the app schedules']
        : [`all ${options.scheduled.length} scheduled jobs ran on the fixture`],
    data: { scheduled: [...options.scheduled], measured: [...measured] },
  })
  return verdicts
}

// ── a D1 that stalls ─────────────────────────────────────────────────────────

export type StallMode = 'ok' | 'error' | 'hang'

/** The D1 binding with a switch that makes every query fail or never answer, as an overloaded D1 did. */
export function stallingD1<D extends object>(d1: D): { d1: D; stall(mode: StallMode): void; readonly mode: StallMode } {
  let mode: StallMode = 'ok'
  const fail = (): Promise<never> => mode === 'hang'
    ? new Promise<never>(() => {})
    : Promise.reject(new Error('D1_ERROR: Network connection lost.'))
  const statement = (target: object): object => new Proxy(target, {
    get(stmt, key) {
      const value = Reflect.get(stmt, key) as unknown
      if (typeof value !== 'function') return value
      if (key === 'bind') return (...params: unknown[]) => statement(value.apply(stmt, params) as object)
      if (key === 'all' || key === 'raw' || key === 'first' || key === 'run') {
        return (...args: unknown[]) => (mode === 'ok' ? value.apply(stmt, args) : fail())
      }
      return value.bind(stmt)
    },
  })
  const proxy = new Proxy(d1, {
    get(binding, key) {
      const value = Reflect.get(binding, key) as unknown
      if (key === 'prepare') return (sql: string) => statement((value as (sql: string) => object).call(binding, sql))
      if (key === 'batch') return (...args: unknown[]) => (mode === 'ok' ? (value as (...a: unknown[]) => unknown).apply(binding, args) : fail())
      return typeof value === 'function' ? value.bind(binding) : value
    },
  })
  return {
    d1: proxy,
    stall(next) {
      mode = next
    },
    get mode() {
      return mode
    },
  }
}

/** Move `Date.now` forward for the duration of a check; returns the restore. */
function shiftableClock(): { advance(ms: number): void; restore(): void } {
  const real = Date.now
  let offset = 0
  Date.now = () => real() + offset
  return {
    advance(ms) {
      offset += ms
    },
    restore() {
      Date.now = real
    },
  }
}

// ── auth survives a D1 stall ─────────────────────────────────────────────────

export interface AuthStallOptions {
  /** A label for the lookup: "session", "API key". */
  subject: string
  /** Three distinct valid credentials the app's store accepts. */
  credentials: { cached: string; revoked: string; aged: string }
  /** The app's real lookup: truthy when the credential is accepted. A throw or a falsy value is a refusal. */
  verify: (credential: string) => Promise<unknown>
  /** The app's real revoke path (revoke the key, sign the session out). */
  revoke: (credential: string) => Promise<void>
  /** Switch the D1 the lookup reads. */
  stall: (mode: StallMode) => void
  /** The keys the app's auth caches hold. */
  cacheKeys: () => string[]
  /** Include a stall that never answers (costs one lookup deadline, 2.5 s). Default true. */
  hang?: boolean
}

/**
 * A verified credential keeps working while D1 errors or stalls; it is refused
 * once revoked, and once its last verification is more than 60 s old; and the
 * cache holds SHA-256 keys, not secrets. Uses the app's real lookup, revoke
 * path and D1, with `Date.now` moved forward to age the cache.
 */
export async function checkAuthSurvivesStall(options: AuthStallOptions): Promise<InvariantVerdict> {
  const findings: string[] = []
  const accepted = async (credential: string): Promise<boolean> => {
    try {
      return Boolean(await options.verify(credential))
    } catch {
      return false
    }
  }
  const { cached, revoked, aged } = options.credentials
  const clock = shiftableClock()
  try {
    options.stall('ok')
    for (const credential of [cached, revoked, aged]) {
      if (!(await accepted(credential))) findings.push(`a valid credential was refused while D1 was healthy (${options.subject})`)
    }
    for (const key of options.cacheKeys()) {
      if (!/^[0-9a-f]{64}$/.test(key) || [cached, revoked, aged].some((credential) => key.includes(credential))) {
        findings.push(`the auth cache holds a key that is not a SHA-256 digest: ${key.slice(0, 12)}…`)
      }
    }
    await options.revoke(revoked)
    if (await accepted(revoked)) findings.push('a revoked credential was accepted while D1 was healthy')

    options.stall('error')
    if (!(await accepted(cached))) findings.push('a credential verified moments before was refused while D1 errored')
    if (await accepted(revoked)) findings.push('a revoked credential was accepted from the cache while D1 errored')
    if (options.hang ?? true) {
      options.stall('hang')
      if (!(await accepted(cached))) findings.push('a credential verified moments before was refused while D1 did not answer')
    }

    clock.advance(LAUNCH_BUDGETS.authCacheTtlMs + 1_000)
    options.stall('error')
    if (await accepted(aged)) findings.push(`a credential last verified more than ${LAUNCH_BUDGETS.authCacheTtlMs / 1000} s ago was accepted from the cache while D1 errored`)
  } finally {
    options.stall('ok')
    clock.restore()
  }
  return {
    invariant: 'auth-survives-d1-stall',
    subject: options.subject,
    pass: findings.length === 0,
    details: findings.length ? findings : [
      'served while D1 errored and while it stalled; refused after revoke and after the 60 s cache window; keys are SHA-256',
    ],
  }
}

// ── authorization before any stream ──────────────────────────────────────────

export interface AuthorizeBeforeStreamOptions {
  subject: string
  /** The app's real route handler, as its router mounts it. */
  handle: (request: Request) => Promise<Response>
  /** Requests the route must refuse: no session, another workspace's thread, a revoked key. */
  refused: ReadonlyArray<{ name: string; request: () => Request; status?: readonly number[] }>
  /** Product state the route touched (rows written, producers started); empty after every refusal. */
  touched?: () => readonly string[]
}

const STREAM_TYPES = /event-stream|ndjson|x-turn-progress/i

/** Each refused request gets a plain 4xx, opens no stream and touches nothing. */
export async function checkAuthorizeBeforeStream(options: AuthorizeBeforeStreamOptions): Promise<InvariantVerdict> {
  const findings: string[] = []
  for (const probe of options.refused) {
    const before = options.touched?.().length ?? 0
    const response = await options.handle(probe.request())
    const allowed = probe.status ?? [401, 403, 404]
    if (!allowed.includes(response.status)) findings.push(`${probe.name}: answered ${response.status}, expected ${allowed.join(' or ')}`)
    const type = response.headers.get('content-type') ?? ''
    if (STREAM_TYPES.test(type)) findings.push(`${probe.name}: opened a ${type} stream before refusing`)
    for (const [name] of response.headers) {
      if (/turn-progress|x-turn-id/i.test(name)) findings.push(`${probe.name}: refusal carries turn header ${name}`)
    }
    await response.body?.cancel().catch(() => undefined)
    const after = options.touched?.() ?? []
    if (after.length > before) findings.push(`${probe.name}: touched ${after.slice(before).join(', ')} before refusing`)
  }
  return {
    invariant: 'authorize-before-stream',
    subject: options.subject,
    pass: findings.length === 0 && options.refused.length > 0,
    details: findings.length ? findings : options.refused.length
      ? [`${options.refused.length} refused requests answered plainly with nothing touched`]
      : ['no refused requests were probed'],
  }
}

// ── coalesced turn events ────────────────────────────────────────────────────

/** One event of the recorded long turn and the turn-relative time it arrived. */
export interface TimedTurnEvent {
  atMs: number
  event: Record<string, unknown>
}

/**
 * The long turn GTM recorded on 2026-10-10, reproduced in shape: a reasoning
 * model streaming three events per token (the harness's raw part update, a
 * model-processing heartbeat and the delta), with tool calls between runs of
 * reasoning and text. 59,659 events over about ten minutes, as that turn wrote
 * them before coalescing.
 */
export function recordedLongTurn(options: { tokens?: number; toolCalls?: number; tokenMs?: number } = {}): TimedTurnEvent[] {
  const tokens = options.tokens ?? 19_866
  const toolCalls = options.toolCalls ?? 30
  const tokenMs = options.tokenMs ?? 30
  const events: TimedTurnEvent[] = [{ atMs: 0, event: { type: 'turn', turnId: 'recorded-long-turn' } }]
  const toolEvery = Math.max(1, Math.floor(tokens / (toolCalls + 1)))
  let tool = 0
  let part = 0
  for (let index = 0; index < tokens; index += 1) {
    const atMs = (index + 1) * tokenMs
    if (index > 0 && index % toolEvery === 0 && tool < toolCalls) {
      tool += 1
      part += 1
      events.push({ atMs, event: { type: 'tool_call', id: `call_${tool}`, name: 'bash', input: { command: 'ls' } } })
      events.push({ atMs: atMs + 1, event: { type: 'tool_result', id: `call_${tool}`, output: 'ok' } })
    }
    const kind = part % 2 === 0 ? 'reasoning' : 'text'
    const partId = `prt_${part}`
    events.push({ atMs, event: { type: 'raw', data: { type: 'raw', backend: 'opencode', event: { type: kind, timestamp: atMs, part: { id: partId, type: kind, metadata: { at: atMs } } } } } })
    events.push({ atMs, event: { type: 'model-processing', data: { elapsedMs: atMs } } })
    events.push({ atMs, event: { type: kind, text: `t${index} ` } })
  }
  return events
}

export interface CoalescedTurnOptions {
  subject: string
  /**
   * Start persisting one turn through the app's real turn persistence (its turn
   * store and buffer, as its chat route builds them). `detach` hands the turn
   * to a durable owner the way the route's completion handoff does; omit it when
   * the app has no detached lane.
   */
  open: (turnId: string) => Promise<{
    onEvent(event: unknown): Promise<void>
    detach?(): Promise<void>
    done(): Promise<void>
  }>
  /** Stored events for the turn. */
  count: (turnId: string) => Promise<number>
  maxEvents?: number
  fixture?: readonly TimedTurnEvent[]
}

/** The recorded long turn stores at most 5,000 events, attached and after a handoff. */
export async function checkCoalescedTurn(options: CoalescedTurnOptions): Promise<InvariantVerdict> {
  const maxEvents = options.maxEvents ?? LAUNCH_BUDGETS.turnEvents
  const fixture = options.fixture ?? recordedLongTurn()
  const findings: string[] = []
  const stored: Record<string, number> = {}
  const real = Date.now
  for (const lane of ['attached', 'detached'] as const) {
    const turnId = `invariant-long-turn-${lane}`
    const start = real()
    let clock = start
    Date.now = () => clock
    try {
      const tap = await options.open(turnId)
      if (lane === 'detached' && !tap.detach) continue
      for (const [index, item] of fixture.entries()) {
        clock = start + item.atMs
        await tap.onEvent(item.event)
        if (lane === 'detached' && index === 0) await tap.detach!()
      }
      clock = start + (fixture.at(-1)?.atMs ?? 0) + 1
      await tap.done()
      stored[lane] = await options.count(turnId)
    } finally {
      Date.now = real
    }
    if (stored[lane] === 0) findings.push(`${lane}: the turn stored no events; the check did not reach the app's turn store`)
    if (stored[lane]! > maxEvents) findings.push(`${lane}: the recorded long turn (${fixture.length.toLocaleString('en-US')} events) stored ${stored[lane]!.toLocaleString('en-US')}; the most is ${maxEvents.toLocaleString('en-US')}`)
  }
  return {
    invariant: 'coalesced-events',
    subject: options.subject,
    pass: findings.length === 0,
    details: findings.length ? findings : Object.entries(stored).map(([lane, count]) => `${lane}: ${fixture.length.toLocaleString('en-US')} events stored as ${count.toLocaleString('en-US')}`),
    data: { fixtureEvents: fixture.length, stored },
  }
}

// ── limit alarms ─────────────────────────────────────────────────────────────

/** Hard platform limits a declared budget may not exceed. */
export const PLATFORM_LIMITS = {
  /** A Worker isolate's memory. */
  'worker-memory': 128 * MB,
  /** Platform snapshots per sandbox; the cap GTM hit on 2026-10-10. */
  'snapshot-count': 25,
  /** Requests per minute per operator key. */
  'key-rate': 60,
} as const

export interface LimitAlarmCheckOptions {
  subject: string
  /** Build the app's real limit alarms (its budgets and wiring) over a capturing sink. */
  create: (sink: AlertSink) => LimitAlarms | Promise<LimitAlarms>
}

/** Every resource alarms at 80% and not below, escalates at the limit, and no budget exceeds the platform's. */
export async function checkLimitAlarms(options: LimitAlarmCheckOptions): Promise<InvariantVerdict> {
  const findings: string[] = []
  for (const resource of LIMIT_RESOURCES) {
    const delivered: TurnHealthAlert[] = []
    const alarms = await options.create({ deliver: async (alert) => { delivered.push(alert) } })
    const limit = alarms.budgets[resource]
    const platform = (PLATFORM_LIMITS as Partial<Record<string, number>>)[resource]
    if (platform !== undefined && limit > platform) findings.push(`${resource}: the declared limit ${limit} is above the platform's ${platform}`)
    await alarms.observe(resource, limit * 0.79)
    if (delivered.length) findings.push(`${resource}: alarmed at 79% of its limit`)
    await alarms.observe(resource, limit * LAUNCH_BUDGETS.alarmRatio)
    if (delivered.length !== 1 || delivered[0]?.severity !== 'warning') findings.push(`${resource}: did not warn at 80% of its limit`)
    await alarms.observe(resource, limit)
    if (delivered.length !== 2 || delivered[1]?.severity !== 'critical') findings.push(`${resource}: did not raise a critical alert at its limit`)
  }
  return {
    invariant: 'limit-alarms',
    subject: options.subject,
    pass: findings.length === 0,
    details: findings.length ? findings : [`${LIMIT_RESOURCES.join(', ')} warn at 80% and page at the limit`],
  }
}

export {
  buildConformanceReport,
  formatConformanceReport,
  readDeploymentFacts,
  readVerdicts,
  type ConformanceReport,
  type DeploymentFacts,
  type InvariantReport,
  type InvariantStatus,
  type LaunchInvariantsConfig,
} from './conformance.js'
