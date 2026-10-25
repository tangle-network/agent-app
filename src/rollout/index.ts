/**
 * Rollout guard: a staged rollout widens only when the stage it leaves met
 * that stage's kill lines on measured production numbers.
 *
 * WHY. Hospitality's routed lane widened from two QA workspaces to `*` at a
 * first-words p50 of 3.54 s, past kill lines of 2.5 s and 3.0 s
 * (hospitality-agent #382). The numbers existed; nothing read them
 * before the list changed. This module is the one place that reads them.
 *
 * THE LIST. A rollout is one comma-separated value, usually a deploy variable
 * such as `HOSPITALITY_ROUTED_BUSINESS_IDS`: workspace ids, `*` for every
 * workspace, `!<id>` to keep one out whatever else matches, and
 * `new-since:<ISO time>` for workspaces created at or after that time.
 * {@link rolloutAdmits} is the reference reading of that grammar.
 *
 * THE RULE ({@link decideRollout}).
 * - Narrowing is always allowed. Holds and widenings measure the current stage.
 * - A widening must land on a declared stage, the next one after the current
 *   value's stage, never past it.
 * - The stage being left must have at least `minSamples` measured turns and
 *   every kill line met. A missing metric leaves the decision undecided.
 * - Missing samples are undecided; a measured breach names each reason (`first_words_p50_ms 3540 over kill line 2500`).
 * - A hold given `liveSince` (when the deployed commit went live) judges only turns served since then: it refuses
 *   a breach only when the measurement's window starts at or after it, and is otherwise undecided. A deploy that
 *   keeps the list is never refused on turns the previous deploy already served (Legal, 2026-10-22, run 39714417347).
 *
 * Every decision, allowed, refused or undecided, is returned as one record the caller
 * persists (the CLI appends it to a JSONL ledger and hands it to the
 * config's `record`).
 */

/** A kill line: the measured value must stay at or under `max` and at or over `min`. */
export interface RolloutKillLine {
  max?: number
  min?: number
}

export interface RolloutStage {
  /** Short name used in refusals and records, e.g. `qa`, `all-but-recenter`. */
  name: string
  /** The exact list value that defines this stage. */
  value: string
  /** Turns the stage must have served, measured, before the rollout may leave it. */
  minSamples: number
  /** Metric name → line. Metric names are the product's, e.g. `first_words_p50_ms`, `failure_rate`. */
  kill: Record<string, RolloutKillLine>
}

export interface RolloutPlan {
  /** e.g. `hospitality-routed-chat`. */
  name: string
  /** The deploy variable that carries the list, e.g. `HOSPITALITY_ROUTED_BUSINESS_IDS`. */
  variable: string
  /** In widening order. */
  stages: RolloutStage[]
}

/** Production numbers for one stage, from the product's own instrument. */
export interface StageMeasurement {
  stage: string
  samples: number
  /** Lane name for the stage sample floor; defaults to the stage name. */
  lane?: string
  /** Additional lane sample floors, evaluated as missing evidence rather than breaches. */
  sampleRequirements?: Record<string, { samples: number; minSamples: number }>
  metrics: Record<string, number | null | undefined>
  /** Where the numbers came from (ledger, query, soak), for the record. */
  source?: string
  window?: { from: string; to: string }
}

export interface RolloutDecision {
  rollout: string
  variable: string
  from: { value: string; stage: string | null }
  to: { value: string; stage: string | null }
  widens: boolean
  decision: 'allowed' | 'refused' | 'undecided'
  recommendation: 'widen' | 'hold' | 'narrow' | 'refuse'
  turnsNeeded: Record<string, number>
  /** Breaches or evidence deficits, including observations made while narrowing. */
  reasons: string[]
  measured: StageMeasurement | null
  at: string
}

export interface ParsedRolloutList {
  all: boolean
  ids: ReadonlySet<string>
  excluded: ReadonlySet<string>
  /** Epoch ms of each `new-since:` entry. */
  newSince: readonly number[]
}

export function parseRolloutList(value: string | null | undefined): ParsedRolloutList {
  const ids = new Set<string>()
  const excluded = new Set<string>()
  const newSince: number[] = []
  let all = false
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry === '*') all = true
    else if (entry.startsWith('!')) excluded.add(entry.slice(1).trim())
    else if (entry.startsWith('new-since:')) {
      const at = Date.parse(entry.slice('new-since:'.length))
      if (!Number.isFinite(at)) throw new Error(`rollout list entry ${entry} is not a valid time`)
      newSince.push(at)
    } else ids.add(entry)
  }
  return { all, ids, excluded, newSince }
}

/** Whether a list admits one workspace. `createdAt` (epoch ms) is needed only for `new-since:` entries. */
export function rolloutAdmits(value: string | ParsedRolloutList, workspace: { id: string; createdAt?: number }): boolean {
  const list = typeof value === 'string' ? parseRolloutList(value) : value
  if (list.excluded.has(workspace.id)) return false
  if (list.all || list.ids.has(workspace.id)) return true
  return workspace.createdAt !== undefined && list.newSince.some(at => workspace.createdAt! >= at)
}

/**
 * Whether `to` may admit a workspace `from` does not. Conservative: a change it
 * cannot prove narrower counts as a widening.
 */
export function rolloutWidens(fromValue: string, toValue: string): boolean {
  const from = parseRolloutList(fromValue)
  const to = parseRolloutList(toValue)
  if (to.all) {
    if (!from.all) return true
    // Under `*` on both sides, only a dropped exclusion widens.
    return [...from.excluded].some(id => !to.excluded.has(id))
  }
  if ([...to.ids].some(id => !rolloutAdmits(from, { id }))) return true
  // An id `from` admitted only because it was listed, which `to` now excludes, narrows; nothing else here widens.
  const earliest = (list: ParsedRolloutList) => list.newSince.length ? Math.min(...list.newSince) : Infinity
  if (to.newSince.length && !from.all && earliest(to) < earliest(from)) return true
  return false
}

/** Canonical form for matching a value to a stage: entries trimmed and sorted. */
export function normalizeRolloutValue(value: string): string {
  return value.split(',').map(entry => entry.trim()).filter(Boolean).sort().join(',')
}

function stageOf(plan: RolloutPlan, value: string): RolloutStage | null {
  const key = normalizeRolloutValue(value)
  return plan.stages.find(stage => normalizeRolloutValue(stage.value) === key) ?? null
}

/** Finite measured breaches only. Missing observations and sample floors are evidence deficits. */
export function killLineBreaches(stage: RolloutStage, measured: StageMeasurement | null): string[] {
  if (!measured || measured.stage !== stage.name) return []
  return Object.entries(stage.kill).flatMap(([metric, line]) => {
    const value = measured.metrics[metric]
    if (typeof value !== 'number' || !Number.isFinite(value)) return []
    return [
      ...(line.max !== undefined && value > line.max ? [`${metric} ${value} over kill line ${line.max}`] : []),
      ...(line.min !== undefined && value < line.min && !metric.endsWith('samples') ? [`${metric} ${value} under kill line ${line.min}`] : []),
    ]
  })
}

export function validateRolloutPlan(plan: RolloutPlan): void {
  if (!plan.name || !plan.variable) throw new Error('a rollout plan needs a name and a variable')
  if (!plan.stages.length) throw new Error(`rollout ${plan.name} declares no stages`)
  const names = new Set<string>()
  const values = new Set<string>()
  for (const stage of plan.stages) {
    if (names.has(stage.name)) throw new Error(`rollout ${plan.name} repeats stage ${stage.name}`)
    names.add(stage.name)
    const value = normalizeRolloutValue(stage.value)
    if (values.has(value)) throw new Error(`rollout ${plan.name} gives two stages the value ${stage.value}`)
    values.add(value)
    parseRolloutList(stage.value)
    if (!Number.isInteger(stage.minSamples) || stage.minSamples < 1) {
      throw new Error(`stage ${stage.name} needs minSamples of at least 1`)
    }
    if (!Object.keys(stage.kill).length) throw new Error(`stage ${stage.name} declares no kill lines`)
  }
  for (let index = 1; index < plan.stages.length; index++) {
    const previous = plan.stages[index - 1]!
    const stage = plan.stages[index]!
    if (!rolloutWidens(previous.value, stage.value)) {
      throw new Error(`stage ${stage.name} does not widen stage ${previous.name}`)
    }
  }
}

/** Stable per-turn percentage assignment; the product records the returned arm on its row and trace. */
export function assignRolloutArm(turnId: string, treatmentPct: number): 'control' | 'treatment' {
  if (!Number.isFinite(treatmentPct) || treatmentPct < 0 || treatmentPct > 100) {
    throw new RangeError('treatmentPct must be between 0 and 100')
  }
  let hash = 2166136261
  for (let i = 0; i < turnId.length; i++) hash = Math.imul(hash ^ turnId.charCodeAt(i), 16777619)
  return (hash >>> 0) / 2 ** 32 < treatmentPct / 100 ? 'treatment' : 'control'
}

const DEFAULT_MEASUREMENT_TIMEOUT_MS = 5_000

/** Measure the current stage for widening, holding and narrowing. Narrowing always remains available. */
export async function decideRollout(input: {
  plan: RolloutPlan
  fromValue: string
  toValue: string
  /** `scope.since` (epoch ms) is set for a hold given `liveSince`: measure the turns at or after it. */
  measure(stage: RolloutStage, signal?: AbortSignal, scope?: { since?: number }): Promise<StageMeasurement | null>
  /** Bound observation even when the product instrument ignores cancellation. */
  measurementTimeoutMs?: number
  /** Epoch ms the deployed commit went live. A hold refuses only a breach measured on turns since then. */
  liveSince?: number
  now?: () => Date
}): Promise<RolloutDecision> {
  const { plan, fromValue, toValue } = input
  validateRolloutPlan(plan)
  const fromStage = stageOf(plan, fromValue)
  const toStage = stageOf(plan, toValue)
  const widens = rolloutWidens(fromValue, toValue)
  const narrowing = !widens && normalizeRolloutValue(fromValue) !== normalizeRolloutValue(toValue)
  const holdSince = !widens && !narrowing && Number.isFinite(input.liveSince) ? input.liveSince : undefined
  const record = (decision: RolloutDecision['decision'], reasons: string[], measured: StageMeasurement | null,
    turnsNeeded: Record<string, number> = {}, breach = false): RolloutDecision => ({
    rollout: plan.name, variable: plan.variable,
    from: { value: fromValue, stage: fromStage?.name ?? null },
    to: { value: toValue, stage: toStage?.name ?? null }, widens, decision,
    recommendation: narrowing || breach ? 'narrow' : decision === 'refused' ? 'refuse' : decision === 'undecided' ? 'hold' : widens ? 'widen' : 'hold',
    turnsNeeded, reasons, measured, at: (input.now?.() ?? new Date()).toISOString(),
  })
  if (widens) {
    if (!toStage) return record('refused', [`${toValue} is not a declared stage of ${plan.name}`], null)
    const target = plan.stages.indexOf(toStage)
    if (!fromStage) {
      const empty = !normalizeRolloutValue(fromValue)
      return empty && target === 0 ? record('allowed', [], null)
        : record('refused', [`the current value ${fromValue || '(empty)'} is not a declared stage of ${plan.name}`], null)
    }
    const current = plan.stages.indexOf(fromStage)
    if (target > current + 1) return record('refused', [`${toStage.name} skips ${plan.stages.slice(current + 1, target).map(stage => stage.name).join(', ')}`], null)
  }
  if (!fromStage) return record('allowed', [], null)
  const timeoutMs = input.measurementTimeoutMs ?? DEFAULT_MEASUREMENT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('measurementTimeoutMs must be positive')
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let measured: StageMeasurement | null
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('measurement timed out')
        abort.abort(error)
        reject(error)
      }, timeoutMs)
    })
    measured = await Promise.race([input.measure(fromStage, abort.signal, holdSince === undefined ? undefined : { since: holdSince }), deadline])
  }
  catch (error) {
    return record(narrowing ? 'allowed' : 'undecided', [`measuring stage ${fromStage.name} failed: ${error instanceof Error ? error.message : String(error)}`], null,
      { [fromStage.name]: fromStage.minSamples })
  } finally {
    clearTimeout(timer)
  }
  const lane = measured?.lane ?? fromStage.name
  const requirements = { ...measured?.sampleRequirements }
  requirements[lane] = {
    samples: Math.min(measured?.samples ?? 0, requirements[lane]?.samples ?? Infinity),
    minSamples: Math.max(fromStage.minSamples, requirements[lane]?.minSamples ?? 0),
  }
  // Older product configs expressed control floors as *_samples minimum kill lines.
  for (const [metric, line] of Object.entries(fromStage.kill)) {
    if (metric.endsWith('samples') && line.min !== undefined) {
      requirements[metric] = { samples: measured?.metrics[metric] ?? 0, minSamples: line.min }
    }
  }
  const turnsNeeded = Object.fromEntries(Object.entries(requirements)
    .map(([lane, floor]) => [lane, Math.max(0, Math.ceil(floor.minSamples - (Number.isFinite(floor.samples) ? floor.samples : 0)))] as const)
    .filter(([, needed]) => needed > 0))
  const measuredStage = measured?.stage === fromStage.name
  const breaches = killLineBreaches(fromStage, measured)
  const missing = !measuredStage ? [`stage ${fromStage.name} has no matching measurement`]
    : Object.keys(fromStage.kill).filter(metric => !Number.isFinite(measured!.metrics[metric])).map(metric => `${metric} was not measured`)
  const windowFrom = Date.parse(measured?.window?.from ?? '')
  const stale = holdSince !== undefined && breaches.length > 0 && !(windowFrom >= holdSince)
    ? [`the breach was measured on turns from ${measured?.window?.from ?? 'an unstated time'}, before the deployed commit went live at ${new Date(holdSince).toISOString()}; only turns since then can refuse a hold`]
    : []
  const reasons = [...breaches, ...stale, ...missing, ...Object.entries(turnsNeeded).map(([lane, needed]) => `${lane} needs ${needed} more turns`)]
  return record(narrowing ? 'allowed' : breaches.length && !stale.length ? 'refused' : reasons.length ? 'undecided' : 'allowed', reasons, measured, turnsNeeded, breaches.length > 0)
}
