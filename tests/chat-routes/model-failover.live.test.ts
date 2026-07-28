/**
 * LIVE proof of model failover on the shared turn path: a real box on
 * `sandbox.tangle.tools`, a real turn, with a DEAD model preferred — driven
 * through the real `createChatTurnRoutes` + `createSandboxChatProducer`
 * assembly into a real SQLite chat store.
 *
 * What it proves, end to end:
 *   1. The turn COMPLETES with real text despite the preferred model being dead.
 *   2. The persisted assistant row records the model that ACTUALLY served —
 *      not the one that was requested.
 *   3. The billing receipt (`onTurnComplete`) carries the same serving model
 *      plus the full attempt trail, so a downgrade is attributable.
 *   4. A visible transcript notice names both models.
 *   5. Opting out (`modelFailover: false`) leaves the SAME turn failing — the
 *      control that proves the check can fail.
 *
 * Skipped unless `LIVE_SANDBOX=1` and `SANDBOX_API_KEY` are set: it spends
 * money and needs credentials CI does not hold. Run it by hand:
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… SANDBOX_API_URL=https://sandbox.tangle.tools \
 *     LIVE_DEAD_MODEL=claude-sonnet-4-6 LIVE_HEALTHY_MODEL=gpt-5 \
 *     pnpm vitest run tests/chat-routes/model-failover.live.test.ts
 */

import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { Sandbox } from '@tangle-network/sandbox'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  type ChatTurnMessageStore,
  type ChatTurnModelFailover,
} from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { streamSandboxPrompt, type SandboxRuntimeConfig } from '../../src/sandbox/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const LIVE =
  process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY) && Boolean(process.env.TANGLE_API_KEY)
/**
 * The dead model. Default: an id ABSENT from the router's catalog, because the
 * 2026-07-25 outage that motivated this work resolved before the test shipped
 * and no live upstream is reliably dead on demand. Verified equivalent on a
 * real box (2026-07-26): an uncatalogued model produces the IDENTICAL resolved
 * terminal shape — `error` event, `code: 'provider_inference_unavailable'` —
 * as the quota-walled `claude-sonnet-4-6` did during the outage, because
 * OpenCode wraps every unservable-upstream failure the same way. During a real
 * outage, set LIVE_DEAD_MODEL to the dead id to replay it exactly.
 */
const DEAD = process.env.LIVE_DEAD_MODEL ?? 'agent-app-failover-proof-dead-model'
const HEALTHY = process.env.LIVE_HEALTHY_MODEL ?? 'gpt-5-mini'

/** Minimal shell: only `provider` + `profile` are read by `streamSandboxPrompt`.
 *  The provider is the REAL router — the same seam every product wires. */
function liveShell(): SandboxRuntimeConfig {
  return {
    credentials: () => null,
    name: (id) => `live-${id}`,
    metadata: () => ({}),
    connectedIntegrationIds: async () => [],
    env: async () => ({}),
    files: async () => [],
    secrets: async () => [],
    profile: () => ({ name: 'agent-app-failover-live' }) as AgentProfile,
    provider: {
      apiKey: process.env.TANGLE_API_KEY!,
      providerName: 'openai-compat',
      routerBaseUrl: process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1',
    },
  }
}

const tables = createChatTables({ workspaceTable: workspacesTable })

async function liveBox() {
  const client = new Sandbox({
    apiKey: process.env.SANDBOX_API_KEY!,
    baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
  })
  const reuseId = process.env.LIVE_BOX_ID
  const box = reuseId
    ? (await client.get(reuseId))!
    : await client.create({ name: `agent-app-failover-${Date.now()}`.slice(0, 63) })
  if (!box) throw new Error(`LIVE_BOX_ID ${reuseId} not found`)
  console.log(`[live] box ${box.id} status=${box.status} reused=${Boolean(reuseId)}`)
  return box
}

interface TurnOutcome {
  finalText: string
  rowModel: string | null
  rowContent: string
  receiptModel?: string
  receiptFailover?: ChatTurnModelFailover
  notices: string[]
  opened: string[]
  failed?: boolean
}

/** Drive one real turn through the real route assembly. */
async function runLiveTurn(
  box: Awaited<ReturnType<typeof liveBox>>,
  opts: { failover: boolean },
): Promise<TurnOutcome> {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'failover' })

  const opened: string[] = []
  const notices: string[] = []
  let receiptModel: string | undefined
  let receiptFailover: ChatTurnModelFailover | undefined
  let failed: boolean | undefined
  const pending: Promise<unknown>[] = []

  const routes = createChatTurnRoutes({
    projectId: 'agent-app-failover-live',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
    produce: () =>
      createSandboxChatProducer({
        model: DEAD,
        // The ONLY difference between the proof and its control.
        ...(opts.failover ? { fallbackModels: [HEALTHY] } : { modelFailover: false as const }),
        openEvents: ({ model, attempt }) => {
          opened.push(model)
          console.log(`[live] open attempt ${attempt} -> ${model}`)
          const raw = box.streamPrompt('What is the capital of France? Answer in one short sentence.', {
            model,
            sessionId: `${thread.id}-${attempt}`,
          }) as AsyncIterable<unknown>
          // Dump the VERBATIM upstream events for the failing attempt. This is
          // where the payload shapes the unit tests assert against come from —
          // captured from production, never invented.
          return (async function* () {
            for await (const ev of raw) {
              const type = (ev as { type?: unknown })?.type
              if (type === 'error' || type === 'session.run.failed') {
                console.log(`[live][raw ${model}] ${JSON.stringify(ev).slice(0, 700)}`)
              }
              yield ev
            }
          })()
        },
        onModelFallback: (info) => console.log(`[live] fallback ${info.from} -> ${info.to} :: ${info.reason}`),
        log: (m, meta) => console.log(`[live] ${m}`, JSON.stringify(meta ?? {}).slice(0, 400)),
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

  const res = await routes.turn(
    new Request('http://live.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: thread.id, content: 'capital of France?' }),
    }),
    { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
  )
  await new Response(res.body!).text()
  await Promise.all(pending)

  const rows = (await store.listMessages(thread.id)) as unknown as Array<{
    role: string
    content: string
    model: string | null
  }>
  const assistant = rows.find((r) => r.role === 'assistant')

  return {
    finalText: assistant?.content ?? '',
    rowModel: assistant?.model ?? null,
    rowContent: assistant?.content ?? '',
    receiptModel,
    receiptFailover,
    notices,
    opened,
    failed,
  }
}

describe.skipIf(!LIVE)('LIVE: model failover on a real box turn', () => {
  it(
    'completes on the fallback when the preferred model is dead, and attributes the model that served',
    async () => {
      const box = await liveBox()
      const out = await runLiveTurn(box, { failover: true })

      console.log('\n=== LIVE FAILOVER RESULT ===')
      console.log(JSON.stringify(out, null, 2))

      // 1. Both models were tried, preferred first.
      expect(out.opened[0]).toBe(DEAD)
      expect(out.opened).toContain(HEALTHY)
      // 2. The turn produced a real answer.
      expect(out.rowContent.toLowerCase()).toContain('paris')
      // 3. The PERSISTED ROW names the model that actually served.
      expect(out.rowModel).toBe(HEALTHY)
      // 4. The BILLING RECEIPT names it too, with the trail.
      expect(out.receiptModel).toBe(HEALTHY)
      expect(out.receiptFailover?.usedFallback).toBe(true)
      expect(out.receiptFailover?.attempts.map((a) => a.model)).toEqual([DEAD, HEALTHY])
      expect(out.receiptFailover?.attempts[0]?.ok).toBe(false)
      expect(out.failed).toBe(false)
      // 5. The downgrade is VISIBLE, naming both models.
      const notice = out.notices.find((n) => n.includes(DEAD) && n.includes(HEALTHY))
      expect(notice, `expected a fallback notice naming both models, got ${JSON.stringify(out.notices)}`).toBeTruthy()
    },
    600_000,
  )

  it(
    'CONTROL: the same turn with failover opted out does NOT produce an answer',
    async () => {
      const box = await liveBox()
      const out = await runLiveTurn(box, { failover: false })

      console.log('\n=== LIVE CONTROL (failover off) RESULT ===')
      console.log(JSON.stringify(out, null, 2))

      // Only the dead model was ever opened — no chain walk.
      expect(out.opened).toEqual([DEAD])
      // And the turn did not answer the question. This is the assertion that
      // proves the proof above is real: same box, same prompt, same dead model,
      // failover the only variable.
      expect(out.rowContent.toLowerCase()).not.toContain('paris')
    },
    600_000,
  )
})
