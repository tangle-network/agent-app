import { describe, expect, it, vi } from 'vitest'

import {
  createInteractionAnswerRoute,
  listSessionInteractions,
  mapInteractionRespondFailure,
  respondToSessionInteraction,
  validateInteractionAnswerBody,
  type BeforeInteractionAnswerArgs,
  type InteractionConnectionResolution,
  type InteractionRequestWire,
  type SidecarInteractionsConnection,
} from '../src/interactions/index'

// ── fake sidecar ─────────────────────────────────────────────────────────────
// In-memory stand-in for the sandbox sidecar's
// `/agents/sessions/{id}/interactions` registry: GET lists outstanding asks,
// POST resolves one. Configurable so tests can exercise the failure contract
// (404 gone, 400 invalid answer, 501 unsupported, accepted-but-not-released).

function wireQuestion(id: string, overrides: Partial<InteractionRequestWire> = {}): InteractionRequestWire {
  return {
    id,
    kind: 'question',
    title: 'Which tone do you prefer?',
    answerSpec: {
      fields: [{
        type: 'select',
        name: 'q0',
        label: 'Which tone do you prefer?',
        required: true,
        multi: false,
        options: [
          { value: 'Formal', label: 'Formal' },
          { value: 'Casual', label: 'Casual' },
        ],
      }],
    },
    ...overrides,
  } as InteractionRequestWire
}

interface FakeSidecarOptions {
  /** Keep the ask outstanding even after a 200 respond (wedged broker). */
  respondWithoutReleasing?: boolean
  /** Force every POST to this error payload. */
  respondError?: { status: number; code: string; message: string }
  /** Force every GET to this raw response. */
  listResponse?: { status: number; body: string }
  expectedBearer?: string
}

function fakeSidecar(initial: InteractionRequestWire[], options: FakeSidecarOptions = {}) {
  const outstanding = new Map(initial.map((request) => [request.id, request]))
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; authorization: string | null }> = []

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const authorization = new Headers(init?.headers).get('authorization')
    calls.push({ method, url, ...(body ? { body } : {}), authorization })

    if (options.expectedBearer && authorization !== `Bearer ${options.expectedBearer}`) {
      return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad bearer' } }), { status: 401 })
    }
    if (method === 'GET') {
      if (options.listResponse) return new Response(options.listResponse.body, { status: options.listResponse.status })
      return Response.json({ data: { interactions: [...outstanding.values()] } })
    }
    if (options.respondError) {
      const { status, code, message } = options.respondError
      return new Response(JSON.stringify({ error: { code, message } }), { status })
    }
    const id = String(body?.id ?? '')
    if (!outstanding.has(id)) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'interaction not found' } }), { status: 404 })
    }
    if (!options.respondWithoutReleasing) outstanding.delete(id)
    return Response.json({ data: { ok: true } })
  }) as typeof fetch

  return { fetchImpl, calls, outstanding }
}

function connectionFor(sidecar: { fetchImpl: typeof fetch }, overrides: Partial<SidecarInteractionsConnection> = {}): SidecarInteractionsConnection {
  return {
    runtimeUrl: 'https://box.example/runtime/',
    authToken: 'tc_sidecar-bearer-123456789',
    sessionId: 'session-1',
    fetchImpl: sidecar.fetchImpl,
    ...overrides,
  }
}

function routeFor(
  sidecar: { fetchImpl: typeof fetch },
  overrides: Partial<SidecarInteractionsConnection> = {},
): ReturnType<typeof createInteractionAnswerRoute> {
  return createInteractionAnswerRoute({
    resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar, overrides) }),
    logger: { warn: vi.fn(), error: vi.fn() },
  })
}

function answerRequest(body: unknown): Request {
  return new Request('https://app.example/api/chat/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const LIST_REQUEST = new Request('https://app.example/api/chat/interactions')

// ── sidecar client ───────────────────────────────────────────────────────────

describe('sidecar interactions client', () => {
  it('lists outstanding asks with the bearer against the session URL (trailing slash trimmed)', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')], { expectedBearer: 'tc_sidecar-bearer-123456789' })
    const result = await listSessionInteractions(connectionFor(sidecar))
    expect(result).toEqual({ succeeded: true, value: [wireQuestion('ask-1')] })
    expect(sidecar.calls[0]?.url).toBe('https://box.example/runtime/agents/sessions/session-1/interactions')
    expect(sidecar.calls[0]?.authorization).toBe('Bearer tc_sidecar-bearer-123456789')
  })

  it('URL-encodes the session id', async () => {
    const sidecar = fakeSidecar([])
    await listSessionInteractions(connectionFor(sidecar, { sessionId: 'thread/7 x' }))
    expect(sidecar.calls[0]?.url).toBe('https://box.example/runtime/agents/sessions/thread%2F7%20x/interactions')
  })

  it('maps an unreachable sidecar to UPSTREAM_UNREACHABLE with status 0 and redacts bearers from the message', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect failed for Bearer tc_sidecar-bearer-123456789')
    }) as typeof fetch
    const result = await listSessionInteractions(connectionFor({ fetchImpl }))
    expect(result.succeeded).toBe(false)
    if (result.succeeded) throw new Error('unreachable')
    expect(result.error).toMatchObject({ code: 'UPSTREAM_UNREACHABLE', status: 0 })
    expect(result.error.message).not.toContain('tc_sidecar-bearer-123456789')
    expect(result.error.message).toContain('Bearer [redacted]')
  })

  it('maps a non-JSON error body (proxy 502 page) to UPSTREAM_ERROR with the status', async () => {
    const sidecar = fakeSidecar([], { listResponse: { status: 502, body: '<html>Bad Gateway</html>' } })
    const result = await listSessionInteractions(connectionFor(sidecar))
    expect(result).toMatchObject({ succeeded: false, error: { code: 'UPSTREAM_ERROR', status: 502 } })
  })

  it('fails loud on a 200 list without an interactions array', async () => {
    const sidecar = fakeSidecar([], { listResponse: { status: 200, body: JSON.stringify({ data: {} }) } })
    const result = await listSessionInteractions(connectionFor(sidecar))
    expect(result).toMatchObject({ succeeded: false, error: { code: 'MALFORMED_RESPONSE', status: 200 } })
  })

  it('POSTs { id, outcome, data } and treats 2xx as success', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const result = await respondToSessionInteraction(connectionFor(sidecar), {
      id: 'ask-1',
      outcome: 'accepted',
      data: { q0: ['Formal'] },
    })
    expect(result).toEqual({ succeeded: true, value: undefined })
    expect(sidecar.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } },
    })
  })
})

// ── body validation ──────────────────────────────────────────────────────────

describe('validateInteractionAnswerBody', () => {
  it('accepts { id, outcome } with primitive and string-array field values', () => {
    expect(validateInteractionAnswerBody({
      id: 'ask-1',
      outcome: 'accepted',
      data: { q0: ['Formal'], note: 'hi', count: 2, sure: true },
    })).toEqual({
      ok: true,
      id: 'ask-1',
      outcome: 'accepted',
      data: { q0: ['Formal'], note: 'hi', count: 2, sure: true },
    })
  })

  it.each([
    [{ outcome: 'accepted' }, 'Missing interaction id'],
    [{ id: 'ask-1', outcome: 'cancelled' }, 'Invalid outcome: expected accepted or declined'],
    [{ id: 'ask-1', outcome: 'accepted', data: ['nope'] }, 'Invalid data: expected an object of field values'],
    [{ id: 'ask-1', outcome: 'accepted', data: { 'bad key!': 'x' } }, 'Invalid data: field names must contain only letters, numbers, underscores, or hyphens'],
    [{ id: 'ask-1', outcome: 'accepted', data: { q0: { nested: true } } }, 'Invalid data: field values must be strings, numbers, booleans, or string arrays'],
    [{ id: 'ask-1', outcome: 'accepted', data: { q0: [1, 2] } }, 'Invalid data: field values must be strings, numbers, booleans, or string arrays'],
  ])('rejects %j', (body, error) => {
    expect(validateInteractionAnswerBody(body as Record<string, unknown>)).toEqual({ ok: false, error })
  })

  it('rejects prototype-pollution field keys', () => {
    const body = JSON.parse('{"id":"ask-1","outcome":"accepted","data":{"__proto__":"x"}}') as Record<string, unknown>
    expect(validateInteractionAnswerBody(body)).toMatchObject({ ok: false })
  })
})

// ── route factory: list ──────────────────────────────────────────────────────

describe('createInteractionAnswerRoute list', () => {
  it('returns the sidecar registry for the resolved session', async () => {
    const route = routeFor(fakeSidecar([wireQuestion('ask-1')]))
    const response = await route.list(LIST_REQUEST)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ interactions: [wireQuestion('ask-1')] })
  })

  it('short-circuits with the resolver-authored response (auth stays a product concern)', async () => {
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
    })
    const response = await route.list(LIST_REQUEST)
    expect(response.status).toBe(401)
  })

  it('returns an empty list with the unavailable code when the runtime is not resolvable', async () => {
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: false, unavailable: 'SANDBOX_NOT_RUNNING' }),
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    expect(await (await route.list(LIST_REQUEST)).json()).toEqual({ interactions: [], unavailable: 'SANDBOX_NOT_RUNNING' })
  })

  it('degrades to an empty list (never a 5xx) when the sidecar list fails', async () => {
    const warn = vi.fn()
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({
        ok: true,
        connection: connectionFor({ fetchImpl: (async () => { throw new Error('boom') }) as typeof fetch }),
      }),
      logger: { warn, error: vi.fn() },
    })
    const response = await route.list(LIST_REQUEST)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ interactions: [], unavailable: 'UPSTREAM_UNREACHABLE' })
    expect(warn).toHaveBeenCalledOnce()
  })
})

// ── route factory: answer ────────────────────────────────────────────────────

describe('createInteractionAnswerRoute answer', () => {
  it('resolves one ask against the sidecar and verifies the run unblocked', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const route = routeFor(sidecar)
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(sidecar.outstanding.size).toBe(0)
    // list-before (signature snapshot) → respond → list-after (unblock proof)
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET'])
  })

  it('answers content-identical duplicate asks with the same answer', async () => {
    const sidecar = fakeSidecar([
      wireQuestion('ask-1'),
      wireQuestion('ask-2'), // re-emitted duplicate: same content, new id
      wireQuestion('ask-3', { title: 'A different question' }),
    ])
    const route = routeFor(sidecar)
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(200)
    expect([...sidecar.outstanding.keys()]).toEqual(['ask-3'])
    const posts = sidecar.calls.filter((call) => call.method === 'POST')
    expect(posts.map((call) => call.body)).toEqual([
      { id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } },
      { id: 'ask-2', outcome: 'accepted', data: { q0: ['Formal'] } },
    ])
  })

  it('runs beforeAnswer with the authoritative snapshot before any answer POST', async () => {
    const sidecar = fakeSidecar([
      wireQuestion('ask-1'),
      wireQuestion('ask-2'),
      wireQuestion('ask-3', { title: 'Different' }),
    ])
    const beforeAnswer = vi.fn(async (args: BeforeInteractionAnswerArgs) => {
      expect(sidecar.calls.map((call) => call.method)).toEqual(['GET'])
      expect(args.answer).toEqual({
        ok: true,
        id: 'ask-1',
        outcome: 'accepted',
        data: { q0: ['Formal'] },
      })
      expect(args.body).toMatchObject({ workspaceId: 'ws-1' })
      expect(args.outstanding.map((item) => item.id)).toEqual(['ask-1', 'ask-2', 'ask-3'])
      expect(args.answeredRequest?.id).toBe('ask-1')
      expect(args.duplicateRequests.map((item) => item.id)).toEqual(['ask-2'])
      expect(args.connection.sessionId).toBe('session-1')
    })
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      beforeAnswer,
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const response = await route.answer(answerRequest({
      id: 'ask-1',
      outcome: 'accepted',
      data: { q0: ['Formal'] },
      workspaceId: 'ws-1',
    }))
    expect(response.status).toBe(200)
    expect(beforeAnswer).toHaveBeenCalledOnce()
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'POST', 'GET'])
  })

  it('does not answer or unblock when beforeAnswer fails', async () => {
    const error = vi.fn()
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      beforeAnswer: async () => { throw new Error('storage unavailable') },
      logger: { warn: vi.fn(), error },
    })

    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'INTERACTION_BEFORE_ANSWER_FAILED',
      error: 'Could not save the answer. Try again.',
    })
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET'])
    expect(sidecar.outstanding.has('ask-1')).toBe(true)
    expect(error).toHaveBeenCalledOnce()
  })

  it('settles durable answers only after sidecar acknowledgement', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const order: string[] = []
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      durable: {
        guarantee: 'reconciled',
        prepare: async () => { order.push('prepare'); return { intentKey: 'intent-1' } },
        reconcile: async () => ({ settled: false }),
        acknowledge: async () => { order.push('acknowledge') },
        finalize: async () => { order.push('finalize') },
      },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const response = await route.answer(answerRequest({
      id: 'ask-1',
      outcome: 'accepted',
      data: { q0: ['Formal'] },
      attemptKey: 'attempt-1',
    }))
    expect(response.status).toBe(200)
    expect(order).toEqual(['prepare', 'acknowledge', 'finalize'])
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET'])
  })

  it('requires an attempt key only when durable settlement is enabled', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      durable: {
        guarantee: 'reconciled',
        prepare: async () => ({}),
        reconcile: async () => ({ settled: false }),
        acknowledge: async () => {},
        finalize: async () => {},
      },
    })
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted' }))
    expect(response.status).toBe(400)
    expect(sidecar.calls).toEqual([])
  })

  it('reattaches an ambiguous retry through durable reconciliation', async () => {
    const sidecar = fakeSidecar([])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      durable: {
        guarantee: 'reconciled',
        prepare: async () => ({ intentKey: 'intent-1' }),
        reconcile: async () => ({ settled: true }),
        acknowledge: async () => {},
        finalize: async () => {},
      },
    })
    const response = await route.answer(answerRequest({
      id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] }, attemptKey: 'attempt-1',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, idempotent: true })
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('keeps an unresolved durable retry retryable instead of expiring it', async () => {
    const sidecar = fakeSidecar([])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      durable: {
        guarantee: 'reconciled',
        prepare: async () => ({ intentKey: 'intent-1' }),
        reconcile: async () => ({ settled: false }),
        acknowledge: async () => {},
        finalize: async () => {},
      },
    })
    const response = await route.answer(answerRequest({
      id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] }, attemptKey: 'attempt-1',
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_RECONCILIATION_PENDING' })
  })

  it('returns retryable 503 after acknowledgement when durable finalization fails', async () => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      durable: {
        guarantee: 'reconciled',
        prepare: async () => ({}),
        reconcile: async () => ({ settled: false }),
        acknowledge: async () => {},
        finalize: async () => { throw new Error('db unavailable') },
      },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const response = await route.answer(answerRequest({
      id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] }, attemptKey: 'attempt-1',
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_FINALIZE_FAILED' })
  })

  it('does not run beforeAnswer or POST when the authoritative snapshot fails', async () => {
    const beforeAnswer = vi.fn()
    const sidecar = fakeSidecar([wireQuestion('ask-1')], {
      listResponse: { status: 502, body: '<html>Bad Gateway</html>' },
    })
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      beforeAnswer,
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(503)
    expect(beforeAnswer).not.toHaveBeenCalled()
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('does not persist or POST when the interaction is absent from the authoritative snapshot', async () => {
    const beforeAnswer = vi.fn()
    const sidecar = fakeSidecar([])
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      beforeAnswer,
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(410)
    expect(beforeAnswer).not.toHaveBeenCalled()
    expect(sidecar.calls.map((call) => call.method)).toEqual(['GET'])
  })

  it.each([
    ['no JSON body', 'not-json', 'Invalid JSON body'],
    ['missing id', { outcome: 'accepted' }, 'Missing interaction id'],
    ['bad outcome', { id: 'ask-1', outcome: 'cancelled' }, 'Invalid outcome: expected accepted or declined'],
  ])('rejects %s with a 400 before touching the sidecar', async (_name, body, error) => {
    const sidecar = fakeSidecar([wireQuestion('ask-1')])
    const route = routeFor(sidecar)
    const response = await route.answer(answerRequest(body))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
    expect(sidecar.calls).toEqual([])
  })

  it('maps a sidecar 404 (ask already gone) to 410 INTERACTION_EXPIRED', async () => {
    const route = routeFor(fakeSidecar([wireQuestion('ask-1')], {
      respondError: { status: 404, code: 'NOT_FOUND', message: 'interaction not found' },
    }))
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_EXPIRED' })
  })

  it('maps INVALID_INTERACTION_ANSWER to a retryable 400 the card renders inline', async () => {
    const route = routeFor(fakeSidecar([wireQuestion('ask-1')], {
      respondError: { status: 400, code: 'INVALID_INTERACTION_ANSWER', message: 'answer does not match answerSpec' },
    }))
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: 'free text' } }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INTERACTION_ANSWER' })
  })

  it('maps a 501 backend to INTERACTIONS_UNSUPPORTED', async () => {
    const route = routeFor(fakeSidecar([wireQuestion('ask-1')], {
      respondError: { status: 501, code: 'NOT_IMPLEMENTED', message: 'no interaction channel' },
    }))
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ code: 'INTERACTIONS_UNSUPPORTED' })
  })

  it('maps any other sidecar failure to a 503 without leaking the upstream error', async () => {
    const route = routeFor(fakeSidecar([wireQuestion('ask-1')], {
      respondError: { status: 500, code: 'INTERNAL', message: 'stack trace with Bearer tc_sidecar-bearer-123456789' },
    }))
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(503)
    const payload = await response.json() as { code: string; error: string }
    expect(payload).toEqual({ code: 'INTERACTION_UPSTREAM_FAILED', error: 'Could not reach the agent. Try again.' })
  })

  it('fails loud with 503 INTERACTION_STILL_PENDING when the sidecar accepted but did not release the ask', async () => {
    const errorLog = vi.fn()
    const sidecar = fakeSidecar([wireQuestion('ask-1')], { respondWithoutReleasing: true })
    const route = createInteractionAnswerRoute({
      resolveConnection: async () => ({ ok: true, connection: connectionFor(sidecar) }),
      logger: { warn: vi.fn(), error: errorLog },
    })
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'accepted', data: { q0: ['Formal'] } }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'INTERACTION_STILL_PENDING',
      error: 'The agent did not accept the answer. Try answering again.',
    })
    expect(errorLog).toHaveBeenCalledWith(
      '[interactions] respond returned ok but interaction is still pending:',
      { sessionId: 'session-1', interactionId: 'ask-1' },
    )
  })

  it('maps a resolver unavailable verdict to the 503 contract (not an empty list)', async () => {
    const route = createInteractionAnswerRoute({
      resolveConnection: async (args) => {
        expect(args.intent).toBe('answer')
        expect(args.body).toMatchObject({ id: 'ask-1' })
        return { ok: false, unavailable: 'SANDBOX_NOT_RUNNING' } satisfies InteractionConnectionResolution
      },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const response = await route.answer(answerRequest({ id: 'ask-1', outcome: 'declined' }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_UPSTREAM_FAILED' })
  })
})

describe('mapInteractionRespondFailure', () => {
  it('never surfaces a raw upstream status: every mapped response is client-actionable', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const statuses = await Promise.all([404, 400, 409, 500, 501, 0].map(async (status) => {
      const response = mapInteractionRespondFailure({ code: 'X', message: 'y', status }, logger)
      return response.status
    }))
    expect(statuses).toEqual([410, 503, 503, 503, 501, 503])
  })
})
