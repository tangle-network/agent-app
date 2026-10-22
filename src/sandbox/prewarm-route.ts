/**
 * `createWorkspacePrewarmRoute`: the HTTP face of prewarm-on-open, so every
 * agent-app product warms the same way. The browser half is
 * `useWorkspacePrewarm` in `/web-react`: it POSTs here when a member opens a
 * workspace page in a visible tab, and again when they focus the composer.
 *
 * WHAT THE PRODUCT SUPPLIES. Only `authorize`. It authenticates the member
 * from the request exactly as the product's other routes do and returns the
 * warm to run: a box resume, a profile preparation, or `createSandboxPrewarmer`
 * from this subpath. The route owns everything shared: bot and prefetch
 * refusal, per-key single-flight, a short success memory, timing, and the rule
 * that a warm never reaches the member as an error.
 *
 * WHY THE WARM RUNS INSIDE THE REQUEST. A suspended box takes ~31 s to resume
 * (Hospitality production, 2026-10-10), past the 30 s that Cloudflare's
 * `waitUntil` grants after a response. Awaiting the warm keeps the request
 * open for as long as the member's tab is, which is exactly as long as a warm
 * is useful. The browser never awaits it for UI.
 *
 * IDEMPOTENCE. The in-process record only collapses concurrent calls within
 * one isolate, and a second call answers `joined` at once instead of awaiting
 * the first: on Workers a warm's I/O belongs to the request that started it, so
 * when that request is cancelled (the member navigates) its promise never
 * settles, and requests awaiting it hung 43-45 s (Hospitality production,
 * 2026-10-11). A record older than `staleMs` no longer counts. Two isolates can
 * both run the warm, so the product's warm must be safe to repeat: a resume of
 * a running box is a no-op, and a creation needs a claim store (see
 * `createSandboxPrewarmer`).
 *
 * FAILURE. A thrown warm answers 200 `{ outcome: 'failed' }` without the error
 * text, which can name internal hosts. `onEvent` receives the error so the
 * product can log it. The next real turn takes its normal placement path.
 *
 * STEPS AND RECEIPTS. Warm once: `authorize` may return `steps`, each keyed by
 * exactly what it depends on (see `warmKey`). With a `receipts` store, a step
 * whose key holds an unexpired receipt answers `hit` after one read and does not
 * run; a changed key or an expired receipt runs it again (`miss`) and writes a
 * new receipt. Steps run concurrently. The response lists each step's outcome
 * and time, and its `Server-Timing` header carries one `warm.<step>` entry per
 * step with `hit`, `miss`, `joined` or `failed`, so a caller reads every miss.
 */
import { formatServerTiming } from '../turn-trace/server-timing'
import { warmReceiptId, type WarmReceiptStore } from './warm-receipts'

/** What the product decided for this request. */
export type WorkspacePrewarmAuthorization =
  /** Not signed in, not a member, or a foreign origin: return this response. */
  | { status: 'denied'; response: Response }
  /** A signed-in member the product does not warm for (a role that cannot
   *  chat, a box mid-upgrade). Answers 200 so the browser stays quiet. */
  | { status: 'declined'; reason: string }
  /**
   * Run `warm` once per `key` at a time. `key` names what is warmed, such as
   * the box; members who share a box share a key. `warm` may return a small
   * JSON-safe report for the response and `onEvent`.
   */
  | { status: 'allowed'; key: string; warm: () => Promise<WorkspacePrewarmReport | void> }
  /** Run each step whose key has no unexpired receipt. */
  | { status: 'allowed'; steps: readonly WorkspaceWarmStep[] }

/** One warm step, keyed by exactly what it depends on. */
export interface WorkspaceWarmStep {
  /** A short name, unique within the response: `session`, `vault_heads`, `tool_catalog`, `box`. */
  name: string
  /** What the step depends on (`warmKey({ userId, workspaceId, vaultHead })`). Members who share the result share the key. */
  key: string
  /** How long a successful run counts. Keep it shorter than the warmed thing's own idle expiry (a box that suspends
   *  after 5 idle minutes gets a TTL well under that), because a receipt cannot see the thing go cold. */
  ttlMs: number
  /** Do the work. The report, small JSON and never a credential, is stored on the receipt for the turn to read. */
  run: () => Promise<WorkspacePrewarmReport | void>
}

/** Why the browser asked: `useWorkspacePrewarm` sends `page-open`, `composer-focus`, or `heartbeat` while the tab stays open. */
export type WorkspacePrewarmReason = 'page-open' | 'composer-focus' | 'heartbeat'

export type WorkspaceWarmStepOutcome = 'hit' | 'miss' | 'joined' | 'failed'

export interface WorkspaceWarmStepResult {
  name: string
  outcome: WorkspaceWarmStepOutcome
  ms: number
}

export type WorkspacePrewarmReport = Record<string, string | number | boolean | null>

export type WorkspacePrewarmOutcome =
  /** This request ran the warm to completion. */
  | 'warmed'
  /** Another request in this isolate is already running it; this one answered at once. */
  | 'joined'
  /** The same key warmed successfully within `recentMs`; nothing ran. */
  | 'recent'
  | 'declined'
  /** A crawler, link preview, or speculative prefetch; nothing ran. */
  | 'automated'
  | 'failed'

export interface WorkspacePrewarmResponse {
  outcome: WorkspacePrewarmOutcome
  /** Time this request spent, including any warm it ran. A `joined` answer never waits. */
  ms: number
  reason?: string
  report?: WorkspacePrewarmReport
  /** Each step's outcome, for an authorization that returned `steps`. */
  steps?: WorkspaceWarmStepResult[]
}

export type WorkspacePrewarmEvent =
  | { type: 'warmed'; key: string; ms: number; report?: WorkspacePrewarmReport }
  | { type: 'failed'; key: string; ms: number; error: string }
  /** One step of a stepped warm; `failed` carries the error. */
  | { type: 'step'; name: string; key: string; outcome: WorkspaceWarmStepOutcome; ms: number; error?: string }

export interface CreateWorkspacePrewarmRouteOptions<Context = void> {
  /** `context` is whatever the caller passed beside the request, such as a
   *  Hono context carrying the Worker's bindings. */
  /** `threadId` is the thread the composer belongs to, when the browser sent one (composer focus). Check the member's access to it before warming anything for it. */
  authorize(input: { request: Request; context: Context; reason: WorkspacePrewarmReason; threadId?: string }): Promise<WorkspacePrewarmAuthorization>
  /** Where step receipts live across isolates (`createD1WarmReceiptStore`). Without it, receipts last for this isolate only. */
  receipts?: WarmReceiptStore
  /** After a successful warm, answer `recent` for this long. Default 30 000 ms. */
  recentMs?: number
  /** A warm started longer ago than this no longer blocks the key: its request
   *  may have been cancelled, taking the warm with it. A longer warm still
   *  running is repeated, which is safe because warms must be idempotent.
   *  Default 45 000 ms (a suspended box resumes in ~31 s). */
  staleMs?: number
  /** Observability for warms this route ran. Errors thrown here are ignored. */
  onEvent?(event: WorkspacePrewarmEvent): void
  /** Clock seam for tests. */
  now?(): number
}

// Crawlers and link-preview fetchers. Headless browsers are deliberately absent:
// signed-in QA drives a headless browser through this same path.
const AUTOMATED_AGENT =
  /bot\b|crawler|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|curl\/|wget\/|python-requests|go-http-client/i

/** True for crawler user agents and browser speculative prefetch or prerender. */
export function isAutomatedPrewarmRequest(request: Request): boolean {
  const purpose = `${request.headers.get('sec-purpose') ?? ''} ${request.headers.get('purpose') ?? ''}`
  if (/prefetch|prerender/i.test(purpose)) return true
  return AUTOMATED_AGENT.test(request.headers.get('user-agent') ?? '')
}

const RECENT_LIMIT = 1_000

const REASONS: readonly WorkspacePrewarmReason[] = ['page-open', 'composer-focus', 'heartbeat']
const THREAD_ID = /^[A-Za-z0-9_:.-]{1,128}$/

async function requestIntent(request: Request): Promise<{ reason: WorkspacePrewarmReason; threadId?: string }> {
  if (Number(request.headers.get('content-length') ?? 0) > 1_024) return { reason: 'page-open' }
  try {
    // A clone, so a product's authorize can still read the body.
    const body = (await request.clone().json()) as { reason?: unknown; threadId?: unknown } | null
    const reason = REASONS.find((known) => known === body?.reason) ?? 'page-open'
    const threadId = typeof body?.threadId === 'string' && THREAD_ID.test(body.threadId) ? body.threadId : undefined
    return { reason, ...(threadId ? { threadId } : {}) }
  } catch {
    return { reason: 'page-open' }
  }
}

function reply(body: WorkspacePrewarmResponse, status = 200): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' }
  if (body.steps?.length) {
    headers['Server-Timing'] = formatServerTiming(body.steps.map((step) => ({ name: `warm.${step.name}`, durMs: step.ms, desc: step.outcome })))
  }
  return Response.json(body, { status, headers })
}

/**
 * Build the handler once per isolate, not per request: its single-flight and
 * success memory live in the returned closure.
 */
export function createWorkspacePrewarmRoute<Context = void>(
  options: CreateWorkspacePrewarmRouteOptions<Context>,
): (request: Request, context: Context) => Promise<Response> {
  const recentMs = options.recentMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  const staleMs = options.staleMs ?? 45_000
  // Start times, never promises: no request may await I/O another request owns.
  const inFlight = new Map<string, { at: number }>()
  const recent = new Map<string, number>()
  // Step receipt id -> the epoch ms its receipt stops counting, this isolate's copy of the store.
  const warmUntil = new Map<string, number>()
  // Steps keep their own in-flight marks, so a legacy key can never collide with a step id.
  const stepsInFlight = new Map<string, { at: number }>()

  const emit = (event: WorkspacePrewarmEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Logging must not change the warm's outcome.
    }
  }

  const remember = (key: string, at: number, into = recent): void => {
    into.delete(key)
    into.set(key, at)
    // Insertion order is age order, so the oldest entries go first.
    for (const old of into.keys()) {
      if (into.size <= RECENT_LIMIT) break
      into.delete(old)
    }
  }

  async function run(key: string, warm: () => Promise<WorkspacePrewarmReport | void>): Promise<WorkspacePrewarmResponse> {
    const started = now()
    try {
      const report = (await warm()) ?? undefined
      const ms = now() - started
      remember(key, now())
      emit({ type: 'warmed', key, ms, ...(report ? { report } : {}) })
      return { outcome: 'warmed', ms, ...(report ? { report } : {}) }
    } catch (err) {
      const ms = now() - started
      emit({ type: 'failed', key, ms, error: err instanceof Error ? err.message : String(err) })
      return { outcome: 'failed', ms }
    }
  }

  /** One step: an unexpired receipt in this isolate or the store answers `hit`; otherwise run it and write the receipt. */
  async function runStep(step: WorkspaceWarmStep): Promise<WorkspaceWarmStepResult> {
    const started = now()
    const id = warmReceiptId(step.name, step.key)
    const result = (outcome: WorkspaceWarmStepOutcome, error?: string): WorkspaceWarmStepResult => {
      const ms = now() - started
      emit({ type: 'step', name: step.name, key: step.key, outcome, ms, ...(error ? { error } : {}) })
      return { name: step.name, outcome, ms }
    }
    const local = warmUntil.get(id)
    if (local !== undefined && now() < local) return result('hit')
    const running = stepsInFlight.get(id)
    if (running && now() - running.at < staleMs) return result('joined')
    const mark = { at: now() }
    stepsInFlight.set(id, mark)
    try {
      if (options.receipts) {
        try {
          const stored = await options.receipts.get(id)
          if (stored && now() < stored.expiresAt) {
            remember(id, stored.expiresAt, warmUntil)
            return result('hit')
          }
        } catch (err) {
          // An unreadable store is a miss: warms are safe to repeat.
          emit({ type: 'failed', key: id, ms: now() - started, error: err instanceof Error ? err.message : String(err) })
        }
      }
      let report: WorkspacePrewarmReport | undefined
      try {
        report = (await step.run()) ?? undefined
      } catch (err) {
        return result('failed', err instanceof Error ? err.message : String(err))
      }
      const at = now()
      const expiresAt = at + step.ttlMs
      remember(id, expiresAt, warmUntil)
      if (options.receipts) {
        await options.receipts.put(id, { at, expiresAt, ...(report ? { report } : {}) }).catch((err: unknown) => {
          emit({ type: 'failed', key: id, ms: now() - started, error: err instanceof Error ? err.message : String(err) })
        })
      }
      return result('miss')
    } finally {
      if (stepsInFlight.get(id) === mark) stepsInFlight.delete(id)
    }
  }

  return async function prewarm(request: Request, context: Context): Promise<Response> {
    const started = now()
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    }
    if (isAutomatedPrewarmRequest(request)) return reply({ outcome: 'automated', ms: 0 })

    let auth: WorkspacePrewarmAuthorization
    try {
      auth = await options.authorize({ request, context, ...(await requestIntent(request)) })
    } catch (err) {
      // An authorization that cannot decide refuses; it never warms.
      emit({ type: 'failed', key: '', ms: now() - started, error: err instanceof Error ? err.message : String(err) })
      return reply({ outcome: 'failed', ms: now() - started })
    }
    if (auth.status === 'denied') return auth.response
    if (auth.status === 'declined') return reply({ outcome: 'declined', ms: now() - started, reason: auth.reason })
    if ('steps' in auth) {
      const steps = await Promise.all(auth.steps.map((step) => runStep(step)))
      const outcome: WorkspacePrewarmOutcome = steps.some((step) => step.outcome === 'failed') ? 'failed'
        : steps.some((step) => step.outcome === 'miss') ? 'warmed'
          : steps.some((step) => step.outcome === 'joined') ? 'joined' : 'recent'
      return reply({ outcome, ms: now() - started, steps })
    }

    const { key } = auth
    const running = inFlight.get(key)
    if (running && now() - running.at < staleMs) {
      return reply({ outcome: 'joined', ms: now() - started })
    }
    const warmedAt = recent.get(key)
    if (warmedAt !== undefined && now() - warmedAt < recentMs) {
      return reply({ outcome: 'recent', ms: now() - started })
    }
    const mark = { at: now() }
    inFlight.set(key, mark)
    try {
      return reply({ ...(await run(key, auth.warm)), ms: now() - started })
    } finally {
      if (inFlight.get(key) === mark) inFlight.delete(key)
    }
  }
}
