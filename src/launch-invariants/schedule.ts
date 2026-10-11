/**
 * Scheduled jobs that cannot take each other down.
 *
 * On 2026-10-10 at 21:00Z GTM's turn health ran out of memory while the hourly
 * sweeps shared one scheduled run, and none of the eight queued after it ran.
 * Here each scheduled invocation runs exactly one job. A cron can carry a
 * minute list (`0,1,2 * * * *`) with one job per minute, so a Worker keeps a
 * few trigger expressions while every job gets its own invocation, its own
 * memory and its own failure.
 *
 * Cloudflare hands the handler the configured string verbatim as `event.cron`,
 * so dispatch is exact-string; a tick no entry handles is reported as
 * unhandled instead of silently running nothing. {@link checkIsolatedJobs}
 * holds the table against the deployment's configured crons.
 */
import { LAUNCH_BUDGETS, type InvariantVerdict } from './catalog.js'

/** One cron expression and the job it runs, or one job per listed minute. */
export type ScheduleEntry =
  | { cron: string; job: string }
  | { cron: string; minutes: Readonly<Record<number, string>> }

/** One scheduled invocation: the cron, the minute for a minute-list entry, and the job it runs. */
export interface ScheduleSlot {
  cron: string
  minute?: number
  job: string
}

export interface ScheduledJobInput<Ctx> {
  cron: string
  scheduledTime: Date
  context: Ctx
  /** 1 for the first try. */
  attempt: number
}

export type ScheduledJob<Ctx> = (input: ScheduledJobInput<Ctx>) => Promise<unknown>

export interface ScheduledDispatchOptions<Ctx> {
  entries: readonly ScheduleEntry[]
  jobs: Readonly<Record<string, ScheduledJob<Ctx>>>
  /** Waits before each retry of a failed job; empty (the default) runs a job once. Jobs that retry must be idempotent. */
  retryDelaysMs?: readonly number[]
  log?: {
    info(message: string, detail?: Record<string, unknown>): void
    error(message: string, detail?: Record<string, unknown>): void
  }
  /** Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

export interface ScheduledJobOutcome {
  job: string
  ok: boolean
  attempts: number
  durationMs: number
  error?: string
}

export interface ScheduledDispatchResult {
  handled: boolean
  job: string | null
  /** Settles when the job's last attempt ends; never rejects. */
  done: Promise<ScheduledJobOutcome | null>
}

export interface ScheduledDispatch<Ctx> {
  readonly entries: readonly ScheduleEntry[]
  /** Every invocation the table can make. */
  slots(): ScheduleSlot[]
  /** The job a tick runs, or null when no entry handles it. */
  jobFor(cron: string, scheduledTime: number | Date): string | null
  /**
   * Run the tick's one job. With `waitUntil` the job runs in the background and
   * this returns at once; without it, this waits for the job.
   */
  dispatch(
    event: { cron: string; scheduledTime: number | Date },
    context: Ctx,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): Promise<ScheduledDispatchResult>
}

export function createScheduledDispatch<Ctx>(options: ScheduledDispatchOptions<Ctx>): ScheduledDispatch<Ctx> {
  const problems = validateEntries(options.entries, Object.keys(options.jobs))
  if (problems.length) throw new Error(`scheduled dispatch: ${problems.join('; ')}`)
  const byCron = new Map(options.entries.map((entry) => [entry.cron, entry]))
  const retryDelaysMs = options.retryDelaysMs ?? []
  const log = options.log ?? {
    info: (message: string, detail?: Record<string, unknown>) => console.log(message, detail ?? ''),
    error: (message: string, detail?: Record<string, unknown>) => console.error(message, detail ?? ''),
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  function jobFor(cron: string, scheduledTime: number | Date): string | null {
    const entry = byCron.get(cron)
    if (!entry) return null
    if ('job' in entry) return entry.job
    const minute = new Date(scheduledTime).getUTCMinutes()
    return entry.minutes[minute] ?? null
  }

  async function runJob(job: string, cron: string, scheduledTime: Date, context: Ctx): Promise<ScheduledJobOutcome> {
    const run = options.jobs[job]!
    const started = Date.now()
    let lastError = ''
    for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt += 1) {
      try {
        await run({ cron, scheduledTime, context, attempt })
        return { job, ok: true, attempts: attempt, durationMs: Date.now() - started }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const delay = retryDelaysMs[attempt - 1]
        if (delay === undefined) break
        log.error(`[scheduled] ${job} failed; retrying`, { attempt, error: lastError })
        await sleep(delay)
      }
    }
    log.error(`[scheduled] ${job} failed`, { attempts: retryDelaysMs.length + 1, error: lastError })
    return { job, ok: false, attempts: retryDelaysMs.length + 1, durationMs: Date.now() - started, error: lastError }
  }

  return {
    entries: options.entries,
    slots: () => slotsOf(options.entries),
    jobFor,
    async dispatch(event, context, waitUntil) {
      const scheduledTime = new Date(event.scheduledTime)
      const job = jobFor(event.cron, scheduledTime)
      if (!job) {
        log.error(`[scheduled] no job handles cron "${event.cron}" at minute ${scheduledTime.getUTCMinutes()}; the configured crons and the schedule disagree`)
        return { handled: false, job: null, done: Promise.resolve(null) }
      }
      const done = runJob(job, event.cron, scheduledTime, context)
      if (waitUntil) waitUntil(done)
      else await done
      return { handled: true, job, done }
    },
  }
}

/** Every invocation a schedule table can make. */
export function slotsOf(entries: readonly ScheduleEntry[]): ScheduleSlot[] {
  return entries.flatMap((entry) => 'job' in entry
    ? [{ cron: entry.cron, job: entry.job }]
    : Object.entries(entry.minutes).map(([minute, job]) => ({ cron: entry.cron, minute: Number(minute), job })))
}

function validateEntries(entries: readonly ScheduleEntry[], jobNames: readonly string[]): string[] {
  const problems: string[] = []
  const known = new Set(jobNames)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.cron)) problems.push(`cron "${entry.cron}" is listed twice`)
    seen.add(entry.cron)
    const fields = entry.cron.trim().split(/\s+/)
    if (fields.length !== 5) problems.push(`cron "${entry.cron}" does not have five fields`)
    for (const slot of slotsOf([entry])) {
      if (!known.has(slot.job)) problems.push(`cron "${entry.cron}" names job "${slot.job}", which is not defined`)
    }
    if ('minutes' in entry) {
      const listed = minuteList(fields[0] ?? '')
      const mapped = Object.keys(entry.minutes).map(Number).sort((a, b) => a - b)
      if (!listed) problems.push(`cron "${entry.cron}" maps jobs by minute, so its minute field must be a list of minutes`)
      else if (listed.join(',') !== mapped.join(',')) {
        problems.push(`cron "${entry.cron}" lists minutes ${listed.join(',')} but maps jobs to ${mapped.join(',')}`)
      }
    }
  }
  return problems
}

/** The minutes of a plain minute list (`5` or `0,15,30`), or null for any other form. */
function minuteList(field: string): number[] | null {
  if (!/^\d{1,2}(,\d{1,2})*$/.test(field)) return null
  const minutes = field.split(',').map(Number)
  if (minutes.some((minute) => minute > 59)) return null
  return [...new Set(minutes)].sort((a, b) => a - b)
}

// ── cron analysis ────────────────────────────────────────────────────────────

function expandField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const [, range, stepText] = match
    const step = stepText ? Number(stepText) : 1
    if (!(step >= 1)) return null
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range!.split('-').map(Number)
      lo = a!
      hi = b ?? (stepText ? max : a!)
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let value = lo; value <= hi; value += step) values.add(value)
  }
  return values
}

/**
 * The minutes of the day (0–1439, UTC) a cron fires, or null when it does not
 * fire every day (a day-of-month, month or weekday restriction) or cannot be read.
 */
export function cronDailyFirings(cron: string): Set<number> | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string]
  if (dayField !== '*' || monthField !== '*' || (weekdayField !== '*' && weekdayField !== '?')) return null
  const minutes = expandField(minuteField, 0, 59)
  const hours = expandField(hourField, 0, 23)
  if (!minutes || !hours) return null
  const firings = new Set<number>()
  for (const hour of hours) for (const minute of minutes) firings.add(hour * 60 + minute)
  return firings
}

/** The longest wait, in minutes, between consecutive firings over a day, or null when they do not fire daily. */
export function longestGapMinutes(firings: Iterable<number>): number | null {
  const sorted = [...new Set(firings)].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  let gap = sorted[0]! + 1440 - sorted[sorted.length - 1]!
  for (let index = 1; index < sorted.length; index += 1) gap = Math.max(gap, sorted[index]! - sorted[index - 1]!)
  return gap
}

/** The cron expressions a wrangler config declares, top level and per environment. */
export interface WranglerCrons {
  top: string[]
  envs: Record<string, string[]>
}

/** Read `[triggers] crons` (and `[env.<name>.triggers]`) from wrangler.toml, or `triggers.crons` from wrangler.json(c). */
export function parseWranglerCrons(source: string, format: 'toml' | 'json'): WranglerCrons {
  return format === 'json' ? parseJsonCrons(source) : parseTomlCrons(source)
}

function parseTomlCrons(source: string): WranglerCrons {
  const result: WranglerCrons = { top: [], envs: {} }
  let table = ''
  let collecting: string[] | null = null
  let buffer = ''
  for (const raw of source.split('\n')) {
    const line = stripTomlComment(raw)
    if (collecting) {
      buffer += ` ${line}`
      if (line.includes(']')) {
        collecting.push(...quoted(buffer))
        collecting = null
        buffer = ''
      }
      continue
    }
    const header = /^\s*\[([^\[\]]+)\]\s*$/.exec(line)
    if (header) {
      table = header[1]!.trim()
      continue
    }
    const assignment = /^\s*crons\s*=\s*(.*)$/.exec(line)
    if (!assignment) continue
    const envName = /^env\.([^.]+)\.triggers$/.exec(table)?.[1]
    const target = table === 'triggers' ? result.top : envName ? (result.envs[envName] ??= []) : null
    if (!target) continue
    const rest = assignment[1]!
    if (rest.includes(']')) target.push(...quoted(rest))
    else {
      collecting = target
      buffer = rest
    }
  }
  return result
}

function stripTomlComment(line: string): string {
  let quote: string | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}

function quoted(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? '')
}

function parseJsonCrons(source: string): WranglerCrons {
  const config = JSON.parse(stripJsonComments(source)) as {
    triggers?: { crons?: string[] }
    env?: Record<string, { triggers?: { crons?: string[] } }>
  }
  return {
    top: [...(config.triggers?.crons ?? [])],
    envs: Object.fromEntries(Object.entries(config.env ?? {})
      .filter(([, env]) => Array.isArray(env.triggers?.crons))
      .map(([name, env]) => [name, [...env.triggers!.crons!]])),
  }
}

function stripJsonComments(source: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]
    if (inString) {
      out += char
      if (char === '\\') out += source[++index] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
    } else if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
    } else out += char
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// ── the invariant ────────────────────────────────────────────────────────────

/** What one scheduled invocation was observed to run. */
export interface ObservedSlot {
  cron: string
  minute?: number
  /** The jobs the invocation ran; exactly one passes. */
  jobs: readonly string[]
}

export interface IsolatedJobsInput {
  /** Every cron the deployment configures, from each wrangler environment. */
  configuredCrons: readonly string[]
  /** What each invocation runs: from {@link slotsOf} for a {@link createScheduledDispatch} table, or observed by driving the app's own handler. */
  slots: readonly ObservedSlot[]
  /** Jobs that recover and settle turns; each must run at least every 15 minutes. */
  recoveryJobs: readonly string[]
  /** Default {@link LAUNCH_BUDGETS.recoveryEveryMs}. */
  everyMs?: number
}

/** One job per invocation, the table and the deployment agree, and recovery runs at least every 15 minutes. */
export function checkIsolatedJobs(input: IsolatedJobsInput): InvariantVerdict {
  const everyMinutes = (input.everyMs ?? LAUNCH_BUDGETS.recoveryEveryMs) / 60_000
  const findings: string[] = []
  const configured = new Set(input.configuredCrons)
  const dispatched = new Set(input.slots.map((slot) => slot.cron))
  for (const cron of configured) if (!dispatched.has(cron)) findings.push(`configured cron "${cron}" runs no job: no schedule entry matches it`)
  for (const cron of dispatched) if (!configured.has(cron)) findings.push(`schedule cron "${cron}" is not configured, so it never runs`)
  for (const slot of input.slots) {
    const where = `cron "${slot.cron}"${slot.minute !== undefined ? ` at minute ${slot.minute}` : ''}`
    if (slot.jobs.length !== 1) findings.push(`${where} runs ${slot.jobs.length} jobs in one invocation (${slot.jobs.join(', ') || 'none'}); one failure ends the rest`)
  }
  const byCron = new Map<string, ObservedSlot[]>()
  for (const slot of input.slots) byCron.set(slot.cron, [...(byCron.get(slot.cron) ?? []), slot])
  for (const [cron, slots] of byCron) {
    const minuteSlots = slots.filter((slot) => slot.minute !== undefined)
    if (minuteSlots.length === 0) continue
    const listed = minuteList(cron.trim().split(/\s+/)[0] ?? '')
    const mapped = [...new Set(minuteSlots.map((slot) => slot.minute!))].sort((a, b) => a - b)
    if (!listed || listed.join(',') !== mapped.join(',')) {
      findings.push(`cron "${cron}" fires at minutes ${listed?.join(',') ?? '(not a minute list)'} but jobs are mapped to ${mapped.join(',')}`)
    }
  }
  if (input.recoveryJobs.length === 0) findings.push('no turn recovery or orphan settlement job is declared')
  const gaps: Record<string, number | null> = {}
  for (const job of input.recoveryJobs) {
    const firings = new Set<number>()
    let daily = false
    for (const slot of input.slots) {
      if (slot.jobs.length !== 1 || slot.jobs[0] !== job) continue
      const fires = cronDailyFirings(slot.cron)
      if (!fires) continue
      daily = true
      for (const minuteOfDay of fires) if (slot.minute === undefined || minuteOfDay % 60 === slot.minute) firings.add(minuteOfDay)
    }
    const gap = daily ? longestGapMinutes(firings) : null
    gaps[job] = gap
    if (gap === null) findings.push(`recovery job "${job}" is not scheduled to run every day on its own`)
    else if (gap > everyMinutes) findings.push(`recovery job "${job}" can wait ${gap} minutes between runs; the most is ${everyMinutes}`)
  }
  return {
    invariant: 'isolated-jobs',
    subject: 'schedule',
    pass: findings.length === 0,
    details: findings.length ? findings : [
      `${input.slots.length} scheduled invocations, one job each, across ${configured.size} configured crons`,
      ...input.recoveryJobs.map((job) => `${job} runs at least every ${gaps[job]} minutes`),
    ],
    data: { configuredCrons: [...configured], slots: input.slots.length, recoveryGapsMinutes: gaps },
  }
}
