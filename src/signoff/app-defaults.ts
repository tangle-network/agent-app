import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { LAUNCH_BUDGETS } from '../launch-invariants/catalog'
import { trackedFiles, trackedWorkerConfigs } from './worker-defaults'

/**
 * The defaults an agent app inherits from agent-app, and whether this app has them.
 *
 * Each proven improvement ships as a default inside agent-app, so an app gets it by construction. This report reads
 * an app's checkout and says which defaults it has, which it turned off, and which it replaced with a local copy.
 * It is a report: it fails only on an explicit opt-out that gives no reason, so a gap stays visible without
 * blocking a merge, and an exemption is a line in the app's `signoff.config.mjs` with the reason beside it.
 *
 * The rows are the outcomes Drew named on 2026-10-19: the turn trace on every turn with `first_text_ms`, the shared
 * prewarm route, Worker placement beside the D1 primary, limit alarms wired in the server entry, and the Worker
 * upload size against Cloudflare's limit. A row is read from the source, the Wrangler config and the lockfile; it
 * never runs the app.
 */

/** The name the built-in step reports under; a repo cannot declare a step with it. */
export const APP_DEFAULTS_STEP = 'agent-app defaults'

/** Defaults an app may turn off with a reason. */
export const EXEMPTIBLE_DEFAULTS = ['turn-trace', 'first-text', 'prewarm', 'placement', 'limit-alarms'] as const
type ExemptibleDefault = (typeof EXEMPTIBLE_DEFAULTS)[number]

/** An app's declared opt-outs: the default and why. An empty reason is a configuration error. */
export type AppDefaultsExemptions = Readonly<Partial<Record<ExemptibleDefault, string>>>

/**
 * The first agent-app release that carries each outcome. An app pinned below one cannot have it, whatever its source says.
 * Add a line when a new default ships.
 */
const AGENT_APP_OUTCOME_FLOORS = [
  { id: 'turn-trace', label: 'turn trace', since: '0.60.199' },
  { id: 'first-text', label: 'first text', since: '0.60.203' },
] as const

type DefaultStatus = 'ok' | 'gap' | 'unknown' | 'exempt' | 'opted-out' | 'na'

interface DefaultRow {
  readonly id: 'pin' | 'turn-trace' | 'first-text' | 'prewarm' | 'placement' | 'tool-count' | 'limit-alarms' | 'worker-bundle'
  readonly label: string
  readonly status: DefaultStatus
  readonly detail: string
}

interface AppDefaultsReport {
  /** The package name. */
  readonly app: string
  /** The package directory relative to the repo root. */
  readonly dir: string
  /** The `@tangle-network/agent-app` version the package pins, or null when it is not a plain version. */
  readonly pin: string | null
  readonly rows: readonly DefaultRow[]
  /** Opt-outs that give no reason. These alone fail the step. */
  readonly findings: readonly string[]
}

export interface AppDefaultsResult {
  readonly apps: readonly AppDefaultsReport[]
  readonly findings: readonly string[]
}

export interface AppDefaultsOptions {
  /** Declared opt-outs per package name. Applied to every app when keyed by `*`. */
  readonly exemptions?: AppDefaultsExemptions
  /** Measure the Worker upload with the app's own Wrangler (default true). Needs a built app. */
  readonly measureBundle?: boolean
  /** The last turn trace Intelligence accepted per Intelligence project; see {@link readLastTurnExport}. */
  readonly exports?: ReadonlyMap<string, LastTurnExport | null>
}

/** The newest `agent_app.turn` root span Intelligence holds for a project. */
interface LastTurnExport {
  readonly at: number
  readonly traceId: string
  readonly firstTextMs?: number
}

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|build|\.wrangler|tests?|__tests__|e2e|scripts|proof|journeys?|evals?|docs|examples|stories|\.storybook)\/|\.(?:test|spec|stories|e2e|bench)\.[cm]?[jt]sx?$|\.d\.ts$/
const MAX_SOURCE_BYTES = 400 * 1024

interface SourceFile {
  readonly path: string
  readonly text: string
}

interface AppPackage {
  readonly name: string
  /** Directory relative to the repo root, `.` for the root. */
  readonly dir: string
  readonly spec: string
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Packages in the repo that depend on `@tangle-network/agent-app`. agent-app itself is not one. */
function findAppPackages(repoRoot: string, tracked: readonly string[]): AppPackage[] {
  const packages: AppPackage[] = []
  for (const path of tracked) {
    if (posix.basename(path) !== 'package.json' || /(?:^|\/)node_modules\//.test(path)) continue
    const pkg = readJson(join(repoRoot, path)) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    } | null
    if (!pkg || pkg.name === '@tangle-network/agent-app') continue
    const spec = pkg.dependencies?.['@tangle-network/agent-app'] ?? pkg.devDependencies?.['@tangle-network/agent-app'] ?? pkg.peerDependencies?.['@tangle-network/agent-app']
    if (spec === undefined) continue
    packages.push({ name: pkg.name ?? posix.dirname(path), dir: posix.dirname(path), spec })
  }
  return packages
}

function underDir(path: string, dir: string): boolean {
  return dir === '.' || path === dir || path.startsWith(`${dir}/`)
}

function readSources(repoRoot: string, tracked: readonly string[], dir: string, others: readonly string[]): SourceFile[] {
  const files: SourceFile[] = []
  for (const path of tracked) {
    if (!underDir(path, dir) || !SOURCE_EXTENSIONS.test(path) || NOT_SOURCE.test(path)) continue
    // A nested package (a monorepo's other app) is not this app's source.
    if (others.some((other) => other !== dir && other !== '.' && underDir(path, other) && underDir(other, dir))) continue
    const abs = join(repoRoot, path)
    try {
      if (statSync(abs).size > MAX_SOURCE_BYTES) continue
      files.push({ path, text: readFileSync(abs, 'utf8') })
    } catch {
      /* a tracked file that is gone from the tree is not a source */
    }
  }
  return files
}

function versionTuple(spec: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (!match || /^(?:workspace|file|link|portal|git|github|http|catalog):/.test(spec)) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(have: readonly number[], floor: string): boolean {
  const want = versionTuple(floor) as [number, number, number]
  for (let index = 0; index < 3; index += 1) {
    if ((have[index] as number) !== want[index]) return (have[index] as number) > (want[index] as number)
  }
  return true
}

function filesMatching(sources: readonly SourceFile[], pattern: RegExp): SourceFile[] {
  return sources.filter((file) => pattern.test(file.text))
}

/** The text of a call's argument list from its opening parenthesis, balanced and capped. */
function callArguments(text: string, openIndex: number): string {
  let depth = 0
  for (let index = openIndex; index < Math.min(text.length, openIndex + 1200); index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return text.slice(openIndex, index + 1)
  }
  return text.slice(openIndex, openIndex + 1200)
}

interface SinkCall {
  readonly file: string
  readonly args: string
  readonly project: string | null
}

function sinkCalls(sources: readonly SourceFile[]): SinkCall[] {
  const calls: SinkCall[] = []
  for (const file of sources) {
    for (const match of file.text.matchAll(/createIntelligenceTurnTraceSink\s*\(/g)) {
      const args = callArguments(file.text, match.index + match[0].length - 1)
      const direct = /\bproject\s*:\s*['"`]([^'"`]+)['"`]/.exec(args)
      const named = /\bproject\s*:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/.exec(args) ?? /\bproject\b\s*[,}]/.exec(args)
      const identifier = named?.[1] ?? (named ? 'project' : undefined)
      const constant = identifier
        ? new RegExp(`(?:const|let)\\s+${identifier}\\s*(?::\\s*string\\s*)?=\\s*['"\`]([^'"\`]+)['"\`]`).exec(file.text)
        : null
      calls.push({ file: file.path, args, project: direct?.[1] ?? constant?.[1] ?? null })
    }
  }
  return calls
}

function pinRow(pin: string | null, spec: string): DefaultRow {
  const tuple = pin === null ? null : versionTuple(pin)
  if (pin === null || tuple === null) {
    return { id: 'pin', label: 'agent-app pin', status: 'unknown', detail: `"${spec}" is not a plain version; the floors cannot be compared` }
  }
  const below = AGENT_APP_OUTCOME_FLOORS.filter((floor) => !atLeast(tuple, floor.since))
  const floors = AGENT_APP_OUTCOME_FLOORS.map((floor) => `${floor.label} ${floor.since}`).join(', ')
  return below.length === 0
    ? { id: 'pin', label: 'agent-app pin', status: 'ok', detail: `${pin} (floors: ${floors})` }
    : { id: 'pin', label: 'agent-app pin', status: 'gap', detail: `${pin} is below the ${below.map((floor) => `${floor.label} floor ${floor.since}`).join(' and the ')}` }
}

function withExemption(
  row: DefaultRow,
  id: ExemptibleDefault,
  exemptions: AppDefaultsExemptions,
  optedOut: string | null,
): { row: DefaultRow; finding: string | null } {
  const reason = exemptions[id]
  if (optedOut !== null) {
    return reason
      ? { row: { ...row, status: 'exempt', detail: `${optedOut}; exempt: ${reason}` }, finding: null }
      : { row: { ...row, status: 'opted-out', detail: optedOut }, finding: `${row.label}: ${optedOut}, with no reason in signoff.config.mjs agentApp.exemptions.${id}` }
  }
  if (row.status !== 'ok' && row.status !== 'na' && reason) {
    return { row: { ...row, status: 'exempt', detail: `${row.detail}; exempt: ${reason}` }, finding: null }
  }
  return { row, finding: null }
}

function turnTraceRow(sources: readonly SourceFile[], calls: readonly SinkCall[], exports: AppDefaultsOptions['exports']): { row: DefaultRow; optedOut: string | null } {
  const optOut = filesMatching(sources, /\bturnTrace\s*:\s*false\b/)[0]
  if (optOut) return { row: { id: 'turn-trace', label: 'turn trace', status: 'gap', detail: '' }, optedOut: `turnTrace: false in ${optOut.path}` }
  const customSink = filesMatching(sources, /\bturnTrace\s*:\s*\{/)
  if (calls.length === 0 && customSink.length === 0) {
    return { row: { id: 'turn-trace', label: 'turn trace', status: 'gap', detail: 'no turn trace sink; createChatTurnRoutes gets no turnTrace' }, optedOut: null }
  }
  const badKey = calls.find((call) => /\bapiKey\s*:[^,}]*\bTANGLE_API_KEY\b/.test(call.args))
  if (badKey) {
    return { row: { id: 'turn-trace', label: 'turn trace', status: 'gap', detail: `exports with TANGLE_API_KEY in ${badKey.file}; the ingest answers 401 (Legal #468): drop apiKey, the sink reads SANDBOX_API_KEY` }, optedOut: null }
  }
  const project = calls.find((call) => call.project)?.project ?? null
  const last = project === null ? undefined : exports?.get(project)
  if (last === null) {
    return { row: { id: 'turn-trace', label: 'turn trace', status: 'gap', detail: `sink wired (${project}); Intelligence holds no turn from the last 30 days` }, optedOut: null }
  }
  const where = calls[0]?.file ?? customSink[0]?.path ?? ''
  const exported = last ? `; last export accepted ${new Date(last.at).toISOString().slice(0, 16)}Z` : '; last export not checked'
  return { row: { id: 'turn-trace', label: 'turn trace', status: 'ok', detail: `sink wired in ${where}${project ? ` (${project})` : ''}${exported}` }, optedOut: null }
}

function firstTextRow(pin: string | null, sources: readonly SourceFile[], traceWired: boolean, calls: readonly SinkCall[], exports: AppDefaultsOptions['exports']): DefaultRow {
  const floor = AGENT_APP_OUTCOME_FLOORS.find((entry) => entry.id === 'first-text')?.since ?? ''
  const tuple = pin === null ? null : versionTuple(pin)
  const marks = filesMatching(sources, /\.markFirstText\s*\(/).length > 0
  const routes = filesMatching(sources, /\bcreateChatTurnRoutes\s*[(<]/).length > 0
  if (!traceWired) return { id: 'first-text', label: 'first text', status: 'gap', detail: 'needs the turn trace' }
  if (tuple !== null && !atLeast(tuple, floor)) return { id: 'first-text', label: 'first text', status: 'gap', detail: `agent-app ${pin} does not mark first text; ${floor} does` }
  if (!routes && !marks) return { id: 'first-text', label: 'first text', status: 'gap', detail: 'the turn owner does not call trace.markFirstText() and the app does not use createChatTurnRoutes' }
  const project = calls.find((call) => call.project)?.project ?? null
  const last = project === null ? undefined : exports?.get(project)
  const observed = last?.firstTextMs === undefined ? '' : `; last turn first_text_ms ${Math.round(last.firstTextMs)}`
  if (last && last.firstTextMs === undefined) return { id: 'first-text', label: 'first text', status: 'gap', detail: 'the last exported turn has no tangle.turn.first_text_ms' }
  return { id: 'first-text', label: 'first text', status: 'ok', detail: `${routes ? 'createChatTurnRoutes marks it' : 'the turn owner marks it'}${observed}` }
}

function prewarmRow(sources: readonly SourceFile[]): DefaultRow {
  const usesBox = filesMatching(sources, /@tangle-network\/agent-app\/sandbox|\bensureWorkspaceSandbox\b/).length > 0
  if (!usesBox) return { id: 'prewarm', label: 'prewarm route', status: 'na', detail: 'the app opens no workspace box' }
  const shared = filesMatching(sources, /\bcreateWorkspacePrewarmRoute\b/)[0]
  if (shared) return { id: 'prewarm', label: 'prewarm route', status: 'ok', detail: `shared route in ${shared.path}` }
  const local = sources.find((file) => /prewarm/i.test(file.path) || /['"`/]prewarm['"`/]/.test(file.text))
  return local
    ? { id: 'prewarm', label: 'prewarm route', status: 'gap', detail: `local copy in ${local.path}; mount createWorkspacePrewarmRoute` }
    : { id: 'prewarm', label: 'prewarm route', status: 'gap', detail: 'no prewarm route; the first send waits for the box' }
}

function placementRow(configs: readonly SourceFile[]): DefaultRow {
  const pinned = configs.find((file) => /^\s*\[placement\]\s*$[\s\S]{0,300}?^\s*(?:region|host|hostname)\s*=/m.test(file.text) || /"placement"\s*:\s*\{[^}]*"(?:region|host|hostname)"/.test(file.text))
  if (pinned) return { id: 'placement', label: 'placement', status: 'ok', detail: `pinned in ${pinned.path}` }
  if (configs.length === 0) return { id: 'placement', label: 'placement', status: 'na', detail: 'no Wrangler config' }
  const smart = configs.some((file) => /^\s*\[placement\]/m.test(file.text) || /"placement"/.test(file.text))
  return {
    id: 'placement',
    label: 'placement',
    status: 'gap',
    detail: smart
      ? 'a [placement] without a region or host is smart placement, which does not pin; unmeasured against the D1 primary'
      : 'no [placement]; unmeasured against the D1 primary. Pin it beside D1 or declare an exemption with the reason',
  }
}

function limitAlarmsRow(sources: readonly SourceFile[]): DefaultRow {
  const wired = filesMatching(sources, /\bwithD1LimitAlarms\s*\(/)
  const copies = filesMatching(sources, /\bcreateLimitAlarms\s*\(/)
  const product = filesMatching(sources, /\bcreateProductLimitAlarms\s*\(/)
  if (wired.length === 0) {
    return {
      id: 'limit-alarms',
      label: 'limit alarms',
      status: 'gap',
      detail: copies.length + product.length > 0
        ? `alarms are built in ${(copies[0] ?? product[0])?.path} but nothing wraps the D1 binding with withD1LimitAlarms in the server`
        : 'no limit alarms',
    }
  }
  if (copies.length > 0) {
    return { id: 'limit-alarms', label: 'limit alarms', status: 'gap', detail: `wired in ${wired[0]?.path}; ${copies[0]?.path} keeps a local copy of the budgets: use createProductLimitAlarms with overrides` }
  }
  return { id: 'limit-alarms', label: 'limit alarms', status: 'ok', detail: `wired in ${wired[0]?.path}` }
}

/** `Total Upload: 31059.18 KiB / gzip: 9659.00 KiB` from `wrangler deploy --dry-run`. */
function parseWranglerUpload(output: string): { rawKiB: number; gzipKiB: number } | null {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/.exec(clean)
  return match ? { rawKiB: Number(match[1]), gzipKiB: Number(match[2]) } : null
}

function wranglerBinary(repoRoot: string, dir: string): string | null {
  for (const base of [join(repoRoot, dir), repoRoot]) {
    const bin = join(base, 'node_modules', '.bin', 'wrangler')
    if (existsSync(bin)) return bin
  }
  return null
}

function bundleRow(repoRoot: string, dir: string, configs: readonly SourceFile[], measure: boolean): DefaultRow {
  const label = 'Worker upload'
  if (configs.length === 0) return { id: 'worker-bundle', label, status: 'na', detail: 'no Wrangler config' }
  if (!measure) return { id: 'worker-bundle', label, status: 'unknown', detail: 'not measured' }
  const bin = wranglerBinary(repoRoot, dir)
  if (!bin) return { id: 'worker-bundle', label, status: 'unknown', detail: 'wrangler is not installed; install, build, then measure' }
  const outDir = mkdtempSync(join(tmpdir(), 'agent-app-upload-'))
  try {
    const run = spawnSync(bin, ['deploy', '--dry-run', '--env=', '--outdir', outDir], {
      cwd: join(repoRoot, dir),
      encoding: 'utf8',
      timeout: 5 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    })
    const upload = parseWranglerUpload(`${run.stdout}\n${run.stderr}`)
    if (!upload) {
      const reason = `${run.stderr}${run.stdout}`.split('\n').map((line) => line.trim()).find((line) => /error|not found|no such/i.test(line)) ?? `wrangler exited ${run.status}`
      return { id: 'worker-bundle', label, status: 'unknown', detail: `unmeasured (build first): ${reason.slice(0, 160)}` }
    }
    const limit = LAUNCH_BUDGETS.workerUploadGzipKiB
    const share = upload.gzipKiB / limit
    return {
      id: 'worker-bundle',
      label,
      status: share >= LAUNCH_BUDGETS.alarmRatio ? 'gap' : 'ok',
      detail: `${Math.round(upload.gzipKiB)} KiB gzip of ${limit} KiB (${Math.round(share * 100)}%); ${Math.round(upload.rawKiB)} KiB raw of ${LAUNCH_BUDGETS.workerUploadRawKiB} KiB`,
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

function toolCountRow(): DefaultRow {
  return { id: 'tool-count', label: 'tool_count p50', status: 'unknown', detail: 'unmeasured; no ceiling until a measured link to first text exists' }
}

/** Report each agent app in the checkout against the defaults. Reads only tracked files; measures the Worker upload with the app's own Wrangler. */
export function checkAppDefaults(repoRoot: string, options: AppDefaultsOptions = {}): AppDefaultsResult {
  const tracked = trackedFiles(repoRoot)
  const packages = findAppPackages(repoRoot, tracked)
  const wranglerPaths = trackedWorkerConfigs(repoRoot)
  const apps: AppDefaultsReport[] = []
  const findings: string[] = []
  for (const pkg of packages) {
    const sources = readSources(repoRoot, tracked, pkg.dir, packages.map((other) => other.dir))
    const configs = wranglerPaths
      .filter((path) => underDir(path, pkg.dir))
      .map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }))
    const exemptions = options.exemptions ?? {}
    const pin = versionTuple(pkg.spec) ? (/(\d+\.\d+\.\d+)/.exec(pkg.spec)?.[1] ?? null) : null
    const calls = sinkCalls(sources)
    const trace = turnTraceRow(sources, calls, options.exports)
    const traceWired = trace.row.status === 'ok'
    const reports: { row: DefaultRow; id: ExemptibleDefault | null; optedOut: string | null }[] = [
      { row: pinRow(pin, pkg.spec), id: null, optedOut: null },
      { row: trace.row, id: 'turn-trace', optedOut: trace.optedOut },
      { row: firstTextRow(pin, sources, traceWired, calls, options.exports), id: 'first-text', optedOut: null },
      { row: prewarmRow(sources), id: 'prewarm', optedOut: null },
      { row: placementRow(configs), id: 'placement', optedOut: null },
      { row: toolCountRow(), id: null, optedOut: null },
      { row: limitAlarmsRow(sources), id: 'limit-alarms', optedOut: null },
      { row: bundleRow(repoRoot, pkg.dir, configs, options.measureBundle ?? true), id: null, optedOut: null },
    ]
    const rows: DefaultRow[] = []
    const appFindings: string[] = []
    for (const entry of reports) {
      if (entry.id === null) {
        rows.push(entry.row)
        continue
      }
      const resolved = withExemption(entry.row, entry.id, exemptions, entry.optedOut)
      rows.push(resolved.row)
      if (resolved.finding) appFindings.push(resolved.finding)
    }
    // Turning the trace off turns first text off with it; the one reason, or the one finding, is the trace's.
    const traceResolved = rows.find((row) => row.id === 'turn-trace')
    if (trace.optedOut && traceResolved) {
      const at = rows.findIndex((row) => row.id === 'first-text')
      rows[at] = { id: 'first-text', label: 'first text', status: traceResolved.status, detail: 'the turn trace is turned off' }
    }
    apps.push({ app: pkg.name, dir: pkg.dir, pin, rows, findings: appFindings })
    findings.push(...appFindings.map((finding) => `${pkg.name}: ${finding}`))
  }
  return { apps, findings }
}

const STATUS_MARK: Readonly<Record<DefaultStatus, string>> = {
  ok: 'ok     ',
  gap: 'GAP    ',
  unknown: '?      ',
  exempt: 'exempt ',
  'opted-out': 'FAIL   ',
  na: 'n/a    ',
}

export function formatAppDefaults(result: AppDefaultsResult): string {
  if (result.apps.length === 0) return 'no agent app in this checkout; nothing to report\n'
  const lines: string[] = []
  for (const app of result.apps) {
    lines.push(`${app.app}${app.dir === '.' ? '' : ` (${app.dir})`}`)
    for (const row of app.rows) lines.push(`  ${STATUS_MARK[row.status]}${row.label.padEnd(15)} ${row.detail}`)
  }
  for (const finding of result.findings) lines.push(`FAIL ${finding}`)
  if (result.findings.length > 0) lines.push('Defaults and how to opt out with a reason: https://github.com/tangle-network/agent-app/blob/main/docs/app-defaults.md')
  return `${lines.join('\n')}\n`
}

/** Ask Intelligence for the newest `agent_app.turn` of a project. Needs a key whose tenant owns the project's spans. */
async function readLastTurnExport(
  project: string,
  options: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<LastTurnExport | null> {
  const base = (options.baseUrl ?? 'https://intelligence.tangle.tools').replace(/\/+$/, '')
  const get = async (path: string): Promise<unknown> => {
    const response = await (options.fetchImpl ?? fetch)(`${base}${path}`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Intelligence answered HTTP ${response.status} for ${path.split('?')[0]}`)
    return response.json()
  }
  const listing = (await get(`/v1/traces?limit=1&q=agent_app.turn&attr=${encodeURIComponent(`tangle.project:${project}`)}`)) as {
    items?: { traceId: string; startUnixNano: string }[]
  }
  const newest = listing.items?.[0]
  if (!newest) return null
  const spans = (await get(`/v1/traces/${newest.traceId}/spans`)) as {
    items?: { name?: string; attributes?: Record<string, unknown> }[]
  }
  const firstTextMs = Number(spans.items?.find((span) => span.name === 'agent_app.turn')?.attributes?.['tangle.turn.first_text_ms'])
  return {
    at: Number(BigInt(newest.startUnixNano) / 1_000_000n),
    traceId: newest.traceId,
    ...(Number.isFinite(firstTextMs) ? { firstTextMs } : {}),
  }
}

/**
 * The newest turn Intelligence holds for each project the apps' sinks name, read with one platform key. A project the
 * key's tenant does not own, or one the ingest has never accepted, reads as null; a failed request leaves it out.
 */
export async function collectLastExports(repoRoot: string, apiKey: string): Promise<Map<string, LastTurnExport | null>> {
  const tracked = trackedFiles(repoRoot)
  const projects = new Set<string>()
  for (const pkg of findAppPackages(repoRoot, tracked)) {
    for (const call of sinkCalls(readSources(repoRoot, tracked, pkg.dir, []))) if (call.project) projects.add(call.project)
  }
  const exports = new Map<string, LastTurnExport | null>()
  for (const project of projects) {
    try {
      exports.set(project, await readLastTurnExport(project, { apiKey }))
    } catch {
      /* unreachable or refused: the row says the export was not checked */
    }
  }
  return exports
}
