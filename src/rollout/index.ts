/**
 * Rollout guard: a staged rollout widens only when the stage it leaves met
 * that stage's kill lines on measured production numbers.
 *
 * WHY. Hospitality's routed lane widened from two QA workspaces to `*` at a
 * first-words p50 of 3.54 s, past kill lines of 2.5 s and 3.0 s
 * (hospitality-agent #382, 2026-10-11). The numbers existed; nothing read them
 * before the list changed. This module is the one place that reads them.
 *
 * THE LIST. A rollout is one comma-separated value, usually a deploy variable
 * such as `HOSPITALITY_ROUTED_BUSINESS_IDS`: workspace ids, `*` for every
 * workspace, `!<id>` to keep one out whatever else matches, and
 * `new-since:<ISO time>` for workspaces created at or after that time.
 * {@link rolloutAdmits} is the reference reading of that grammar.
 *
 * THE RULE ({@link decideRollout}).
 * - A change that admits no workspace the current value did not (a narrowing,
 *   a rollback, the same stage) is always allowed: a guard that can block a
 *   rollback is worse than none.
 * - A widening must land on a declared stage, the next one after the current
 *   value's stage, never past it.
 * - The stage being left must have at least `minSamples` measured turns and
 *   every kill line met. A metric that was not measured fails its line.
 * - A refusal names each reason (`first_words_p50_ms 3540 over kill line 2500`).
 *
 * Every decision, allowed or refused, is returned as one record the caller
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
  decision: 'allowed' | 'refused'
  /** Empty when allowed; each refusal reason otherwise. */
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

/** Each kill line the measurement misses, as a reason. Empty when every line holds. */
export function killLineBreaches(stage: RolloutStage, measured: StageMeasurement | null): string[] {
  if (!measured) return [`stage ${stage.name} has no measurement`]
  if (measured.stage !== stage.name) return [`measurement is for stage ${measured.stage}, not ${stage.name}`]
  const reasons: string[] = []
  if (!(measured.samples >= stage.minSamples)) {
    reasons.push(`stage ${stage.name} has ${measured.samples} measured turns, under its minimum of ${stage.minSamples}`)
  }
  for (const [metric, line] of Object.entries(stage.kill)) {
    const value = measured.metrics[metric]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reasons.push(`${metric} was not measured`)
      continue
    }
    if (line.max !== undefined && value > line.max) reasons.push(`${metric} ${value} over kill line ${line.max}`)
    if (line.min !== undefined && value < line.min) reasons.push(`${metric} ${value} under kill line ${line.min}`)
  }
  return reasons
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

/**
 * Decide one change of the list. `measure` is called only for a widening, and
 * only for the stage being left.
 */
export async function decideRollout(input: {
  plan: RolloutPlan
  fromValue: string
  toValue: string
  measure(stage: RolloutStage): Promise<StageMeasurement | null>
  now?: () => Date
}): Promise<RolloutDecision> {
  const { plan, fromValue, toValue } = input
  validateRolloutPlan(plan)
  const fromStage = stageOf(plan, fromValue)
  const toStage = stageOf(plan, toValue)
  const widens = rolloutWidens(fromValue, toValue)
  const record = (reasons: string[], measured: StageMeasurement | null): RolloutDecision => ({
    rollout: plan.name,
    variable: plan.variable,
    from: { value: fromValue, stage: fromStage?.name ?? null },
    to: { value: toValue, stage: toStage?.name ?? null },
    widens,
    decision: reasons.length ? 'refused' : 'allowed',
    reasons,
    measured,
    at: (input.now?.() ?? new Date()).toISOString(),
  })
  if (!widens) return record([], null)
  if (!toStage) return record([`${toValue} is not a declared stage of ${plan.name}`], null)
  const target = plan.stages.indexOf(toStage)
  // An empty list admits nobody, so the first stage is the only widening it may take without numbers.
  if (!fromStage) {
    const empty = !normalizeRolloutValue(fromValue)
    return record(empty && target === 0 ? [] : [`the current value ${fromValue || '(empty)'} is not a declared stage of ${plan.name}`], null)
  }
  const current = plan.stages.indexOf(fromStage)
  if (target > current + 1) {
    return record([`${toStage.name} skips ${plan.stages.slice(current + 1, target).map(stage => stage.name).join(', ')}`], null)
  }
  let measured: StageMeasurement | null
  try {
    measured = await input.measure(fromStage)
  } catch (error) {
    return record([`measuring stage ${fromStage.name} failed: ${error instanceof Error ? error.message : String(error)}`], null)
  }
  return record(killLineBreaches(fromStage, measured), measured)
}
