/**
 * Server-side client for the sandbox sidecar's generic interaction routes
 * (`GET/POST {runtimeUrl}/agents/sessions/{sessionId}/interactions`). The
 * pinned sandbox SDK exposes only the question-specific `session().answer()`
 * convenience; these raw calls are backend-agnostic (question/permission/plan,
 * any harness) and carry explicit outcomes (accepted/declined).
 *
 * Server-only: the sidecar bearer must never reach browser code. The caller
 * supplies the connection as a structural value (runtime URL + bearer +
 * session id) — no sandbox-SDK import, so any box-resolution strategy works.
 */

import type { InteractionData, InteractionOutcome, InteractionRequestWire } from './contract'

/** Describe error details including code, message, and upstream HTTP status for sidecar interactions */
export interface SidecarInteractionsError {
  code: string
  message: string
  /** Upstream HTTP status; 0 when the sidecar was unreachable. */
  status: number
}

/** Represent the outcome of sidecar interactions with success or error details */
export type SidecarInteractionsResult<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: SidecarInteractionsError }

/** Where and how to reach one session's interaction registry. */
export interface SidecarInteractionsConnection {
  runtimeUrl: string
  authToken?: string
  /** The sidecar agent-session id (the chat thread's session). */
  sessionId: string
  /** Request deadline. A pending interaction means the box is up and the
   *  sidecar responsive; a short default keeps a wedged runtime from stalling
   *  the answering request. */
  timeoutMs?: number
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 5_000

/** Strips bearer tokens / key material before an upstream message is logged
 *  or surfaced. */
function sanitizeUpstreamMessage(input: unknown): string {
  const message = input instanceof Error ? input.message : String(input)
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|tc)[_-][A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
}

/** One transport for session controls and interaction answers. Keep the established
 * error codes per family; authentication, deadlines and decoding cannot drift. */
async function sidecarFetch(
  connection: SidecarInteractionsConnection,
  family: 'interactions' | 'session',
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> } = { method: 'GET' },
): Promise<SidecarInteractionsResult<Record<string, unknown>>> {
  const session = `/agents/sessions/${encodeURIComponent(connection.sessionId)}`
  const path = family === 'interactions' ? `${session}/interactions`
    : init.method === 'POST' ? `${session}/abort` : session
  const failure = (code: string, message: unknown, status: number): SidecarInteractionsResult<never> => ({
    succeeded: false, error: { code, message: sanitizeUpstreamMessage(message), status },
  })
  let response: Response
  let parsed: unknown
  try {
    response = await (connection.fetchImpl ?? fetch)(`${connection.runtimeUrl.replace(/\/$/, '')}${path}`, {
      method: init.method,
      headers: {
        ...(connection.authToken ? { authorization: `Bearer ${connection.authToken}` } : {}),
        ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(connection.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined)
      return failure('UPSTREAM_REDIRECT', 'The sidecar request refused a redirect.', response.status)
    }
    try { parsed = await response.json() } catch { parsed = undefined }
  } catch (error) {
    return family === 'interactions'
      ? failure('UPSTREAM_UNREACHABLE', error, 0)
      : failure('SIDECAR_UNREACHABLE', error, 502)
  }
  const payload = asRecord(parsed)
  if (!response.ok || payload?.success === false) {
    const error = asRecord(payload?.error)
    return failure(
      typeof error?.code === 'string' && error.code ? error.code
        : family === 'interactions' ? 'UPSTREAM_ERROR' : 'SIDECAR_SESSION_FAILED',
      typeof error?.message === 'string' && error.message ? error.message
        : `sidecar ${family} ${init.method} failed (${response.status})`,
      response.status,
    )
  }
  if (!payload) return failure('MALFORMED_RESPONSE', 'The sidecar returned no JSON object.', response.status)
  return { succeeded: true, value: payload }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Outstanding (unanswered) interactions for the session — the sidecar's
 *  registry is authoritative, so this is the reconnect/reload source of truth. */
export async function listSessionInteractions(
  connection: SidecarInteractionsConnection,
): Promise<SidecarInteractionsResult<InteractionRequestWire[]>> {
  const result = await sidecarFetch(connection, 'interactions')
  if (!result.succeeded) return result
  const data = result.value.data as { interactions?: unknown } | undefined
  if (!Array.isArray(data?.interactions)) {
    return {
      succeeded: false,
      error: { code: 'MALFORMED_RESPONSE', message: 'sidecar list returned no interactions array', status: 200 },
    }
  }
  return { succeeded: true, value: data.interactions as InteractionRequestWire[] }
}

/** Resolves one interaction. `data` is required by the sidecar only for
 *  `accepted` outcomes and is validated fail-closed against the answerSpec
 *  (400 INVALID_INTERACTION_ANSWER on mismatch). */
export async function respondToSessionInteraction(
  connection: SidecarInteractionsConnection,
  response: { id: string; outcome: InteractionOutcome; data?: InteractionData },
): Promise<SidecarInteractionsResult<void>> {
  const result = await sidecarFetch(connection, 'interactions', {
    method: 'POST',
    body: {
      id: response.id,
      outcome: response.outcome,
      ...(response.data ? { data: response.data } : {}),
    },
  })
  if (!result.succeeded) return result
  return { succeeded: true, value: undefined }
}

/**
 * A sandbox session's lifecycle as the sidecar reports it.
 *
 * Every field is optional because the sidecar's payload has grown over time and
 * an older box answers with a subset. A reader that assumes a field is present
 * mis-reads an old box as terminal; the shapes below are read defensively for
 * that reason, not out of caution about types.
 */
export interface SidecarSessionState {
  state?: string
  activeExecutionId?: string | null
  activeExecutionStatus?: string | null
  reconnectable?: boolean
  registryAuthority?: string | null
  terminalReason?: string | null
  lastEventAt?: string | number | null
  outstandingInteractions?: unknown[]
}

export interface SidecarAbortResult {
  cancelled: boolean
  reason?: string
  session?: SidecarSessionState
}

/**
 * Whether a session has finished and will not produce more events.
 *
 * The three early returns are the ones that matter: a session with a live
 * execution, one the platform says is reconnectable, or one holding an
 * unanswered interaction is NOT terminal however its `state` string reads. An
 * app that treats such a session as finished abandons a turn mid-flight, or
 * leaves an agent blocked on an answer nobody will send.
 */
export function isTerminalSidecarState(state: {
  state?: string
  activeExecutionId?: string | null
  reconnectable?: boolean
  outstandingInteractions?: unknown[]
}): boolean {
  if (state.activeExecutionId) return false
  if (state.reconnectable === true) return false
  if (state.outstandingInteractions && state.outstandingInteractions.length > 0) return false
  return TERMINAL_SESSION_STATES.includes(state.state ?? '') || state.reconnectable === false
}

const TERMINAL_SESSION_STATES = ['completed', 'failed', 'aborted', 'expired', 'idle', 'terminal']

/** Read the session payload defensively: newer boxes nest under `data`, and
 *  the execution id appears either on the session or on `activeExecution`. */
function sessionStateFromPayload(payload: Record<string, unknown>): SidecarSessionState {
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>
  const session = data.session && typeof data.session === 'object'
    ? data.session as Record<string, unknown>
    : data
  const activeExecution = data.activeExecution && typeof data.activeExecution === 'object'
    ? data.activeExecution as Record<string, unknown>
    : session.activeExecution && typeof session.activeExecution === 'object'
      ? session.activeExecution as Record<string, unknown>
      : null
  const interactions = session.outstandingInteractions ?? session.interactions
  return {
    ...(typeof session.state === 'string' ? { state: session.state } : {}),
    ...(typeof session.activeExecutionId === 'string'
      ? { activeExecutionId: session.activeExecutionId }
      : session.activeExecutionId === null ? { activeExecutionId: null } : {}),
    ...(typeof session.reconnectable === 'boolean' ? { reconnectable: session.reconnectable } : {}),
    ...(typeof session.registryAuthority === 'string'
      ? { registryAuthority: session.registryAuthority }
      : session.registryAuthority === null ? { registryAuthority: null } : {}),
    ...(typeof session.terminalReason === 'string'
      ? { terminalReason: session.terminalReason }
      : session.terminalReason === null ? { terminalReason: null } : {}),
    ...(typeof session.lastEventAt === 'string' || typeof session.lastEventAt === 'number' || session.lastEventAt === null
      ? { lastEventAt: session.lastEventAt }
      : {}),
    ...(Array.isArray(interactions) ? { outstandingInteractions: interactions } : {}),
    ...(activeExecution && typeof activeExecution.id === 'string' && typeof session.activeExecutionId !== 'string'
      ? { activeExecutionId: activeExecution.id }
      : {}),
    ...(activeExecution && typeof activeExecution.status === 'string'
      ? { activeExecutionStatus: activeExecution.status }
      : activeExecution === null && session.activeExecution === null ? { activeExecutionStatus: null } : {}),
  }
}

/** The session's current lifecycle, for reconnect and resume decisions. */
export async function getSessionState(
  connection: SidecarInteractionsConnection,
): Promise<SidecarInteractionsResult<SidecarSessionState>> {
  const result = await sidecarFetch(connection, 'session')
  if (!result.succeeded) return result
  return { succeeded: true, value: sessionStateFromPayload(result.value) }
}

/**
 * Cancel a running session.
 *
 * A 404 is reported as a SUCCESSFUL no-op rather than an error: the caller's
 * intent is "this session must not be running", and a session the sidecar has
 * never heard of already satisfies that. Surfacing it as a failure makes every
 * cancel-after-completion look like an outage.
 */
export async function abortSession(
  connection: SidecarInteractionsConnection,
): Promise<SidecarInteractionsResult<SidecarAbortResult>> {
  const result = await sidecarFetch(connection, 'session', { method: 'POST' })
  if (!result.succeeded) {
    if (result.error.status === 404) return { succeeded: true, value: { cancelled: false, reason: 'not-found' } }
    return result
  }
  const data = (result.value.data && typeof result.value.data === 'object'
    ? result.value.data
    : result.value) as Record<string, unknown>
  const reason = typeof data.reason === 'string' && data.reason.trim()
    ? data.reason.trim()
    : typeof data.noopReason === 'string' && data.noopReason.trim()
      ? data.noopReason.trim()
      : undefined
  return {
    succeeded: true,
    value: {
      cancelled: data.cancelled === true,
      ...(reason ? { reason } : {}),
      ...(data.session && typeof data.session === 'object' ? { session: sessionStateFromPayload(result.value) } : {}),
    },
  }
}
