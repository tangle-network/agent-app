/**
 * Fake sandbox sidecar for the vertical composition suite: ONE in-memory
 * interaction registry that BOTH halves of `/interactions` talk to —
 *
 *   - the producer half: the fake sandbox turn registers an ask via `ask()`
 *     and blocks on the returned promise (the broker semantics the real
 *     sidecar's InteractionBroker has);
 *   - the answer half: `createInteractionAnswerRoute` reaches the same
 *     registry through `connection.fetchImpl` (GET list / POST respond), so
 *     answering through the route genuinely releases the blocked turn.
 *
 * Answer validation is fail-closed like the real sidecar: an `accepted`
 * outcome must satisfy the ask's `answerSpec` (a select without `allowCustom`
 * only accepts listed option values; required fields must be present) or the
 * POST fails 400 INVALID_INTERACTION_ANSWER. Unknown ids fail 404.
 */

import type {
  ChatSelectField,
  InteractionData,
  InteractionRequestWire,
  SidecarInteractionsConnection,
} from '../../src/interactions/index'

export interface InteractionResolutionRecord {
  outcome: 'accepted' | 'declined'
  data?: InteractionData
}

interface Waiter {
  resolve: (resolution: InteractionResolutionRecord) => void
  promise: Promise<InteractionResolutionRecord>
}

function validateAcceptedAnswer(request: InteractionRequestWire, data: InteractionData | undefined): string | null {
  for (const field of request.answerSpec.fields) {
    const value = data?.[field.name]
    if (value === undefined) {
      if (field.required) return `missing required field ${field.name}`
      continue
    }
    if (field.type === 'select') {
      const select = field as ChatSelectField
      if (select.allowCustom === true) continue
      const values = Array.isArray(value) ? value : [String(value)]
      const allowed = new Set(select.options.map((option) => option.value))
      for (const candidate of values) {
        if (!allowed.has(String(candidate))) return `value ${String(candidate)} is not a listed option for ${field.name}`
      }
    }
  }
  return null
}

export interface FakeSidecarSession {
  /** Producer half: register an ask and get the broker promise the turn
   *  blocks on. */
  ask(request: InteractionRequestWire): Promise<InteractionResolutionRecord>
  /** Resolves when every currently-outstanding ask has been answered. */
  waitAll(): Promise<Map<string, InteractionResolutionRecord>>
  /** Asks still waiting for an answer (the sidecar registry view). */
  outstandingIds(): string[]
  /** How the answer route reaches this session. */
  connection: SidecarInteractionsConnection
  /** Every HTTP call the answer route made, for hostile-integrator asserts. */
  calls: Array<{ method: string; body?: Record<string, unknown> }>
}

export function createFakeSidecarSession(sessionId = 'session-vertical'): FakeSidecarSession {
  const outstanding = new Map<string, InteractionRequestWire>()
  const waiters = new Map<string, Waiter>()
  const resolutions = new Map<string, InteractionResolutionRecord>()
  const calls: FakeSidecarSession['calls'] = []

  function ask(request: InteractionRequestWire): Promise<InteractionResolutionRecord> {
    outstanding.set(request.id, request)
    let resolve!: Waiter['resolve']
    const promise = new Promise<InteractionResolutionRecord>((res) => {
      resolve = res
    })
    waiters.set(request.id, { resolve, promise })
    return promise
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, ...(body ? { body } : {}) })
    void input

    if (method === 'GET') {
      return Response.json({ data: { interactions: [...outstanding.values()] } })
    }

    const id = String(body?.id ?? '')
    const request = outstanding.get(id)
    if (!request) {
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'interaction not found' } }),
        { status: 404 },
      )
    }
    const outcome = body?.outcome === 'declined' ? 'declined' : 'accepted'
    const data = body?.data as InteractionData | undefined
    if (outcome === 'accepted') {
      const invalid = validateAcceptedAnswer(request, data)
      if (invalid) {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_INTERACTION_ANSWER', message: invalid } }),
          { status: 400 },
        )
      }
    }
    outstanding.delete(id)
    const resolution: InteractionResolutionRecord = { outcome, ...(data ? { data } : {}) }
    resolutions.set(id, resolution)
    waiters.get(id)?.resolve(resolution)
    waiters.delete(id)
    return Response.json({ data: { ok: true } })
  }) as typeof fetch

  return {
    ask,
    async waitAll() {
      await Promise.all([...waiters.values()].map((waiter) => waiter.promise))
      return new Map(resolutions)
    },
    outstandingIds: () => [...outstanding.keys()],
    connection: {
      runtimeUrl: 'https://box.vertical.test/runtime',
      authToken: 'tc_vertical-sidecar-bearer',
      sessionId,
      fetchImpl,
    },
    calls,
  }
}
