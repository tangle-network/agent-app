/**
 * LIVE proof that the WHOLE SERVER CHAT VERTICAL rescues a real Cloudflare edge
 * 502 — route, producer, persistence and billing receipt, not just the
 * classifier.
 *
 * Its sibling `model-failover-edge-502.live.test.ts` proves the *primitive*
 * (`runWithModelFailover`) survives a real edge 502. That leaves the question a
 * product actually cares about unanswered: does the assembled
 * `createChatTurnRoutes` + `createSandboxChatProducer` + chat-store vertical
 * turn that rescue into a COMPLETED turn whose durable row names the model that
 * really answered? A rescue the persistence layer mis-attributes is not a
 * rescue — it is a silent downgrade, the failure this module exists to prevent.
 *
 * And it is the one cell neither live sibling covers:
 *
 *   | proof                              | real edge 502 | full route + durable row |
 *   | model-failover-edge-502.live       | yes           | no  (primitive only)     |
 *   | model-failover.live                | no  (box)     | yes                      |
 *   | THIS FILE                          | yes           | yes                      |
 *
 * WHY THE ROUTER CANNOT DO THIS ITSELF. The router has its own failover and it
 * works — a quota-walled model comes back 200 with
 * `x-tangle-failover: from=…; to=…` and `x-tangle-served-model` naming the
 * substitute (measured 2026-07-27 19:30 UTC: `claude-sonnet-4-6` served as
 * `openai/gpt-5`). But that machinery lives INSIDE the origin. When Cloudflare
 * answers 502 on its behalf, the reply carries a `text/plain` body of
 * `error code: 502` and ZERO `x-tangle-*` headers where a healthy 200 carries
 * twelve — nothing the origin decided survives. Only a client outside the edge
 * can save that turn, which is this vertical.
 *
 * THE TRIGGER IS DETERMINISTIC, AND IT IS NOT AN OUTAGE. This started as "a
 * flap" and is not one. The 502 is caused by the REQUEST: a non-streaming call
 * to a REASONING model with a `max_tokens` budget smaller than the reasoning
 * the model wants to spend. Measured 2026-07-27 19:37–19:39 UTC by an
 * INTERLEAVED ablation — same model, same prompt, same minute, only
 * `max_tokens` varying, so a heal partway through cannot masquerade as an
 * effect:
 *
 *   gemini-2.5-pro, stream:false     16 → 5/5 502     96 → 3/3 502
 *                                    64 → 5/5 502    128 → 3/3 502
 *                                   192 → 3/3 502    256 → 1/3 200, 2/3 502
 *                                   384 → 3/3 200    512 → 5/5 200
 *                                  omitted → 3/3 200
 *
 * Two controls confirm the mechanism. `gemini-2.5-flash-lite` — which does not
 * spend a reasoning budget — answers 3/3 at `max_tokens: 16` AND 3/3 at 512.
 * And `gemini-2.5-pro` at the SAME failing budget of 16 succeeds 3/3 when
 * `stream: true`, returning `completion_tokens: 1` with `total_tokens: 28`:
 * the streaming path degrades to a near-empty answer where the non-streaming
 * path returns an origin 5xx that Cloudflare rewrites into sixteen unlabelled
 * bytes.
 *
 * That is why this test sends `max_tokens: 16` to BOTH models. It is not a
 * thumb on the scale — it is one identical request that a reasoning model
 * cannot serve and a non-reasoning one can, which is exactly the production
 * asymmetry, made reproducible on demand instead of waited for.
 *
 * THE DEFAULT TRIGGER IS NOW FIXED UPSTREAM — EXPECT THIS TEST TO SAY SO. The
 * router cause above was tangle-router #307 ("Gemini thinking headroom"):
 * thinking is on by default from Gemini 2.5 up and the hidden thought tokens
 * bill against the same output ceiling as the answer, so a modest `max_tokens`
 * was consumed entirely by thinking and the response came back empty with
 * `finish_reason: length`, which the router's fail-loud guard turned into a
 * 5xx. It shipped to production 2026-07-27 20:01 UTC, and the identical
 * ablation re-run at 20:02 returned 12/12 200 where it had returned 5/5 502 at
 * 19:37.
 *
 * So on today's router this file FAILS with "no edge 5xx was observed, so this
 * run proves nothing". That is the intended behavior, not a regression: a live
 * test with nothing live to test must never report success. Point
 * `LIVE_EDGE_502_MODEL` at whatever is currently 5xxing to run it for real. The
 * permanent guard for this failure class is the non-live sibling
 * (`model-failover-edge-502.test.ts`), which replays the verbatim capture and
 * needs no outage at all.
 *
 * The earlier readings this replaces are all consistent with it: "218/218 via
 * curl but ~5/8 via Node" was two clients sending different token budgets, and
 * "gemini-2.5-flash-lite never flaps" is because it is the control.
 *
 * TWO BODY SHAPES, ONE VERDICT. A `claude-opus-4-1` run in the same window
 * returned seven opaque `error code: 502` bodies and one READABLE
 * `{"error":{"message":"Inference temporarily unavailable…"}}` 503 — the router
 * emitting its own status so the body survives the edge (tangle-router #307).
 * The client must classify both the same way, which is why the assertion below
 * is `/HTTP 50\d/` and not the 502 literal: a router that gets better at
 * explaining itself must never silently switch the rescue off.
 *
 * WHAT IS REAL AND WHAT IS SCAFFOLDING. Real: the router, the 502, the
 * classifier, `streamWithModelFailover`, `createSandboxChatProducer`,
 * `createChatTurnRoutes`, and a real SQLite chat store. Scaffolding: the
 * adapter that shapes a `/chat/completions` reply into the sandbox event
 * vocabulary, because no sandbox box sits on this hop — the 502 happens between
 * this process and the router. Its non-ok error is built exactly as
 * `src/runtime/openai-stream.ts` builds one (prose message + numeric `status`),
 * and the sibling live test pins that the shipped client really does throw that
 * shape for this same live response.
 *
 * Skipped unless `LIVE_ROUTER=1` and `TANGLE_ROUTER_API_KEY` are set. Note the
 * key name: a stale `TANGLE_INTELLIGENCE_API_KEY` outranks `TANGLE_API_KEY` in
 * some shells, so this reads an unambiguous variable.
 *
 *   LIVE_ROUTER=1 TANGLE_ROUTER_API_KEY=… \
 *     pnpm vitest run tests/chat-routes/model-failover-edge-502-route.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  type ChatTurnMessageStore,
  type ChatTurnModelFailover,
} from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const KEY = process.env.TANGLE_ROUTER_API_KEY ?? ''
const LIVE = process.env.LIVE_ROUTER === '1' && KEY.length > 0
const BASE = process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1'
/** The model whose NON-STREAMING path is edge-5xxing. Re-probe and override
 *  when it heals — a healed model makes this run prove nothing, and the test
 *  says so out loud rather than passing vacuously. */
const EDGING = process.env.LIVE_EDGE_502_MODEL ?? 'gemini-2.5-pro'
const HEALTHY = process.env.LIVE_HEALTHY_MODEL ?? 'gemini-2.5-flash-lite'
const PROMPT = 'What is the capital of France? Answer in one short sentence.'
/** The budget that makes the 5xx deterministic. Sent to EVERY model in the
 *  chain, unchanged — see the ablation in the file header. */
const MAX_TOKENS = Number(process.env.LIVE_EDGE_502_MAX_TOKENS ?? 16)

const tables = createChatTables({ workspaceTable: workspacesTable })

/** Count the router's own headers. Twelve on a healthy non-streamed 200, zero
 *  when Cloudflare answered instead — the header-level proof that the origin's
 *  decision did not survive to the client. */
function tangleHeaderCount(res: Response): number {
  let count = 0
  res.headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith('x-tangle-')) count += 1
  })
  return count
}

/**
 * One real non-streaming completion, shaped into the sandbox event vocabulary
 * the producer consumes.
 *
 * The `start` event is yielded BEFORE the request on purpose: it proves a
 * non-committing preamble does not pin the turn to a model that then dies. The
 * 502 throws on the very next line, before anything committing exists, which is
 * exactly the window failover is allowed to act in.
 */
async function* routerTurnEvents(model: string, attempt: number): AsyncGenerator<unknown> {
  yield { type: 'start', data: { id: `exec-${model}-${attempt}` }, id: `${attempt}-start` }

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    // `MAX_TOKENS` is the trigger, and it is IDENTICAL for every model in the
    // chain — see the ablation in the file header. Raise it and the preferred
    // model stops 502ing and this test correctly reports that it proved
    // nothing.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, stream: false }),
  })
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    // Byte-identical to what `src/runtime/openai-stream.ts` throws for a non-ok
    // response: the status in prose AND stamped as a number.
    const error = new Error(
      `OpenAI-compat stream failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
    Object.assign(error, { status: res.status, tangleHeaders: tangleHeaderCount(res), cfRay: res.headers.get('cf-ray') })
    throw error
  }

  const json = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const text = json.choices?.[0]?.message?.content ?? ''
  const input = json.usage?.prompt_tokens ?? 0
  const output = json.usage?.completion_tokens ?? 0

  yield { type: 'message.part.updated', data: { part: { id: `p-${attempt}`, type: 'text', text: '' } }, id: `${attempt}-open` }
  yield {
    type: 'message.part.updated',
    data: { part: { id: `p-${attempt}`, type: 'text', text }, delta: text },
    id: `${attempt}-text`,
  }
  yield {
    type: 'result',
    data: {
      outcome: { type: 'completed' },
      finalText: text,
      toolInvocations: [],
      tokenUsage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: json.usage?.total_tokens ?? input + output,
      },
    },
    id: `${attempt}-result`,
  }
  yield { type: 'done', data: { outcome: { type: 'completed' } }, id: `${attempt}-done` }
}

interface TurnOutcome {
  rowContent: string
  rowModel: string | null
  rowInputTokens: number | null
  receiptModel?: string
  receiptFailover?: ChatTurnModelFailover
  failed?: boolean
  notices: string[]
  opened: string[]
  wire: string
  errorStatuses: number[]
  tangleHeadersOn502: number[]
  cfRays: string[]
}

/** Drive ONE real turn through the real route assembly into a real store. */
async function runLiveTurn(opts: { failover: boolean; round: number }): Promise<TurnOutcome> {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'edge-502' })

  const opened: string[] = []
  const notices: string[] = []
  const errorStatuses: number[] = []
  const tangleHeadersOn502: number[] = []
  const cfRays: string[] = []
  let receiptModel: string | undefined
  let receiptFailover: ChatTurnModelFailover | undefined
  let failed: boolean | undefined
  const pending: Promise<unknown>[] = []

  const routes = createChatTurnRoutes({
    projectId: 'agent-app-edge-502-live',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
    produce: () =>
      createSandboxChatProducer({
        model: EDGING,
        // The ONLY difference between the proof and its control.
        ...(opts.failover ? { fallbackModels: [HEALTHY] } : { modelFailover: false as const }),
        openEvents: ({ model, attempt }) => {
          opened.push(model)
          return (async function* () {
            try {
              for await (const event of routerTurnEvents(model, attempt)) yield event
            } catch (err) {
              const status = (err as { status?: number }).status
              if (typeof status === 'number') {
                errorStatuses.push(status)
                tangleHeadersOn502.push((err as { tangleHeaders?: number }).tangleHeaders ?? -1)
                const ray = (err as { cfRay?: string | null }).cfRay
                if (ray) cfRays.push(ray)
              }
              throw err
            }
          })()
        },
        log: () => {},
      }),
    onTurnComplete: async (input) => {
      receiptModel = input.model
      receiptFailover = input.modelFailover
      failed = input.failed
    },
    onEvent: (event) => {
      if (event.type === 'notice') notices.push(String((event as { text?: unknown }).text ?? ''))
    },
    log: () => {},
  })

  let wire = ''
  try {
    const res = await routes.turn(
      new Request('http://live.test/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id, content: PROMPT }),
      }),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    )
    wire = res.body ? await new Response(res.body).text() : ''
  } catch (err) {
    // The control path: every model in the chain 502d, so the vertical throws
    // rather than inventing an answer. Recorded, not swallowed.
    wire = `THREW: ${String((err as Error).message).slice(0, 200)}`
  }
  await Promise.allSettled(pending)

  const rows = (await store.listMessages(thread.id)) as unknown as Array<{
    role: string
    content: string
    model: string | null
    inputTokens: number | null
  }>
  const assistant = rows.find((r) => r.role === 'assistant')

  return {
    rowContent: assistant?.content ?? '',
    rowModel: assistant?.model ?? null,
    rowInputTokens: assistant?.inputTokens ?? null,
    receiptModel,
    receiptFailover,
    failed,
    notices,
    opened,
    wire,
    errorStatuses,
    tangleHeadersOn502,
    cfRays,
  }
}

describe.skipIf(!LIVE)('LIVE: the chat vertical rescues a real Cloudflare edge 502', () => {
  it(
    'completes the turn on the fallback and the DURABLE ROW names the model that served',
    async () => {
      const rounds = Number(process.env.LIVE_EDGE_502_ROUNDS ?? 8)
      const started = Date.now()
      const results: TurnOutcome[] = []
      let rescued: TurnOutcome | undefined

      for (let round = 0; round < rounds; round += 1) {
        const out = await runLiveTurn({ failover: true, round })
        results.push(out)
        // EVERY round must answer, whether it needed the rescue or not — that
        // is the customer-visible guarantee, not just "a rescue happened once".
        expect(out.rowContent.toLowerCase(), `round ${round} produced no answer`).toContain('paris')
        expect(out.failed, `round ${round} reported a failed turn`).toBe(false)
        if (out.receiptFailover?.usedFallback) rescued = out
      }

      const rescuedCount = results.filter((r) => r.receiptFailover?.usedFallback).length
      const statuses = results.flatMap((r) => r.errorStatuses)
      console.log(
        `[live] rounds=${rounds} answered=${results.length} rescued=${rescuedCount} servedByPreferred=${rounds - rescuedCount} edgeStatuses=${JSON.stringify(statuses)} elapsedMs=${Date.now() - started}`,
      )
      console.log(`[live] cf-rays on the 5xx responses: ${JSON.stringify(results.flatMap((r) => r.cfRays))}`)

      if (!rescued) {
        throw new Error(
          `${EDGING} served all ${rounds} rounds — no edge 5xx was observed, so this run proves nothing. Re-probe and set LIVE_EDGE_502_MODEL to a model that is currently edging.`,
        )
      }

      console.log(`[live] rescued round: ${JSON.stringify({ ...rescued, wire: `${rescued.wire.length} bytes` }, null, 2)}`)

      // 1. The failure really was an edge 5xx with none of the router's headers.
      expect(rescued.errorStatuses.some((s) => s >= 500)).toBe(true)
      expect(rescued.tangleHeadersOn502).toContain(0)
      // 2. Both models were opened, preferred first.
      expect(rescued.opened[0]).toBe(EDGING)
      expect(rescued.opened).toContain(HEALTHY)
      // 3. The PERSISTED ROW names the model that actually served — the whole
      //    point. A rescue the durable row mis-attributes is a silent downgrade.
      expect(rescued.rowModel).toBe(HEALTHY)
      expect(rescued.rowContent.toLowerCase()).toContain('paris')
      // 4. The BILLING RECEIPT agrees, and carries the trail.
      expect(rescued.receiptModel).toBe(HEALTHY)
      expect(rescued.receiptFailover?.usedFallback).toBe(true)
      expect(rescued.receiptFailover?.attempts.map((a) => a.model)).toEqual([EDGING, HEALTHY])
      expect(rescued.receiptFailover?.attempts[0]?.ok).toBe(false)
      expect(rescued.receiptFailover?.attempts[0]?.reason).toMatch(/HTTP 50\d/)
      // 5. Only the serving model's tokens are billed — the abandoned attempt
      //    never reached a receipt, so the row's usage is the fallback's alone.
      expect(rescued.rowInputTokens ?? 0).toBeGreaterThan(0)
      // 6. The downgrade is VISIBLE, naming both models and the real cause.
      const notice = rescued.notices.find((n) => n.includes(EDGING) && n.includes(HEALTHY))
      expect(notice, `expected a fallback notice naming both models, got ${JSON.stringify(rescued.notices)}`).toBeTruthy()
      expect(notice).toMatch(/50\d/)
      // 7. The dead attempt's execution id never reached the client.
      expect(rescued.wire).not.toContain(`exec-${EDGING}`)
    },
    900_000,
  )

  it(
    'CONTROL: the SAME turn with failover opted out does not answer',
    async () => {
      const rounds = Number(process.env.LIVE_EDGE_502_ROUNDS ?? 8)
      const results: TurnOutcome[] = []
      for (let round = 0; round < rounds; round += 1) {
        results.push(await runLiveTurn({ failover: false, round }))
      }
      const answered = results.filter((r) => r.rowContent.toLowerCase().includes('paris')).length
      const blanked = results.length - answered
      console.log(
        `[live][control] rounds=${rounds} answered=${answered} noAnswer=${blanked} edgeStatuses=${JSON.stringify(results.flatMap((r) => r.errorStatuses))}`,
      )

      // Only the preferred model is ever opened — no chain walk.
      for (const out of results) expect(out.opened).toEqual([EDGING])
      if (blanked === 0) {
        throw new Error(
          `${EDGING} answered all ${rounds} control rounds — no edge 5xx was observed, so the control proves nothing.`,
        )
      }
      // At least one customer got nothing. Same router, same key, same minutes,
      // same prompt: failover is the only variable between this and the proof.
      expect(blanked).toBeGreaterThan(0)
    },
    900_000,
  )
})
