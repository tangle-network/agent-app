import type { SignoffReport, SignoffStepResult } from './types'

/**
 * The proof a human reads before merging.
 *
 * A sign-off gate is only worth the CI it replaces if its output answers the
 * question CI's green tick answers and the ones it does not: what bytes were
 * verified, in what environment, under which suite orders, and how to reproduce
 * it. So the report leads with the verdict, states the subject (commit + patch
 * digest) and the environment (clean tree, store cache state), lists every step
 * with its seeds, and ends with the exact command that runs it again.
 *
 * Failure output is printed in full, under the step's name. Naming the step is
 * the difference between "CI is red" and a fix.
 */

const BAR = '─'.repeat(72)

function ms(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

function statusMark(status: SignoffStepResult['status']): string {
  switch (status) {
    case 'passed': return 'ok  '
    case 'failed': return 'FAIL'
    case 'cancelled': return 'kill'
    case 'blocked': return 'blkd'
    case 'skipped': return '--  '
  }
}

function seedList(step: SignoffStepResult): string {
  const seeds = step.attempts.map((attempt) => attempt.seed).filter((seed): seed is number => seed !== null)
  return seeds.length === 0 ? '' : `  seeds ${seeds.join(', ')}`
}

/** Concurrency actually achieved, measured from the step windows rather than
 *  asserted from the config. A claimed speedup nobody measured is a wish. */
export function peakConcurrency(steps: readonly SignoffStepResult[]): number {
  const events: { at: number; delta: number }[] = []
  for (const step of steps) {
    if (step.startedAtMs === null || step.finishedAtMs === null) continue
    events.push({ at: step.startedAtMs, delta: 1 }, { at: step.finishedAtMs, delta: -1 })
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let current = 0
  let peak = 0
  for (const event of events) {
    current += event.delta
    peak = Math.max(peak, current)
  }
  return peak
}

export function formatSignoffReport(report: SignoffReport): string {
  const lines: string[] = []
  const verdict = report.ok ? 'SIGN-OFF PASSED' : 'SIGN-OFF FAILED'
  lines.push(BAR, `${verdict} — ${report.repo.branch} @ ${report.repo.head.slice(0, 12)}`, BAR, '')

  lines.push('subject')
  lines.push(`  repo        ${report.repo.root}`)
  lines.push(`  source      ${report.repo.source}${report.repo.dirty ? ' (working tree carries uncommitted work)' : ''}`)
  if (report.repo.diffSha256) lines.push(`  patch       sha256:${report.repo.diffSha256.slice(0, 16)}`)
  if (report.repo.untrackedFiles.length > 0) {
    lines.push(`  untracked   ${report.repo.untrackedFiles.length} file(s) copied in`)
  }
  if (report.repo.carriedFiles.length > 0) lines.push(`  carried     ${report.repo.carriedFiles.join(', ')}`)
  lines.push('')

  lines.push('environment')
  lines.push(`  clean tree  ${report.workspace}${report.workspaceRetained ? ' (retained)' : ' (removed)'}`)
  lines.push(`  install     ${report.install.command}`)
  lines.push(
    `  store       ${report.install.cacheHit ? 'warm' : 'cold'} — ${report.install.cacheKey.slice(0, 16)} ` +
      `(keyed on ${report.install.keyedOn.length} manifest file(s))`,
  )
  lines.push(
    `  host        ${report.host.node} · ${report.host.packageManager} · ${report.host.cpus} cpus` +
      (report.host.nodePinned === null
        ? ' · node UNPINNED by this repo'
        : ` · pinned ${report.host.nodePinned} (${report.host.nodePinSource})`),
  )
  lines.push(
    `  config      ${report.configOrigin.kind === 'derived'
      ? `derived from scripts: ${report.configOrigin.scripts.join(', ')}`
      : report.configOrigin.path}`,
  )
  lines.push('')

  const width = Math.max(...report.steps.map((step) => step.name.length), 'install'.length)
  lines.push('steps')
  lines.push(
    `  ${report.install.exitCode === 0 ? 'ok  ' : 'FAIL'} ${'install'.padEnd(width)}  ${ms(report.install.durationMs).padStart(8)}`,
  )
  for (const step of report.steps) {
    const window =
      step.startedAtMs === null || step.finishedAtMs === null
        ? ''
        : `  [${ms(step.startedAtMs)} → ${ms(step.finishedAtMs)}]`
    lines.push(
      `  ${statusMark(step.status)} ${step.name.padEnd(width)}  ${ms(step.durationMs).padStart(8)}` +
        `  ${step.attempts.length} run(s)${window}${seedList(step)}`,
    )
  }
  lines.push('')

  const peak = peakConcurrency(report.steps)
  const saved = report.serialMs - report.wallClockMs
  lines.push('timing')
  lines.push(`  wall clock  ${ms(report.wallClockMs)}`)
  lines.push(`  serial sum  ${ms(report.serialMs)} (install + every step, one after another)`)
  lines.push(
    `  parallel    peak ${peak} step(s) at once — ` +
      (saved > 0 ? `${ms(saved)} saved, ${(report.serialMs / report.wallClockMs).toFixed(2)}x` : 'no overlap available'),
  )
  lines.push('')

  const failures = report.steps.filter((step) => step.status === 'failed' || step.status === 'cancelled')
  if (report.install.exitCode !== 0) {
    lines.push(BAR, 'install FAILED — no step could run', BAR, report.install.output.trimEnd(), '')
  }
  for (const step of failures) {
    const last = step.attempts[step.attempts.length - 1]
    lines.push(BAR)
    lines.push(`${step.status === 'cancelled' ? 'CANCELLED' : 'FAILED'}: ${step.name}`)
    if (last) {
      lines.push(`  command   ${last.command}`)
      lines.push(`  exit      ${last.exitCode}${last.signal ? ` (${last.signal})` : ''}${last.timedOut ? ' — TIMED OUT' : ''}`)
      if (last.seed !== null) {
        lines.push(`  seed      ${last.seed} — replay this order alone with the same seed`)
      }
      lines.push(BAR, last.output.trimEnd(), '')
    }
  }

  const blocked = report.steps.filter((step) => step.status === 'blocked' || step.status === 'skipped')
  if (blocked.length > 0) {
    lines.push(`not judged: ${blocked.map((step) => `${step.name} (${step.status})`).join(', ')}`)
    lines.push('')
  }

  lines.push(`reproduce: ${report.reproduce}`)
  return lines.join('\n')
}

/** One line for a commit message, a PR comment, or a chat handoff. */
export function formatSignoffLine(report: SignoffReport): string {
  const passed = report.steps.filter((step) => step.status === 'passed').length
  return (
    `${report.ok ? 'signoff PASS' : 'signoff FAIL'} ${report.repo.head.slice(0, 12)} — ` +
    `${passed}/${report.steps.length} steps, ${ms(report.wallClockMs)} wall ` +
    `(${ms(report.serialMs)} serial), seed ${report.seedBase}, ` +
    `${report.install.cacheHit ? 'warm' : 'cold'} store, clean install`
  )
}
