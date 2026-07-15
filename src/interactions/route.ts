/**
 * Framework-neutral interaction-answer endpoints, lifted out of the per-app
 * route files (gtm `api.chat.interactions`, legal `api.chat.interactions`,
 * tax `api.sessions.$id.interactions` — three byte-similar forks):
 *
 *   list(request)   — GET: outstanding asks for a live turn (reload restore)
 *   answer(request) — POST `{ id, outcome, data? }`: resolve one ask
 *
 * The product supplies ONE seam, `resolveConnection`: authenticate the caller,
 * authorize the thread/session, and resolve the sidecar connection. Everything
 * behind the seam is mechanism the forks kept re-fixing:
 *
 *   - body validation (safe field keys, typed values),
 *   - sidecar error → client contract mapping (every "the ask is gone" shape
 *     becomes 410 so the card flips to its expired state),
 *   - duplicate resolution: after answering, every other outstanding ask with
 *     the same content signature (a re-emitted duplicate) gets the same answer,
 *   - unblock verification: re-list and fail loud (503 INTERACTION_STILL_PENDING)
 *     when the sidecar accepted the POST but the ask is still open,
 *   - best-effort list: sidecar failures return `{ interactions: [],
 *     unavailable }` so a reload restore never breaks the live stream.
 *
 * Handlers return web-standard `Response`s (Workers, Node 18+, Deno) — no
 * router import anywhere.
 */

import {
  interactionFromWireRequest,
  isSafeInteractionFieldKey,
  questionInteractionContentSignature,
  type InteractionData,
} from './contract'
import {
  listSessionInteractions,
  respondToSessionInteraction,
  type SidecarInteractionsConnection,
  type SidecarInteractionsError,
} from './sidecar'

// A client resolves an ask by answering (`accepted`) or refusing (`declined`).
// Withdrawal (`cancelled`) is an agent/broker outcome delivered via the
// `interaction.cancel` event, never a client POST, so it is not accepted here.
export type InteractionClientOutcome = 'accepted' | 'declined'

export type InteractionAnswerBodyValidation =
  | { ok: true; id: string; outcome: InteractionClientOutcome; data?: InteractionData }
  | { ok: false; error: string }

/** Validates the client POST body: `{ id, outcome, data? }` with
 *  identifier-safe field keys and primitive/string-array values only. */
export function validateInteractionAnswerBody(body: Record<string, unknown>): InteractionAnswerBodyValidation {
  const id = typeof body.id === 'string' && body.id ? body.id : null
  if (!id) return { ok: false, error: 'Missing interaction id' }
  const outcome = body.outcome
  if (outcome !== 'accepted' && outcome !== 'declined') {
    return { ok: false, error: 'Invalid outcome: expected accepted or declined' }
  }
  if (body.data === undefined) return { ok: true, id, outcome }
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return { ok: false, error: 'Invalid data: expected an object of field values' }
  }
  const data: InteractionData = {}
  for (const [key, value] of Object.entries(body.data)) {
    if (!isSafeInteractionFieldKey(key)) {
      return { ok: false, error: 'Invalid data: field names must contain only letters, numbers, underscores, or hyphens' }
    }
    const validValue =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    if (!validValue) {
      return { ok: false, error: 'Invalid data: field values must be strings, numbers, booleans, or string arrays' }
    }
    data[key] = value as InteractionData[string]
  }
  return { ok: true, id, outcome, data }
}

export type InteractionRouteLogger = Pick<Console, 'warn' | 'error'>

/** Sidecar error → the client-actionable contract. Every "the ask is gone"
 *  shape maps to 410 so the card flips to its expired state — a raw 404/409
 *  must never surface. */
export function mapInteractionRespondFailure(
  error: SidecarInteractionsError,
  logger: InteractionRouteLogger = console,
): Response {
  if (error.code === 'INVALID_INTERACTION_ANSWER') {
    return Response.json(
      { code: 'INVALID_INTERACTION_ANSWER', error: 'This question needs an answer from the card above — pick one of the listed options.' },
      { status: 400 },
    )
  }
  if (error.status === 404) {
    return Response.json(
      { code: 'INTERACTION_EXPIRED', error: 'This question is no longer waiting for an answer.' },
      { status: 410 },
    )
  }
  if (error.status === 501 || error.code === 'NOT_IMPLEMENTED') {
    return Response.json(
      { code: 'INTERACTIONS_UNSUPPORTED', error: 'This agent backend cannot accept answers this way.' },
      { status: 501 },
    )
  }
  logger.error('[interactions] respond failed:', error)
  return Response.json(
    { code: 'INTERACTION_UPSTREAM_FAILED', error: 'Could not reach the agent. Try again.' },
    { status: 503 },
  )
}

/** The product seam's verdict for one request. `response` short-circuits with
 *  a product-authored Response (401/404/429…); `unavailable` means the caller
 *  is fine but the sandbox runtime is not reachable — the factory shapes that
 *  per intent (empty list for `list`, 503 for `answer`). */
export type InteractionConnectionResolution =
  | { ok: true; connection: SidecarInteractionsConnection }
  | { ok: false; response: Response }
  | { ok: false; unavailable: string }

export interface ResolveInteractionConnectionArgs {
  request: Request
  intent: 'list' | 'answer'
  /** The parsed, validated POST body (answer intent only) so the resolver can
   *  read product routing fields (workspaceId/threadId) without re-parsing. */
  body?: Record<string, unknown>
}

export interface InteractionAnswerRouteOptions {
  /** Authenticate + authorize the caller and resolve the sidecar connection.
   *  This is the only product-supplied step: session auth, workspace/thread
   *  access, rate limiting, and box resolution all live here. */
  resolveConnection: (args: ResolveInteractionConnectionArgs) => Promise<InteractionConnectionResolution>
  logger?: InteractionRouteLogger
}

export interface InteractionAnswerRoute {
  /** GET — outstanding interactions for a live turn. Failures return an empty
   *  list with an explicit `unavailable` code: the caller is a best-effort
   *  reload restore, and the live/replayed stream must stay untouched when the
   *  sidecar cannot answer. */
  list: (request: Request) => Promise<Response>
  /** POST `{ id, outcome, data?, ...productFields }` — resolve one ask, answer
   *  content-identical duplicates the same way, then re-list to prove the run
   *  actually unblocked. */
  answer: (request: Request) => Promise<Response>
}

export function createInteractionAnswerRoute(options: InteractionAnswerRouteOptions): InteractionAnswerRoute {
  const logger = options.logger ?? console

  async function list(request: Request): Promise<Response> {
    const resolution = await options.resolveConnection({ request, intent: 'list' })
    if (!resolution.ok) {
      if ('response' in resolution) return resolution.response
      return Response.json({ interactions: [], unavailable: resolution.unavailable })
    }
    const result = await listSessionInteractions(resolution.connection)
    if (!result.succeeded) {
      logger.warn('[interactions] list failed:', result.error)
      return Response.json({ interactions: [], unavailable: result.error.code })
    }
    return Response.json({ interactions: result.value })
  }

  async function answer(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const validation = validateInteractionAnswerBody(body)
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

    const resolution = await options.resolveConnection({ request, intent: 'answer', body })
    if (!resolution.ok) {
      if ('response' in resolution) return resolution.response
      return mapInteractionRespondFailure(
        { code: resolution.unavailable, message: 'sandbox runtime unavailable', status: 0 },
        logger,
      )
    }
    const connection = resolution.connection
    const answerPayload = {
      outcome: validation.outcome,
      ...(validation.data ? { data: validation.data } : {}),
    }

    // Snapshot the answered ask's content signature BEFORE resolving it, so any
    // content-identical duplicates still outstanding afterwards (the agent may
    // have re-emitted the same question N times) can be answered the same way.
    const before = await listSessionInteractions(connection)
    const answeredRequest = before.succeeded ? before.value.find((item) => item.id === validation.id) : undefined
    const answeredSignature = answeredRequest
      ? questionInteractionContentSignature(interactionFromWireRequest(answeredRequest))
      : null

    const result = await respondToSessionInteraction(connection, { id: validation.id, ...answerPayload })
    if (!result.succeeded) return mapInteractionRespondFailure(result.error, logger)

    let remaining = await listSessionInteractions(connection)
    if (remaining.succeeded && answeredSignature) {
      const duplicateRequests = remaining.value.filter((item) => {
        if (item.id === validation.id) return false
        return questionInteractionContentSignature(interactionFromWireRequest(item)) === answeredSignature
      })
      for (const duplicate of duplicateRequests) {
        const duplicateResult = await respondToSessionInteraction(connection, { id: duplicate.id, ...answerPayload })
        if (!duplicateResult.succeeded) break
      }
      if (duplicateRequests.length > 0) remaining = await listSessionInteractions(connection)
    }

    // Prove the run actually unblocked: neither the answered id nor any
    // content-duplicate may still be outstanding. If one is, the sidecar
    // accepted the POST but did not release the run — report it rather than
    // tell the user it was answered.
    if (remaining.succeeded && remaining.value.some((item) => item.id === validation.id || (
      answeredSignature && questionInteractionContentSignature(interactionFromWireRequest(item)) === answeredSignature
    ))) {
      logger.error('[interactions] respond returned ok but interaction is still pending:', {
        sessionId: connection.sessionId,
        interactionId: validation.id,
      })
      return Response.json(
        { code: 'INTERACTION_STILL_PENDING', error: 'The agent did not accept the answer. Try answering again.' },
        { status: 503 },
      )
    }

    return Response.json({ ok: true })
  }

  return { list, answer }
}
