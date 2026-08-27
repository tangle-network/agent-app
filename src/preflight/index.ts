/**
 * `/preflight` — deploy-time secret-liveness probes.
 *
 * WHY THIS EXISTS: on 2026-07-15 four secrets were simultaneously dead in one
 * production day — a dead `SANDBOX_API_KEY`, a stale `SANDBOX_API_URL`, and a
 * dead LiteLLM router key + URL. Each one was present in `wrangler secret list`
 * (so nothing looked wrong) yet invalid against its live endpoint, and nothing
 * anywhere checked liveness. CI cannot hold production secrets, so this binds
 * at DEPLOY time instead: a product declares a handful of probes built from its
 * real env, the deploy workflow runs `agent-app-preflight` as a step, and a
 * dead secret fails the deploy with a message that names exactly which secret
 * to rotate.
 *
 * A probe is `{ name, run, critical? }`; `run()` returns `{ ok, detail? }`.
 * The standard builders (`routerChatProbe`, `sandboxAuthProbe`, `httpHeadProbe`)
 * each take explicit config — they read nothing global — so the same probe runs
 * identically in a deploy step, a test, or a local check. `runPreflight` fans
 * the probes out, times each, and folds them into a pass/fail report: any
 * failed CRITICAL probe fails the whole run (probes are critical by default).
 *
 * Server-only: probes carry live API keys and hit live endpoints. This subpath
 * must never reach a browser bundle.
 */

/** One probe's outcome. `detail` should name the secret to rotate on failure. */
export interface PreflightProbeResult {
  ok: boolean
  detail?: string
}

/**
 * A liveness probe. `run` performs one cheap live call and maps the result to
 * `{ ok, detail }`. `critical` defaults to `true` — a failed critical probe
 * fails the whole preflight (and the deploy).
 */
export interface PreflightProbe {
  name: string
  run: () => Promise<PreflightProbeResult>
  critical?: boolean
}

/** Per-probe verdict enriched with the resolved criticality and measured latency. */
export interface PreflightProbeVerdict {
  name: string
  ok: boolean
  critical: boolean
  latencyMs: number
  detail?: string
}

/** Aggregate of every probe verdict plus the overall pass/fail decision. */
export interface PreflightReport {
  /** `false` if any critical probe failed. */
  ok: boolean
  probes: PreflightProbeVerdict[]
  passed: number
  failed: number
  criticalFailures: number
  durationMs: number
}

/** Deploy-time deadline for a single probe. Cold upstreams are slow; a dead
 *  endpoint should still fail fast, so 10s is the ceiling, not the target. */
const DEFAULT_TIMEOUT_MS = 10_000

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/** Strip bearer tokens / key material before an upstream string is surfaced in
 *  a report (deploy logs are not always private). */
function sanitizeUpstreamMessage(input: unknown): string {
  const message = input instanceof Error ? input.message : String(input)
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|tc)[_-][A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
}

function snippet(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  const clipped = trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed
  return `: ${sanitizeUpstreamMessage(clipped)}`
}

type ProbeOutcome =
  | { kind: 'status'; status: number; bodyText: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'network'; message: string }

interface HttpProbeCall {
  fetchImpl: typeof fetch
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}

/** One live HTTP call, folded to a probe outcome. Never throws: a timeout, a
 *  DNS/connection failure, and any thrown error all become an outcome so the
 *  probe can classify them into an actionable detail. */
async function runHttp(call: HttpProbeCall): Promise<ProbeOutcome> {
  let response: Response
  try {
    response = await call.fetchImpl(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal: AbortSignal.timeout(call.timeoutMs),
    })
  } catch (err) {
    if (isAbortLike(err)) return { kind: 'timeout', timeoutMs: call.timeoutMs }
    return { kind: 'network', message: sanitizeUpstreamMessage(err) }
  }
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  return { kind: 'status', status: response.status, bodyText }
}

interface AuthedClassifyContext {
  /** Full endpoint reached, for the message. */
  endpoint: string
  /** How to name the API-key secret when the endpoint reports auth failure. */
  keyLabel: string
  /** How to name the URL secret when the endpoint is unreachable. */
  urlLabel: string
}

/**
 * Shared classification for an authed liveness endpoint (router, sandbox):
 * 2xx → live; 401/403 → the KEY is dead, name it; 503 → the UPSTREAM is down,
 * the key still looks valid, don't rotate; timeout / unreachable → the URL is
 * likely stale, name it; anything else → an unexpected status with a snippet.
 */
function classifyAuthed(outcome: ProbeOutcome, ctx: AuthedClassifyContext): PreflightProbeResult {
  switch (outcome.kind) {
    case 'status': {
      const { status, bodyText } = outcome
      if (status >= 200 && status < 300) return { ok: true, detail: `${status} OK` }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          detail: `DEAD KEY — ${ctx.endpoint} returned ${status}; rotate ${ctx.keyLabel}`,
        }
      }
      if (status === 503) {
        return {
          ok: false,
          detail: `UPSTREAM DOWN — ${ctx.endpoint} returned 503; ${ctx.keyLabel} still looks valid, retry or check the provider (do NOT rotate)`,
        }
      }
      return { ok: false, detail: `UNEXPECTED ${status} from ${ctx.endpoint}${snippet(bodyText)}` }
    }
    case 'timeout':
      return {
        ok: false,
        detail: `TIMEOUT after ${outcome.timeoutMs}ms reaching ${ctx.endpoint} — check ${ctx.urlLabel}`,
      }
    case 'network':
      return {
        ok: false,
        detail: `UNREACHABLE ${ctx.endpoint} (${outcome.message}) — check ${ctx.urlLabel}`,
      }
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// --- Standard probe builders --------------------------------------------------

/** Define configuration options for probing an LLM router with authentication and model details */
export interface RouterChatProbeConfig {
  /** LLM router base URL (LiteLLM / OpenAI-compatible), e.g. `https://router…`. */
  baseUrl: string
  apiKey: string
  /** A cheap model id available on the router. */
  model: string
  /** Probe name in the report. Default `'router-chat'`. */
  name?: string
  /** Default `true`. */
  critical?: boolean
  /** Env-var name of the API key, named verbatim in a dead-key failure. */
  keySecret?: string
  /** Env-var name of the base URL, named verbatim in an unreachable failure. */
  urlSecret?: string
  /** Per-probe deadline. Default 10s. */
  timeoutMs?: number
  /** Injection seam for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Probe an OpenAI-compatible LLM router with one cheap `POST /chat/completions`
 * (`max_tokens: 1`). 200 → live; 401/403 → dead router key; 503 → upstream
 * provider down (key still valid); timeout / unreachable → check the router URL.
 */
export function routerChatProbe(config: RouterChatProbeConfig): PreflightProbe {
  const keyLabel = config.keySecret ?? 'the router API key'
  const urlLabel = config.urlSecret ?? 'the router base URL'
  return {
    name: config.name ?? 'router-chat',
    critical: config.critical,
    run: async () => {
      const base = trimTrailingSlash(config.baseUrl)
      const endpoint = `${base}/chat/completions`
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: endpoint,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      return classifyAuthed(outcome, { endpoint, keyLabel, urlLabel })
    },
  }
}

/** Define configuration options for probing sandbox authentication endpoints */
export interface SandboxAuthProbeConfig {
  /** Sandbox API base URL. */
  baseUrl: string
  apiKey: string
  /** Probe name in the report. Default `'sandbox-auth'`. */
  name?: string
  /** Default `true`. */
  critical?: boolean
  /** Env-var name of the API key, named verbatim in a dead-key failure. */
  keySecret?: string
  /** Env-var name of the base URL, named verbatim in an unreachable failure. */
  urlSecret?: string
  /** Per-probe deadline. Default 10s. */
  timeoutMs?: number
  /** Injection seam for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Probe the sandbox API with a cheap authed `GET /v1/sandboxes?limit=1`.
 * 200 → live; 401/403 → dead sandbox key; 503 → sandbox platform down (key
 * still valid); timeout / unreachable → check the sandbox URL.
 */
export function sandboxAuthProbe(config: SandboxAuthProbeConfig): PreflightProbe {
  const keyLabel = config.keySecret ?? 'the sandbox API key'
  const urlLabel = config.urlSecret ?? 'the sandbox base URL'
  return {
    name: config.name ?? 'sandbox-auth',
    critical: config.critical,
    run: async () => {
      const base = trimTrailingSlash(config.baseUrl)
      const endpoint = `${base}/v1/sandboxes?limit=1`
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: endpoint,
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      return classifyAuthed(outcome, { endpoint, keyLabel, urlLabel })
    },
  }
}

/** Define configuration options for performing an HTTP HEAD probe to check URL availability */
export interface HttpHeadProbeConfig {
  /** Probe name in the report. */
  name: string
  /** URL to `HEAD`. */
  url: string
  /**
   * Accepted status(es). A single number requires an exact match; an array
   * requires membership. Omitted → any 2xx/3xx (the host is up and the path
   * resolves) counts as live.
   */
  expectStatus?: number | number[]
  /** Default `true`. */
  critical?: boolean
  /** Env-var name of the URL, named verbatim in a failure. */
  urlSecret?: string
  /** Per-probe deadline. Default 10s. */
  timeoutMs?: number
  /** Injection seam for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

function statusMatches(status: number, expect?: number | number[]): boolean {
  if (expect === undefined) return status >= 200 && status < 400
  if (Array.isArray(expect)) return expect.includes(status)
  return status === expect
}

function describeExpected(expect?: number | number[]): string {
  if (expect === undefined) return '2xx/3xx'
  if (Array.isArray(expect)) return expect.join(' or ')
  return String(expect)
}

/**
 * Probe a plain reachability endpoint (e.g. a platform base URL) with a `HEAD`.
 * Confirms the URL is live and resolving — the class of failure behind a stale
 * platform URL that still sits in the secret store.
 */
export function httpHeadProbe(config: HttpHeadProbeConfig): PreflightProbe {
  const urlLabel = config.urlSecret ?? `the URL for ${config.name}`
  return {
    name: config.name,
    critical: config.critical,
    run: async () => {
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: config.url,
        method: 'HEAD',
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      switch (outcome.kind) {
        case 'status': {
          if (statusMatches(outcome.status, config.expectStatus)) {
            return { ok: true, detail: `${outcome.status} OK` }
          }
          return {
            ok: false,
            detail: `UNEXPECTED ${outcome.status} from ${config.url} (expected ${describeExpected(config.expectStatus)}) — check ${urlLabel}`,
          }
        }
        case 'timeout':
          return {
            ok: false,
            detail: `TIMEOUT after ${outcome.timeoutMs}ms reaching ${config.url} — check ${urlLabel}`,
          }
        case 'network':
          return {
            ok: false,
            detail: `UNREACHABLE ${config.url} (${outcome.message}) — check ${urlLabel}`,
          }
      }
    },
  }
}

// --- Runner + report ----------------------------------------------------------

async function runOne(probe: PreflightProbe): Promise<PreflightProbeVerdict> {
  const critical = probe.critical ?? true
  const start = nowMs()
  try {
    const result = await probe.run()
    return {
      name: probe.name,
      ok: result.ok,
      critical,
      latencyMs: Math.round(nowMs() - start),
      detail: result.detail,
    }
  } catch (err) {
    return {
      name: probe.name,
      ok: false,
      critical,
      latencyMs: Math.round(nowMs() - start),
      detail: `probe threw: ${sanitizeUpstreamMessage(err)}`,
    }
  }
}

/**
 * Run every probe (concurrently), time each, and fold into a report. The run
 * fails (`ok: false`) iff a critical probe fails; a failed non-critical probe
 * is a warning that does not block the deploy.
 */
export async function runPreflight(probes: PreflightProbe[]): Promise<PreflightReport> {
  const start = nowMs()
  const verdicts = await Promise.all(probes.map(runOne))
  const failed = verdicts.filter((v) => !v.ok)
  const criticalFailures = failed.filter((v) => v.critical).length
  return {
    ok: criticalFailures === 0,
    probes: verdicts,
    passed: verdicts.length - failed.length,
    failed: failed.length,
    criticalFailures,
    durationMs: Math.round(nowMs() - start),
  }
}

interface FormatRow {
  status: string
  name: string
  latency: string
  detail: string
}

/** Render a report as an aligned, operator-readable table + verdict line. Pure
 *  (no I/O) so it is trivially testable and reusable by the bin. */
export function formatPreflightReport(report: PreflightReport): string {
  const header: FormatRow = { status: 'STATUS', name: 'PROBE', latency: 'LATENCY', detail: 'DETAIL' }
  const rows: FormatRow[] = report.probes.map((p) => ({
    status: p.ok ? 'PASS' : p.critical ? 'FAIL' : 'WARN',
    name: p.name,
    latency: `${p.latencyMs}ms`,
    detail: p.detail ?? '',
  }))
  const statusW = Math.max(header.status.length, ...rows.map((r) => r.status.length))
  const nameW = Math.max(header.name.length, ...rows.map((r) => r.name.length))
  const latencyW = Math.max(header.latency.length, ...rows.map((r) => r.latency.length))
  const line = (r: FormatRow): string =>
    `${r.status.padEnd(statusW)}  ${r.name.padEnd(nameW)}  ${r.latency.padStart(latencyW)}  ${r.detail}`.trimEnd()

  const out: string[] = [
    line(header),
    `${'-'.repeat(statusW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(latencyW)}  ------`,
    ...rows.map(line),
    '',
  ]
  if (report.ok) {
    const warn = report.failed > 0 ? ` (${report.failed} non-critical warning(s))` : ''
    out.push(`Preflight PASSED — ${report.passed}/${report.probes.length} probe(s) live${warn}`)
  } else {
    const dead = report.probes
      .filter((p) => !p.ok && p.critical)
      .map((p) => p.name)
      .join(', ')
    out.push(`Preflight FAILED — ${report.criticalFailures} critical probe(s) dead: ${dead}`)
    out.push('Rotate the secret named in each FAIL row above, then redeploy.')
  }
  return out.join('\n')
}
