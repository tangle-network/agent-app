import { describe, expect, it } from 'vitest'

import {
  createSandboxChatProducer,
  streamWithModelFailover,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { isUpstreamUnavailable, readHttpStatusHint } from '../../src/model-resolution/failover'
import { createOpenAICompatStreamTurn } from '../../src/runtime/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

/**
 * The failure class the ROUTER STRUCTURALLY CANNOT RESCUE.
 *
 * Router-side failover lives inside the origin. A Cloudflare EDGE 502 never
 * reaches the origin — the router's own code does not execute — so nothing
 * upstream of the browser can fall over. The only layer that can is a client
 * OUTSIDE the edge, which is `streamWithModelFailover` / `runWithModelFailover`.
 *
 * VERBATIM capture, `POST https://router.tangle.tools/v1/chat/completions`,
 * model `gemini-2.5-flash`, 2026-07-27 17:48:12 GMT. During that window the
 * model returned 41/41 edge 502s while `gemini-2.5-flash-lite` returned 41/41
 * 200s from the same client, same key, same second — so this is a live upstream
 * flap, not a bad request. Headers and body are reproduced byte-for-byte
 * below; note what is NOT here:
 *
 *   - No reason phrase. HTTP/2 does not carry one, so the string "Bad Gateway"
 *     never appears — the shipped classifier's `'bad gateway'` message fragment
 *     could not match, and did not.
 *   - No JSON. `content-type: text/plain; charset=UTF-8`, 16 bytes.
 *   - No `x-tangle-*` headers at all. A healthy 200 from the same endpoint in
 *     the same minute carried nine (`x-tangle-cache`, `x-tangle-price-input`,
 *     `x-tangle-prompt-cache-provider`, …). Zero is the proof the origin never
 *     ran.
 */
const EDGE_502_HEADERS: Record<string, string> = {
  date: 'Mon, 27 Jul 2026 17:48:12 GMT',
  'content-type': 'text/plain; charset=UTF-8',
  'cache-control': 'private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0',
  expires: 'Thu, 01 Jan 1970 00:00:01 GMT',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
  'expect-ct': 'max-age=86400, enforce',
  'x-content-type-options': 'nosniff',
  'x-xss-protection': '1; mode=block',
  server: 'cloudflare',
  'cf-ray': 'a21d793899f6cef3-DEN',
  'alt-svc': 'h3=":443"; ma=86400',
}
/** 16 bytes, trailing newline included — `xxd` of the captured body. */
const EDGE_502_BODY = 'error code: 502\n'

function edge502Response(): Response {
  return new Response(EDGE_502_BODY, { status: 502, headers: EDGE_502_HEADERS })
}

/**
 * The router's genuine 400 for the same endpoint — a REQUEST bug, not an
 * outage. Verbatim shape from tangle-router #296: the OpenRouter-style
 * `reasoning: {}` object leaking through the passthrough allowlist. This is the
 * control: it must surface to the caller, never walk the fallback chain, since
 * it fails identically on every model.
 */
const REAL_400_BODY = JSON.stringify({
  error: { message: "Unknown parameter: 'reasoning'.", type: 'invalid_request_error', param: 'reasoning', code: 'unknown_parameter' },
})

function badRequestResponse(): Response {
  return new Response(REAL_400_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
}

/** Drive the real OpenAI-compat client against a canned response and return
 *  whatever it throws — the exact object a product's failover would classify. */
async function thrownBy(response: () => Response): Promise<unknown> {
  const stream = createOpenAICompatStreamTurn({
    baseUrl: 'https://router.tangle.tools/v1',
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
    fetchImpl: (async () => response()) as unknown as typeof fetch,
  })
  try {
    for await (const _event of stream([{ role: 'user', content: 'say ok' }])) void _event
    return null
  } catch (err) {
    return err
  }
}

/** The verbatim healthy sequence a real box emits, abridged to shape-bearing
 *  events (same capture the sibling failover test replays). */
const HEALTHY_SEQUENCE: Array<Record<string, unknown>> = [
  { type: 'start', data: { id: 'exec-1', identifier: 'default' }, id: '1' },
  { type: 'status', data: { status: 'generating_response' }, id: '2' },
  { type: 'message.part.updated', data: { part: { id: 'p1', type: 'text', text: '' } }, id: '3' },
  { type: 'message.part.updated', data: { part: { id: 'p1', type: 'text', text: 'ok' }, delta: 'ok' }, id: '4' },
  {
    type: 'message.part.updated',
    data: { part: { id: 'p2', type: 'step-finish', reason: 'stop', tokens: { total: 1154, input: 1144, output: 10, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 } },
    id: '5',
  },
  {
    type: 'result',
    data: {
      outcome: { type: 'completed' },
      finalText: 'ok',
      toolInvocations: [],
      tokenUsage: { inputTokens: 1144, outputTokens: 10, totalTokens: 1154, reasoningTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cost: 0 },
    },
    id: '6',
  },
  { type: 'done', data: { requestId: 'exec-1', outcome: { type: 'completed' } }, id: '7' },
]

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

async function collect(source: AsyncGenerator<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of source) out.push(event as Record<string, unknown>)
  return out
}

describe('readHttpStatusHint — a status stated in prose, not in a field', () => {
  it('reads the status out of every form a real producer emits', () => {
    // Cloudflare's edge body, verbatim.
    expect(readHttpStatusHint(EDGE_502_BODY)).toBe(502)
    // src/runtime/openai-stream.ts
    expect(readHttpStatusHint('OpenAI-compat stream failed (HTTP 502): error code: 502')).toBe(502)
    // src/runtime/model-catalog.ts
    expect(readHttpStatusHint('Router /models returned 503')).toBe(503)
    // src/turn-stream/adapters.ts
    expect(readHttpStatusHint('turn-stream lock acquire failed with status 504')).toBe(504)
    // An HTTP/1.1 status line still works — this is the form that DID match before.
    expect(readHttpStatusHint('502 Bad Gateway')).toBe(502)
    // And the client-error side is read just as precisely.
    expect(readHttpStatusHint('OpenAI-compat stream failed (HTTP 400): bad schema')).toBe(400)
  })

  it('does not mistake a token count or a duration for a status', () => {
    expect(readHttpStatusHint('generation used 502341 tokens')).toBeUndefined()
    expect(readHttpStatusHint('gateway timed out after 504000 ms')).toBeUndefined()
    expect(readHttpStatusHint('model gpt-5.5 is not available')).toBeUndefined()
  })
})

describe('the classifier vs a VERBATIM Cloudflare edge 502', () => {
  it('classifies the raw edge body as an outage — no JSON, no reason phrase, no numeric field', () => {
    // This is the shape a foreign producer (a harness, an SDK, a proxy) hands
    // over: prose only. agent-app cannot stamp a status onto someone else's
    // error, so the classifier itself has to read it.
    expect(isUpstreamUnavailable(new Error(EDGE_502_BODY))).toBe(true)
    expect(isUpstreamUnavailable({ message: `upstream request failed: ${EDGE_502_BODY}` })).toBe(true)
    expect(isUpstreamUnavailable({ error: { message: `edge rejected the request: ${EDGE_502_BODY}` } })).toBe(true)
  })

  it('classifies what the REAL OpenAI-compat client throws for the captured response', async () => {
    const err = await thrownBy(edge502Response)
    expect(err).toBeInstanceOf(Error)
    // Pinned to the capture: the message really does carry the edge body.
    expect((err as Error).message).toContain('error code: 502')
    // The numeric status is stamped by openai-stream.ts, so this path never
    // depends on prose at all…
    expect((err as { status?: number }).status).toBe(502)
    // …and either way the verdict is the same: try another model.
    expect(isUpstreamUnavailable(err)).toBe(true)
  })

  it('CONTROL: the router\'s genuine 400 still surfaces — a request bug is not an outage', async () => {
    const err = await thrownBy(badRequestResponse)
    expect((err as Error).message).toContain("Unknown parameter: 'reasoning'")
    expect(isUpstreamUnavailable(err)).toBe(false)
  })

  it('CONTROL: an explicit 4xx is decisive even when its body borrows outage words', () => {
    // Belt and braces on the rule the fix must not weaken: a stated client
    // error wins over the message-fragment list.
    expect(isUpstreamUnavailable(new Error('HTTP 400: model reports it is overloaded with this schema'))).toBe(false)
    expect(isUpstreamUnavailable(new Error('OpenAI-compat stream failed (HTTP 422): content filter triggered'))).toBe(false)
    // 429 is a capacity signal, not a request bug — it stays an outage.
    expect(isUpstreamUnavailable(new Error('OpenAI-compat stream failed (HTTP 429)'))).toBe(true)
  })

  it('a 404 for a MODEL still fails over — "not found" is model-scoped, not request-scoped', () => {
    // The trap in "any 4xx is decisive": a model this endpoint cannot find may
    // be perfectly available as the next entry in the chain, so 404 is
    // deliberately NOT in the request-error set.
    expect(isUpstreamUnavailable(new Error('OpenAI-compat stream failed (HTTP 404): Model not found'))).toBe(true)
    // …while a genuine request error at 400/401/403/422 still surfaces.
    for (const status of [400, 401, 403, 422]) {
      expect(
        isUpstreamUnavailable(new Error(`OpenAI-compat stream failed (HTTP ${status}): request rejected`)),
        `HTTP ${status} must surface, not walk the chain`,
      ).toBe(false)
    }
  })
})

describe('streamWithModelFailover rescues an edge 502', () => {
  it('abandons the model whose edge 502d and serves the next one', async () => {
    const opened: string[] = []
    const edgeError = new Error(`OpenAI-compat stream failed (HTTP 502): ${EDGE_502_BODY}`)

    const handle = streamWithModelFailover({
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      open: ({ model }) => {
        opened.push(model)
        if (model === 'gemini-2.5-flash') {
          return (async function* (): AsyncGenerator<unknown> {
            throw edgeError
          })()
        }
        return feed(HEALTHY_SEQUENCE)
      },
    })

    const events = await collect(handle.events)

    expect(opened).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
    expect(handle.servingModel()).toBe('gemini-2.5-flash-lite')
    expect(handle.usedFallback()).toBe(true)
    expect(handle.attempts()[0]).toMatchObject({ model: 'gemini-2.5-flash', ok: false })
    expect(handle.attempts()[0]?.reason).toContain('error code: 502')
    expect(events).toEqual(HEALTHY_SEQUENCE)
  })

  it('rescues the edge 502 delivered as a RESOLVED terminal error too, not only a throw', async () => {
    // A worker that already read the response and folded it into a terminal
    // event rather than throwing. Same bytes, different carrier.
    const terminal = { type: 'error', data: { message: `router edge rejected the turn: ${EDGE_502_BODY}` }, id: '9' }
    const opened: string[] = []
    const handle = streamWithModelFailover({
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      open: ({ model }) => {
        opened.push(model)
        return feed(model === 'gemini-2.5-flash' ? [terminal] : HEALTHY_SEQUENCE)
      },
    })

    const events = await collect(handle.events)
    expect(opened).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
    expect(handle.servingModel()).toBe('gemini-2.5-flash-lite')
    // Nothing from the dead attempt leaks into the transcript.
    expect(events.some((e) => JSON.stringify(e).includes('error code: 502'))).toBe(false)
  })
})

describe('the money guards — what the rescue must NOT do', () => {
  it('does NOT fail over once a real token has reached the client', async () => {
    // The edge can 502 mid-stream (a dropped upstream connection after the
    // answer started). Restarting on another model would duplicate the answer
    // and bill the customer twice, so the failure has to SURFACE instead.
    const opened: string[] = []
    const committed = HEALTHY_SEQUENCE[3]! // the first real token, `delta: 'ok'`
    const lateEdge502 = { type: 'error', data: { message: `stream severed: ${EDGE_502_BODY}` }, id: '99' }

    const handle = streamWithModelFailover({
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      open: ({ model }) => {
        opened.push(model)
        return feed([HEALTHY_SEQUENCE[0]!, committed, lateEdge502])
      },
    })

    const events = await collect(handle.events)

    expect(opened).toEqual(['gemini-2.5-flash'])
    expect(handle.usedFallback()).toBe(false)
    // The error is delivered to the client, not swallowed by a silent retry.
    expect(events).toContainEqual(lateEdge502)
  })

  it('never bills an abandoned attempt: its usage receipt reaches neither the consumer nor onTurnComplete', async () => {
    const { createChatTurnRoutes } = await import('../../src/chat-routes/index')
    // The dead attempt emits a FULL step-finish receipt (9,999 in / 8,888 out)
    // before its edge 502 — a real upstream can bill for a partial generation.
    // Those tokens must be discarded with the stream.
    const deadWithUsage: Array<Record<string, unknown>> = [
      { type: 'start', data: { id: 'dead-exec' }, id: '1' },
      {
        type: 'message.part.updated',
        data: { part: { id: 'dp', type: 'step-finish', reason: 'error', tokens: { total: 18887, input: 9999, output: 8888, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.42 } },
        id: '2',
      },
      { type: 'error', data: { message: `router edge rejected the turn: ${EDGE_502_BODY}` }, id: '3' },
    ]

    const rows: Array<Record<string, unknown>> = []
    const store = {
      listMessages: async () => [],
      appendMessage: async (input: Record<string, unknown>) => {
        rows.push(input)
        return { id: `m${rows.length}`, ...input }
      },
    }
    let receipt: Record<string, unknown> | undefined
    const pending: Promise<unknown>[] = []

    const routes = createChatTurnRoutes({
      projectId: 'edge-502-billing',
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'u-1', context: undefined }),
      store: store as unknown as ChatTurnMessageStore,
      turnStore: createMemoryTurnEventStore(),
      produce: () =>
        createSandboxChatProducer({
          model: 'gemini-2.5-flash',
          fallbackModels: ['gemini-2.5-flash-lite'],
          openEvents: ({ model }) => feed(model === 'gemini-2.5-flash' ? deadWithUsage : HEALTHY_SEQUENCE),
          log: () => {},
        }),
      onTurnComplete: async (input) => {
        receipt = input as unknown as Record<string, unknown>
      },
      log: () => {},
    })

    const res = await routes.turn(
      new Request('http://app.test/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 't-edge-502', content: 'q?' }),
      }),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    )
    const wire = await new Response(res.body!).text()
    await Promise.all(pending)

    // The turn completed on the fallback.
    const assistant = rows.find((r) => r.role === 'assistant')
    expect(assistant?.content).toBe('ok')
    expect(assistant?.model).toBe('gemini-2.5-flash-lite')
    // Billing sees ONLY the fallback's receipt — the abandoned 9,999/8,888 and
    // its $0.42 are gone.
    expect(assistant?.inputTokens).toBe(1144)
    expect(assistant?.outputTokens).toBe(10)
    expect(receipt?.model).toBe('gemini-2.5-flash-lite')
    expect(JSON.stringify(receipt)).not.toContain('9999')
    expect(JSON.stringify(receipt)).not.toContain('8888')
    expect(JSON.stringify(receipt)).not.toContain('0.42')
    // And the dead attempt's own events never reached the client either — not
    // its execution, not its tokens, not its cost.
    expect(wire).not.toContain('dead-exec')
    expect(wire).not.toContain('9999')
    expect(wire).not.toContain('8888')
    expect(wire).not.toContain('0.42')
    // What DOES reach the client is the notice, and it carries the cause: the
    // edge 502 is named, so a downgrade is never mistaken for a normal turn.
    expect(wire).toContain('gemini-2.5-flash was unavailable')
    expect(wire).toContain('error code: 502')
    // The downgrade is still attributed, never silent.
    expect(receipt?.modelFailover).toMatchObject({
      model: 'gemini-2.5-flash-lite',
      usedFallback: true,
      attempts: [
        expect.objectContaining({ model: 'gemini-2.5-flash', ok: false }),
        { model: 'gemini-2.5-flash-lite', ok: true },
      ],
    })
  })
})
