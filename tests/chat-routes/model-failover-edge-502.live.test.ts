/**
 * LIVE proof that the CLIENT rescues an edge 502 — the failure class the router
 * structurally cannot rescue.
 *
 * Router-side failover runs inside the origin. A Cloudflare edge 502 never
 * reaches the origin, so the router's own code does not execute and its
 * failover cannot fire. The evidence is in the headers: in the same run, the
 * healthy 200 carried TWELVE `x-tangle-*` headers and the 502 carried ZERO.
 * Only a client outside the edge can save that turn.
 *
 * Every request below is a real call to the real router. Nothing is replayed.
 *
 * MEASURED MATRIX, 2026-07-27 17:48–18:05 GMT, one client, one key:
 *
 *   model                  stream:true   stream:false
 *   gemini-2.5-flash       200 (5/5)     502 (5/5, and 134/134 over 20 min)
 *   gemini-2.5-pro         200           502
 *   gemini-2.5-flash-lite  200           200 (134/134)
 *   gpt-5-mini             200           200
 *
 * So the outage is DETERMINISTIC on the non-streaming path and absent on the
 * streaming one. That is why these tests call `/chat/completions` with
 * `stream: false` — it is where the 502 actually lives today, not a test
 * convenience. If a streaming flap appears, point `LIVE_EDGE_502_MODEL` at it.
 *
 * Two body variants were observed for the same 502, both with zero `x-tangle-*`
 * headers: a 16-byte `text/plain` body reading `error code: 502` (curl, cf-ray
 * a21d793899f6cef3-DEN) and Cloudflare's HTML error page (Node `fetch`, cf-ray
 * a21d8a507e42000f-ORD). Neither contains "Bad Gateway" — HTTP/2 carries no
 * reason phrase — which is exactly why the shipped message-fragment list
 * matched neither, and the customer got the error instead of an answer.
 *
 * Skipped unless `LIVE_ROUTER=1` and `TANGLE_ROUTER_API_KEY` are set. Note the
 * key name: a stale `TANGLE_INTELLIGENCE_API_KEY` in the shell outranks
 * `TANGLE_API_KEY` on some machines, so this reads an unambiguous variable.
 *
 *   LIVE_ROUTER=1 TANGLE_ROUTER_API_KEY=… \
 *     pnpm vitest run tests/chat-routes/model-failover-edge-502.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import { isUpstreamUnavailable, runWithModelFailover } from '../../src/model-resolution/failover'
import { createOpenAICompatStreamTurn } from '../../src/runtime/index'

const KEY = process.env.TANGLE_ROUTER_API_KEY ?? ''
const LIVE = process.env.LIVE_ROUTER === '1' && KEY.length > 0
const BASE = process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1'
const EDGING = process.env.LIVE_EDGE_502_MODEL ?? 'gemini-2.5-flash'
const HEALTHY = process.env.LIVE_HEALTHY_MODEL ?? 'gemini-2.5-flash-lite'

interface Probe {
  status: number
  body: string
  server: string | null
  cfRay: string | null
  tangleHeaderCount: number
}

async function call(model: string): Promise<{ res: Response; body: string }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }], max_tokens: 16, stream: false }),
  })
  return { res, body: await res.text().catch(() => '') }
}

function describeResponse(res: Response, body: string): Probe {
  let tangleHeaderCount = 0
  res.headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith('x-tangle-')) tangleHeaderCount += 1
  })
  return {
    status: res.status,
    body: body.slice(0, 120),
    server: res.headers.get('server'),
    cfRay: res.headers.get('cf-ray'),
    tangleHeaderCount,
  }
}

/**
 * One non-streaming turn. A non-ok response is shaped the way
 * `src/runtime/openai-stream.ts` shapes one — message with the status in prose,
 * plus the numeric `status` field — because that is the object a product's
 * failover actually classifies. The second test below pins that this shaping
 * really matches what that module throws for the same live request.
 */
async function completeOnce(model: string): Promise<string> {
  const { res, body } = await call(model)
  if (!res.ok) {
    const error = new Error(`OpenAI-compat stream failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
    Object.assign(error, { status: res.status })
    throw error
  }
  const json = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? ''
}

describe.skipIf(!LIVE)('LIVE: client-side rescue of a real Cloudflare edge 502', () => {
  it(
    'completes the turn on a fallback model, attributing the model that actually served',
    async () => {
      const started = Date.now()
      // Sample the preferred model until the edge 502 shows up. It is
      // intermittent, so one probe is not evidence either way.
      const probeAttempts = Number(process.env.LIVE_EDGE_502_ATTEMPTS ?? 6)
      let dead: Probe | undefined
      let servedProbes = 0
      for (let i = 0; i < probeAttempts && !dead; i += 1) {
        const attempt = await call(EDGING)
        const described = describeResponse(attempt.res, attempt.body)
        if (described.status >= 500) dead = described
        else servedProbes += 1
      }
      const aliveCall = await call(HEALTHY)
      const alive = describeResponse(aliveCall.res, aliveCall.body)
      console.log(`[live] ${EDGING} probes: served=${servedProbes} edge5xx=${dead ? 1 : 0} -> ${dead ? `${dead.status} server=${dead.server} cf-ray=${dead.cfRay} x-tangle-headers=${dead.tangleHeaderCount} body=${JSON.stringify(dead.body)}` : 'none captured'}`)
      console.log(`[live] ${HEALTHY} -> ${alive.status} cf-ray=${alive.cfRay} x-tangle-headers=${alive.tangleHeaderCount}`)

      // GUARD: a green run against a model that was actually serving proves
      // NOTHING. Fail loudly rather than report a fake success.
      if (!dead) {
        throw new Error(
          `${EDGING} served all ${probeAttempts} probes — no edge 5xx observed, so this run proves nothing. Re-probe and set LIVE_EDGE_502_MODEL to a model that is currently edging.`,
        )
      }

      // The structural claim, measured: the origin never ran on the failing
      // request, so no router-side failover could possibly have fired. The
      // healthy response from the SAME endpoint shows what an executed origin
      // stamps, which is what makes zero meaningful.
      expect(dead.server).toBe('cloudflare')
      expect(dead.tangleHeaderCount).toBe(0)
      expect(alive.status).toBe(200)
      expect(alive.tangleHeaderCount).toBeGreaterThan(0)

      // The flap is high-rate but NOT deterministic — the preferred model does
      // serve some requests. So run the real chain repeatedly and require at
      // least one observed rescue, reporting the rate. Every turn must produce
      // an answer either way; only the serving model varies.
      const rounds = Number(process.env.LIVE_EDGE_502_ROUNDS ?? 8)
      const fallbacks: Array<{ from: string; to: string }> = []
      let rescued = 0
      let servedByPreferred = 0
      let lastRescue: Awaited<ReturnType<typeof runWithModelFailover<string>>> | undefined

      for (let round = 0; round < rounds; round += 1) {
        const outcome = await runWithModelFailover<string>({
          models: [EDGING, HEALTHY],
          run: completeOnce,
          onFallback: (attempt, next) => fallbacks.push({ from: attempt.model, to: next }),
        })
        // EVERY round answers, rescued or not — that is the customer-visible
        // property this whole mechanism exists to hold.
        expect(outcome.value.trim().length).toBeGreaterThan(0)
        if (outcome.usedFallback) {
          rescued += 1
          lastRescue = outcome
        } else {
          servedByPreferred += 1
        }
      }
      const elapsedMs = Date.now() - started
      console.log(`[live] rounds=${rounds} rescued=${rescued} servedByPreferred=${servedByPreferred} elapsedMs=${elapsedMs}`)

      if (!lastRescue) {
        throw new Error(
          `${EDGING} served all ${rounds} rounds — no edge 502 was observed, so this run proves nothing. Re-probe and set LIVE_EDGE_502_MODEL to a model that is currently edging.`,
        )
      }
      console.log(`[live] rescue serving=${lastRescue.model} text=${JSON.stringify(lastRescue.value)}`)
      console.log(`[live] rescue attempts=${JSON.stringify(lastRescue.attempts)}`)

      // The rescued turn COMPLETED, on the fallback, with real router text.
      expect(rescued).toBeGreaterThan(0)
      expect(lastRescue.model).toBe(HEALTHY)
      expect(lastRescue.usedFallback).toBe(true)
      expect(lastRescue.value.trim().length).toBeGreaterThan(0)
      // The downgrade is attributable, and the reason names the edge failure.
      expect(lastRescue.attempts.map((a) => a.model)).toEqual([EDGING, HEALTHY])
      expect(lastRescue.attempts[0]?.ok).toBe(false)
      expect(lastRescue.attempts[0]?.reason).toMatch(/HTTP 50\d/)
      expect(lastRescue.attempts[1]?.ok).toBe(true)
      expect(fallbacks).toContainEqual({ from: EDGING, to: HEALTHY })
    },
    600_000,
  )

  it(
    'the REAL OpenAI-compat client throws a classifiable outage for the same live 502',
    async () => {
      // The production module in the path, against live bytes: this is the
      // object a browser/edge copilot's failover would have to classify.
      //
      // The 502 is high-rate but not absolute (one 200 was observed in ~140
      // requests), so this retries a bounded number of times and then fails
      // LOUDLY rather than reporting a pass it did not earn.
      const attempts = Number(process.env.LIVE_EDGE_502_ATTEMPTS ?? 6)
      let thrown: unknown = null
      let served = 0
      for (let i = 0; i < attempts && thrown === null; i += 1) {
        const stream = createOpenAICompatStreamTurn({
          baseUrl: BASE,
          apiKey: KEY,
          model: EDGING,
          extraBody: { stream: false, max_tokens: 16 },
        })([{ role: 'user', content: 'Reply with exactly one word: ok' }]) as AsyncIterable<unknown>
        try {
          for await (const _event of stream) void _event
          served += 1
        } catch (err) {
          thrown = err
        }
      }

      console.log(`[live] production client: served=${served} threw status=${(thrown as { status?: number })?.status} message=${JSON.stringify(String((thrown as Error)?.message ?? '').slice(0, 160))}`)

      if (thrown === null) {
        throw new Error(
          `${EDGING} served ${served}/${attempts} requests without a 5xx — the flap has healed and this run proves nothing. Re-probe and set LIVE_EDGE_502_MODEL.`,
        )
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as { status?: number }).status).toBe(502)
      // Both carriers classify: the numeric status agent-app stamps, and the
      // message text alone — all a foreign producer would ever hand over.
      expect(isUpstreamUnavailable(thrown)).toBe(true)
      expect(isUpstreamUnavailable(new Error(String((thrown as Error).message)))).toBe(true)
    },
    300_000,
  )

  it(
    'CONTROL: the same turn with no fallback in the chain does NOT produce an answer',
    async () => {
      // The assertion that makes the proof real: same model, same router, same
      // minute — the only variable is whether a fallback exists in the chain.
      // Sampled over the same number of rounds, so the two tests are comparable.
      const rounds = Number(process.env.LIVE_EDGE_502_ROUNDS ?? 8)
      let answered = 0
      let failedOutright = 0
      let lastError: unknown
      for (let round = 0; round < rounds; round += 1) {
        const outcome = await runWithModelFailover<string>({ models: [EDGING], run: completeOnce }).then(
          (ok) => ({ text: ok.value as string | null, error: null as unknown }),
          (error: unknown) => ({ text: null as string | null, error }),
        )
        if (outcome.error) {
          failedOutright += 1
          lastError = outcome.error
        } else answered += 1
      }
      console.log(`[live][control] rounds=${rounds} answered=${answered} failedOutright=${failedOutright} lastError=${JSON.stringify(String((lastError as Error)?.message ?? '').slice(0, 160))}`)

      if (failedOutright === 0) {
        throw new Error(
          `${EDGING} answered all ${rounds} control rounds — no edge 502 was observed, so the control proves nothing.`,
        )
      }
      // With no fallback in the chain, the edge 502 reaches the caller: the
      // turn produces NO answer. That is the state every app was in before
      // this rescue existed.
      expect(failedOutright).toBeGreaterThan(0)
      expect((lastError as { attempts?: Array<{ ok: boolean }> }).attempts?.every((a) => !a.ok)).toBe(true)
      expect(String((lastError as Error).message)).toMatch(/HTTP 50\d/)
    },
    600_000,
  )
})
