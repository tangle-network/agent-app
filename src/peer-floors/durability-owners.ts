/**
 * DURABILITY OWNERS — products must not grow their own turn durability.
 *
 * Agent App owns the turn event buffer and status rows, running-turn claims,
 * detached-turn crash recovery and the session-event attach that replays an
 * execution. A product that writes those tables, opens its own session-event
 * replay loop or mints a follow-up execution id forks recovery semantics the
 * shared owner tests, and the fork drifts: four copies of the plan follow-up
 * attach had three different execution identities before they were merged.
 *
 * The scan reads product source (not tests, migrations or build output). A
 * line that must stay product-local carries `agent-app-durability-owner:
 * <reason>` on it or within the three lines above it, so every exception is
 * named where a reviewer sees it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

interface DurabilityRule {
  readonly id: string
  readonly pattern: RegExp
  readonly owner: string
}

const RULES: readonly DurabilityRule[] = [
  {
    id: 'turn-tables',
    pattern: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`"']?(?:turn_status|turn_events)\b/i,
    owner: 'TurnEventStore from @tangle-network/agent-app/stream owns turn_status and turn_events '
      + '(setStatus, resetEvents, deleteTurn, pruneTerminalTurns); createD1PlanFollowUpGate owns follow-up claims.',
  },
  {
    id: 'session-replay',
    pattern: /\.session\([^)]*\)\s*\.events\(/,
    owner: 'Agent App owns session-event attach and replay: streamPlanFollowUpEvents or the sandbox chat producer '
      + 'from @tangle-network/agent-app/chat-routes.',
  },
  {
    id: 'execution-identity',
    pattern: /['"`]plan-followup-/,
    owner: 'planFollowUpExecutionId from @tangle-network/agent-app/chat-routes matches the Sidecar byte for byte.',
  },
]

const WAIVER = /agent-app-durability-owner:\s*\S/
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const TEST_FILE = /(?:\.|-)(?:test|spec|stories)\.[cm]?[jt]sx?$/
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.wrangler', '.react-router', '.next',
  '.turbo', '.cache', '.worktrees', 'storybook-static', 'test', 'tests', '__tests__', 'fixtures',
  'fixture_modules', 'migrations', 'drizzle', 'scripts', 'e2e', 'evals',
])

/** One product-local durability primitive the shared owner already provides. */
export interface DurabilityOwnerViolation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly owner: string
  readonly text: string
}

/** Result of one durability-owner scan. */
export interface DurabilityOwnerReport {
  readonly ok: boolean
  readonly scannedFiles: number
  readonly waived: number
  readonly violations: readonly DurabilityOwnerViolation[]
}

function collect(dir: string, repoDir: string, exclude: readonly string[], out: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = relative(repoDir, full).split(sep).join('/')
    if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, repoDir, exclude, out)
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full)
    }
  }
}

/** Scan a product checkout for durability primitives Agent App owns. */
export function checkDurabilityOwners(options: {
  repoDir: string
  exclude?: readonly string[]
}): DurabilityOwnerReport {
  const files: string[] = []
  collect(options.repoDir, options.repoDir, options.exclude ?? [], files)
  const violations: DurabilityOwnerViolation[] = []
  let waived = 0
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, index) => {
      const rule = RULES.find((candidate) => candidate.pattern.test(text))
      if (!rule) return
      if (lines.slice(Math.max(0, index - 3), index + 1).some((line) => WAIVER.test(line))) {
        waived += 1
        return
      }
      violations.push({
        file: relative(options.repoDir, file).split(sep).join('/'),
        line: index + 1,
        rule: rule.id,
        owner: rule.owner,
        text: text.trim(),
      })
    })
  }
  return { ok: violations.length === 0, scannedFiles: files.length, waived, violations }
}

/** Human report for the peer-check CLI. */
export function formatDurabilityOwnerReport(report: DurabilityOwnerReport): string {
  if (report.ok) {
    return `durability owners: ${report.scannedFiles} source files use the shared turn durability`
      + (report.waived ? ` (${report.waived} named exceptions)` : '')
  }
  return [
    `DURABILITY OWNER VIOLATED: ${report.violations.length} product-local durability primitive(s).`,
    ...report.violations.map((violation) =>
      `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.text}\n    use: ${violation.owner}`),
    'Move the behavior to the shared owner, or name a product-only reason with `agent-app-durability-owner: <reason>`.',
  ].join('\n')
}
