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
 * IDEMPOTENCE. The in-process map only collapses concurrent calls within one
 * isolate. Two isolates can both run the warm, so the product's warm must be
 * safe to repeat: a resume of a running box is a no-op, and a creation needs a
 * claim store (see `createSandboxPrewarmer`).
 *
 * FAILURE. A thrown warm answers 200 `{ outcome: 'failed' }` without the error
 * text, which can name internal hosts. `onEvent` receives the error so the
 * product can log it. The next real turn takes its normal placement path.
 */

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

export type WorkspacePrewarmReport = Record<string, string | number | boolean | null>

export type WorkspacePrewarmOutcome =
  /** This request ran the warm to completion. */
  | 'warmed'
  /** Another request in this isolate was already running it; this one waited for it. */
  | 'joined'
  /** The same key warmed successfully within `recentMs`; nothing ran. */
  | 'recent'
  | 'declined'
  /** A crawler, link preview, or speculative prefetch; nothing ran. */
  | 'automated'
  | 'failed'

export interface WorkspacePrewarmResponse {
  outcome: WorkspacePrewarmOutcome
  /** Time this request spent, including any warm it ran or joined. */
  ms: number
  reason?: string
  report?: WorkspacePrewarmReport
}

export type WorkspacePrewarmEvent =
  | { type: 'warmed'; key: string; ms: number; report?: WorkspacePrewarmReport }
  | { type: 'failed'; key: string; ms: number; error: string }

export interface CreateWorkspacePrewarmRouteOptions<Context = void> {
  /** `context` is whatever the caller passed beside the request, such as a
   *  Hono context carrying the Worker's bindings. */
  authorize(input: { request: Request; context: Context }): Promise<WorkspacePrewarmAuthorization>
  /** After a successful warm, answer `recent` for this long. Default 30 000 ms. */
  recentMs?: number
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

function reply(body: WorkspacePrewarmResponse, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
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
  const inFlight = new Map<string, Promise<WorkspacePrewarmResponse>>()
  const recent = new Map<string, number>()

  const emit = (event: WorkspacePrewarmEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Logging must not change the warm's outcome.
    }
  }

  const remember = (key: string, at: number): void => {
    recent.delete(key)
    recent.set(key, at)
    // Insertion order is age order, so the oldest entries go first.
    for (const old of recent.keys()) {
      if (recent.size <= RECENT_LIMIT) break
      recent.delete(old)
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

  return async function prewarm(request: Request, context: Context): Promise<Response> {
    const started = now()
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    }
    if (isAutomatedPrewarmRequest(request)) return reply({ outcome: 'automated', ms: 0 })

    let auth: WorkspacePrewarmAuthorization
    try {
      auth = await options.authorize({ request, context })
    } catch (err) {
      // An authorization that cannot decide refuses; it never warms.
      emit({ type: 'failed', key: '', ms: now() - started, error: err instanceof Error ? err.message : String(err) })
      return reply({ outcome: 'failed', ms: now() - started })
    }
    if (auth.status === 'denied') return auth.response
    if (auth.status === 'declined') return reply({ outcome: 'declined', ms: now() - started, reason: auth.reason })

    const { key } = auth
    const running = inFlight.get(key)
    if (running) {
      const result = await running
      return reply({ ...result, outcome: result.outcome === 'warmed' ? 'joined' : result.outcome, ms: now() - started })
    }
    const warmedAt = recent.get(key)
    if (warmedAt !== undefined && now() - warmedAt < recentMs) {
      return reply({ outcome: 'recent', ms: now() - started })
    }
    const result = run(key, auth.warm)
    inFlight.set(key, result)
    try {
      return reply({ ...(await result), ms: now() - started })
    } finally {
      if (inFlight.get(key) === result) inFlight.delete(key)
    }
  }
}
