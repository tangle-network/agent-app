/**
 * LIVE proof of model failover on the AUTONOMOUS lane: a real box on
 * `sandbox.tangle.tools`, a trigger-with-no-human turn driven through the real
 * `runDetachedTurn` bridge with a DEAD model preferred, persisting into a real
 * SQLite chat store.
 *
 * What it proves, end to end:
 *   1. The detached turn COMPLETES on the fallback despite the preferred model
 *      being dead — with nobody watching to retry by hand.
 *   2. The result names the model that ACTUALLY served (`model`,
 *      `usedModelFallback`, `modelAttempts`).
 *   3. The durable assistant row (persist seam) records the serving model's text.
 *   4. CONTROL: the same turn with `modelFailover: false` FAILS — the check can
 *      fail.
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… TANGLE_API_KEY=… \
 *     pnpm vitest run tests/chat-routes/detached-failover.live.test.ts
 */

import { describe, expect, it } from 'vitest'
import { SandboxClient } from '@tangle-network/sandbox'

import { runDetachedTurn } from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const LIVE = process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY)
const DEAD = process.env.LIVE_DEAD_MODEL ?? 'agent-app-failover-proof-dead-model'
const HEALTHY = process.env.LIVE_HEALTHY_MODEL ?? 'gpt-5-mini'

const tables = createChatTables({ workspaceTable: workspacesTable })

async function liveBox() {
  const client = new SandboxClient({
    apiKey: process.env.SANDBOX_API_KEY!,
    baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
  })
  const reuseId = process.env.LIVE_BOX_ID
  const box = reuseId
    ? (await client.get(reuseId))!
    : await client.create({ name: `agent-app-detached-failover-${Date.now()}`.slice(0, 63) })
  if (!box) throw new Error(`LIVE_BOX_ID ${reuseId} not found`)
  console.log(`[live] box ${box.id} status=${box.status}`)
  return box
}

async function runOne(opts: { failover: boolean }) {
  const box = await liveBox()
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'detached failover' })
  const turnId = `detached-proof-${Date.now()}`
  const opened: string[] = []

  const result = await runDetachedTurn({
    store: createMemoryTurnEventStore(),
    turnId,
    scopeId: thread.id,
    model: DEAD,
    ...(opts.failover ? { fallbackModels: [HEALTHY] } : { modelFailover: false as const }),
    openEvents: ({ model, attempt }: { model: string; attempt: number }) => {
      opened.push(model)
      console.log(`[live] open attempt ${attempt} -> ${model}`)
      return box.streamPrompt('What is the capital of Japan? Answer in one short sentence.', {
        model,
        sessionId: `${thread.id}-${attempt}`,
      }) as AsyncIterable<unknown>
    },
    onModelFallback: (info) => console.log(`[live] fallback ${info.from} -> ${info.to} :: ${info.reason}`),
    persist: { store, threadId: thread.id },
    declineInteraction: async () => {},
    log: (m, meta) => console.log(`[live] ${m}`, JSON.stringify(meta ?? {}).slice(0, 300)),
  })

  const rows = (await store.listMessages(thread.id)) as unknown as Array<{
    role: string
    content: string
    model: string | null
  }>
  const assistant = rows.find((r) => r.role === 'assistant')
  return { result, opened, rowModel: assistant?.model ?? null, rowContent: assistant?.content ?? '' }
}

describe.skipIf(!LIVE)('LIVE: detached (autonomous) turn failover on a real box', () => {
  it(
    'completes on the fallback with nobody watching, and attributes the serving model',
    async () => {
      const out = await runOne({ failover: true })
      console.log('\n=== LIVE DETACHED FAILOVER RESULT ===')
      console.log(
        JSON.stringify(
          {
            state: out.result.state,
            model: out.result.model,
            usedModelFallback: out.result.usedModelFallback,
            modelAttempts: out.result.modelAttempts,
            text: out.result.text.slice(0, 120),
            messageId: out.result.messageId,
            rowModel: out.rowModel,
            rowContent: out.rowContent.slice(0, 120),
            opened: out.opened,
          },
          null,
          2,
        ),
      )
      expect(out.opened[0]).toBe(DEAD)
      expect(out.opened).toContain(HEALTHY)
      expect(out.result.state).toBe('completed')
      expect(out.result.text.toLowerCase()).toContain('tokyo')
      expect(out.result.model).toBe(HEALTHY)
      expect(out.result.usedModelFallback).toBe(true)
      expect(out.result.modelAttempts?.map((a) => a.model)).toEqual([DEAD, HEALTHY])
      expect(out.rowContent.toLowerCase()).toContain('tokyo')
    },
    600_000,
  )

  it(
    'CONTROL: the same detached turn with failover opted out FAILS',
    async () => {
      const out = await runOne({ failover: false })
      console.log('\n=== LIVE DETACHED CONTROL RESULT ===')
      console.log(
        JSON.stringify(
          { state: out.result.state, error: out.result.error?.slice(0, 200), opened: out.opened },
          null,
          2,
        ),
      )
      expect(out.opened).toEqual([DEAD])
      expect(out.result.state).toBe('failed')
      expect(out.result.text.toLowerCase()).not.toContain('tokyo')
    },
    600_000,
  )
})
