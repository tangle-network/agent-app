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

async function interactionsFetch(
  connection: SidecarInteractionsConnection,
  init: { method: 'GET' } | { method: 'POST'; body: Record<string, unknown> },
): Promise<SidecarInteractionsResult<Record<string, unknown>>> {
  const doFetch = connection.fetchImpl ?? fetch
  const url = `${connection.runtimeUrl.replace(/\/$/, '')}/agents/sessions/${encodeURIComponent(connection.sessionId)}/interactions`
  let response: Response
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        ...(connection.authToken ? { Authorization: `Bearer ${connection.authToken}` } : {}),
        ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(connection.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      succeeded: false,
      error: { code: 'UPSTREAM_UNREACHABLE', message: sanitizeUpstreamMessage(err), status: 0 },
    }
  }
  const raw = await response.text().catch(() => '')
  let parsed: Record<string, unknown> = {}
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    // Non-JSON error bodies (proxy 502 pages) fall through to the status check.
  }
  if (!response.ok) {
    const upstreamError = (parsed.error ?? {}) as { code?: unknown; message?: unknown }
    return {
      succeeded: false,
      error: {
        code: typeof upstreamError.code === 'string' && upstreamError.code ? upstreamError.code : 'UPSTREAM_ERROR',
        message: sanitizeUpstreamMessage(
          typeof upstreamError.message === 'string' && upstreamError.message
            ? upstreamError.message
            : `sidecar interactions ${init.method} failed (${response.status})`,
        ),
        status: response.status,
      },
    }
  }
  return { succeeded: true, value: parsed }
}

/** Outstanding (unanswered) interactions for the session — the sidecar's
 *  registry is authoritative, so this is the reconnect/reload source of truth. */
export async function listSessionInteractions(
  connection: SidecarInteractionsConnection,
): Promise<SidecarInteractionsResult<InteractionRequestWire[]>> {
  const result = await interactionsFetch(connection, { method: 'GET' })
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
  const result = await interactionsFetch(connection, {
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
