/**
 * The conformance report: which launch invariants an app holds.
 *
 * `agent-app-invariants` runs the app's invariant tests with
 * `AGENT_APP_INVARIANTS_RESULTS` set, reads the verdicts they recorded, and
 * checks what it can see without the app's code: the crons each wrangler
 * environment configures, and whether the app has a D1 binding at all. An
 * invariant passes when at least one verdict was recorded for it and every
 * recorded verdict passed. Not applicable is accepted only where the
 * deployment shows it: no configured crons, or no D1 binding.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAUNCH_INVARIANTS, type InvariantVerdict, type LaunchInvariantId } from './catalog.js'
import { parseWranglerCrons } from './schedule.js'

/** `launch-invariants.config.mjs` (or `.json`) at the app root. */
export interface LaunchInvariantsConfig {
  /** The app's name in the report. */
  product: string
  /** The command that runs the app's invariant tests, e.g. `pnpm exec vitest run tests/launch-invariants.test.ts`. */
  test: string
  /** Wrangler configs, relative to the app root. Default: the first of wrangler.toml, wrangler.jsonc, wrangler.json. */
  wrangler?: readonly string[]
  /** Invariants the deployment shows do not apply, with the reason. */
  notApplicable?: Partial<Record<LaunchInvariantId, string>>
}

/** What the deployment declares, read from its wrangler configs. */
export interface DeploymentFacts {
  wranglerFiles: string[]
  configuredCrons: string[]
  hasD1: boolean
}

export type InvariantStatus = 'pass' | 'fail' | 'known-fail' | 'not-applicable'

export interface InvariantReport {
  id: LaunchInvariantId
  title: string
  status: InvariantStatus
  /** Why it failed or does not apply; on a pass, what was proven. */
  lines: string[]
  verdicts: number
}

export interface ConformanceReport {
  product: string
  pass: boolean
  passed: number
  total: number
  testExitCode: number | null
  /** Invariants failing with a known-failing marker: not holding, but not failing the run. */
  knownFailing: number
  invariants: InvariantReport[]
  facts: DeploymentFacts
}

/** Read the crons and D1 bindings the app's wrangler configs declare. */
export function readDeploymentFacts(appDir: string, files?: readonly string[]): DeploymentFacts {
  const candidates = files ?? ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'].filter((file) => existsSync(join(appDir, file))).slice(0, 1)
  const crons = new Set<string>()
  let hasD1 = false
  for (const file of candidates) {
    const source = readFileSync(join(appDir, file), 'utf8')
    const json = /\.jsonc?$/.test(file)
    const parsed = parseWranglerCrons(source, json ? 'json' : 'toml')
    for (const cron of [...parsed.top, ...Object.values(parsed.envs).flat()]) crons.add(cron)
    if (json ? /"d1_databases"\s*:\s*\[\s*\{/.test(source) : /^\s*\[\[(?:env\.[^.\]]+\.)?d1_databases\]\]/m.test(source)) hasD1 = true
  }
  return { wranglerFiles: [...candidates], configuredCrons: [...crons], hasD1 }
}

const NOT_APPLICABLE_WHEN: Partial<Record<LaunchInvariantId, { holds: (facts: DeploymentFacts) => boolean; condition: string }>> = {
  'isolated-jobs': { holds: (facts) => facts.configuredCrons.length === 0, condition: 'no configured crons' },
  'memory-budget': { holds: (facts) => facts.configuredCrons.length === 0, condition: 'no configured crons' },
  'bounded-reads': { holds: (facts) => !facts.hasD1, condition: 'no D1 binding' },
  'auth-survives-d1-stall': { holds: (facts) => !facts.hasD1, condition: 'no D1 binding' },
}

/** Parse the results file the invariant tests appended to. */
export function readVerdicts(source: string): InvariantVerdict[] {
  return source.split('\n').filter((line) => line.trim()).flatMap((line) => {
    try {
      return [JSON.parse(line) as InvariantVerdict]
    } catch {
      return []
    }
  })
}

/** Judge each invariant from the recorded verdicts and the deployment facts. */
export function buildConformanceReport(input: {
  config: LaunchInvariantsConfig
  facts: DeploymentFacts
  verdicts: readonly InvariantVerdict[]
  testExitCode: number | null
}): ConformanceReport {
  const { config, facts } = input
  const invariants = LAUNCH_INVARIANTS.map((invariant): InvariantReport => {
    const verdicts = input.verdicts.filter((verdict) => verdict.invariant === invariant.id)
    const reason = config.notApplicable?.[invariant.id]
    if (reason !== undefined) {
      const rule = NOT_APPLICABLE_WHEN[invariant.id]
      if (rule?.holds(facts)) return { id: invariant.id, title: invariant.title, status: 'not-applicable', lines: [`${reason} (verified: ${rule.condition})`], verdicts: verdicts.length }
      return {
        id: invariant.id,
        title: invariant.title,
        status: 'fail',
        lines: [rule
          ? `declared not applicable ("${reason}"), but the deployment does not show ${rule.condition}`
          : `declared not applicable ("${reason}"), but this invariant applies to every agent app`],
        verdicts: verdicts.length,
      }
    }
    if (verdicts.length === 0) {
      return { id: invariant.id, title: invariant.title, status: 'fail', lines: [`no check recorded a verdict; ${invariant.rule}`], verdicts: 0 }
    }
    const failed = verdicts.filter((verdict) => !verdict.pass)
    const unknown = failed.filter((verdict) => !verdict.knownFailing)
    if (failed.length > 0 && unknown.length === 0) {
      const reasons = [...new Set(failed.map((verdict) => verdict.knownFailing!))]
      return {
        id: invariant.id,
        title: invariant.title,
        status: 'known-fail',
        lines: [...reasons.map((reason) => `known failing: ${reason}`), ...failed.flatMap((verdict) => verdict.details.map((detail) => `${verdict.subject}: ${detail}`))],
        verdicts: verdicts.length,
      }
    }
    const lines = failed.length
      ? failed.flatMap((verdict) => verdict.details.map((detail) => `${verdict.subject}: ${detail}`))
      : verdicts.map((verdict) => `${verdict.subject}: ${verdict.details[0] ?? 'passed'}`)
    if (invariant.id === 'isolated-jobs' && failed.length === 0) {
      const checked = new Set(verdicts.flatMap((verdict) => (verdict.data?.configuredCrons as string[] | undefined) ?? []))
      const unchecked = facts.configuredCrons.filter((cron) => !checked.has(cron))
      if (unchecked.length) {
        return {
          id: invariant.id,
          title: invariant.title,
          status: 'fail',
          lines: [`the check did not read every configured cron: ${unchecked.map((cron) => `"${cron}"`).join(', ')} (from ${facts.wranglerFiles.join(', ')})`],
          verdicts: verdicts.length,
        }
      }
    }
    return { id: invariant.id, title: invariant.title, status: failed.length ? 'fail' : 'pass', lines, verdicts: verdicts.length }
  })
  const passed = invariants.filter((invariant) => invariant.status === 'pass' || invariant.status === 'not-applicable').length
  const knownFailing = invariants.filter((invariant) => invariant.status === 'known-fail').length
  return {
    product: config.product,
    pass: passed + knownFailing === invariants.length && input.testExitCode === 0,
    passed,
    total: invariants.length,
    testExitCode: input.testExitCode,
    knownFailing,
    invariants,
    facts,
  }
}

/** The report as the CLI prints it. */
export function formatConformanceReport(report: ConformanceReport): string {
  const mark: Record<InvariantStatus, string> = { pass: 'PASS', fail: 'FAIL', 'known-fail': 'KNOWN', 'not-applicable': 'N/A ' }
  const lines = [`launch invariants — ${report.product}: ${report.passed} of ${report.total} hold${report.knownFailing ? `, ${report.knownFailing} known failing` : ''}`]
  for (const invariant of report.invariants) {
    lines.push(`  ${mark[invariant.status]} ${invariant.id} — ${invariant.title}`)
    const shown = invariant.status === 'fail' || invariant.status === 'known-fail' ? invariant.lines : invariant.lines.slice(0, 3)
    for (const line of shown) lines.push(`         ${line}`)
    if (invariant.status !== 'fail' && invariant.lines.length > shown.length) lines.push(`         … ${invariant.lines.length - shown.length} more`)
  }
  if (report.testExitCode !== 0) lines.push(`  the invariant test command exited ${report.testExitCode ?? 'by signal'}`)
  lines.push(report.passed === report.total && report.pass
    ? 'RESULT: launch-grade'
    : report.pass ? `RESULT: not launch-grade yet; ${report.knownFailing} known failing, no regressions` : 'RESULT: not launch-grade')
  return lines.join('\n')
}
