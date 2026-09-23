/**
 * LIVE proof of incremental assistant persistence against real infrastructure:
 * a real sandbox on `sandbox.tangle.tools`, a real agent turn from a real
 * model, driven through the real `createChatTurnRoutes` assembly into a real
 * SQLite chat store — with the durable row QUERIED WHILE THE TURN STREAMS.
 *
 * Skipped unless `LIVE_SANDBOX=1` and `SANDBOX_API_KEY` are set: it spends
 * money and needs credentials CI does not hold. Run it by hand:
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… SANDBOX_API_URL=https://sandbox.tangle.tools \
 *     pnpm vitest run tests/chat-routes/incremental-persistence.live.test.ts
 */

import { describe, expect, it } from 'vitest'
import { Sandbox } from '@tangle-network/sandbox'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import type { ChatMessagePart } from '../../src/chat-store/parts'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const LIVE = process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY)
// Model override is OPT-IN: a box provisioned against an openai-compat backend
// rejects an `anthropic/*` override, so the box's own default is the safe path.

const tables = createChatTables({ workspaceTable: workspacesTable })

describe.skipIf(!LIVE)('LIVE: incremental persistence against a real sandbox turn', () => {
  it('a real streaming turn is readable from durable storage while it runs, and settles byte-identical to the single-write projection', async () => {
    const client = new Sandbox({
      apiKey: process.env.SANDBOX_API_KEY!,
      baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
    })
    // Reuse a running box when one is named (cheap reruns); otherwise provision.
    const reuseId = process.env.LIVE_BOX_ID
    const box = reuseId ? (await client.get(reuseId))! : await client.create({ name: `agent-app-incremental-${Date.now()}`.slice(0, 63) })
    if (!box) throw new Error(`LIVE_BOX_ID ${reuseId} not found`)
    console.log(`[live] box ${box.id} status=${box.status} reused=${Boolean(reuseId)}`)

    const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
    await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
    const store = createChatStore(db, tables)
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'live' })

    // Samples of the DURABLE row, taken by an independent poller — the exact
    // read a late viewer's page load performs.
    const samples: Array<{ atMs: number; contentLen: number; parts: number; toolStates: string[] }> = []
    const startedAt = Date.now()
    let polling = true
    const poller = (async () => {
      while (polling) {
        const rows = (await store.listMessages(thread.id)) as unknown as Array<{ role: string; content: string; parts: ChatMessagePart[] | null }>
        const assistant = rows.find((row) => row.role === 'assistant')
        if (assistant) {
          samples.push({
            atMs: Date.now() - startedAt,
            contentLen: assistant.content.length,
            parts: (assistant.parts ?? []).length,
            toolStates: (assistant.parts ?? [])
              .filter((part) => part.type === 'tool')
              .map((part) => String((part as { state?: { status?: string } }).state?.status ?? '?')),
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })()

    let capturedProducer: ReturnType<typeof createSandboxChatProducer> | undefined
    const pending: Promise<unknown>[] = []
    const routes = createChatTurnRoutes({
      projectId: 'agent-app-live',
      authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
      store: store as unknown as ChatTurnMessageStore,
      turnStore: createMemoryTurnEventStore(),
      // Production default cadence — no test-only tuning.
      produce: () => {
        capturedProducer = createSandboxChatProducer({
          events: box.streamPrompt(
            'Use bash to write a four-line poem about durable storage to /tmp/poem.txt, then read the file back and quote it to me. Take your time and narrate each step.',
            { ...(process.env.LIVE_MODEL ? { model: process.env.LIVE_MODEL } : {}), sessionId: thread.id },
          ) as AsyncIterable<unknown>,
          ...(process.env.LIVE_MODEL ? { model: process.env.LIVE_MODEL } : {}),
        })
        return capturedProducer
      },
      log: () => {},
    })

    const res = await routes.turn(
      new Request('http://live.test/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id, content: 'write and read back a poem' }),
      }),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    )
    await new Response(res.body!).text()
    await Promise.all(pending)
    polling = false
    await poller

    const rows = (await store.listMessages(thread.id)) as unknown as Array<{ id: string; role: string; content: string; parts: ChatMessagePart[] | null; inputTokens: number | null; model: string | null }>
    const assistants = rows.filter((row) => row.role === 'assistant')

    const midRun = samples.filter((sample) => sample.contentLen > 0)
    const finalRow = assistants[0]!
    console.log('[live] durable-row timeline (ms, chars, parts, toolStates):')
    for (const sample of samples) {
      console.log(`  t+${String(sample.atMs).padStart(6)}ms  chars=${String(sample.contentLen).padStart(5)}  parts=${sample.parts}  tools=[${sample.toolStates.join(',')}]`)
    }
    console.log('[live] final content:', JSON.stringify(finalRow.content.slice(0, 800)))
    console.log(`[live] final: chars=${finalRow.content.length} parts=${(finalRow.parts ?? []).length} inputTokens=${finalRow.inputTokens} rowId=${finalRow.id}`)

    // 1. The row was readable mid-run, and it GREW.
    expect(midRun.length).toBeGreaterThan(1)
    expect(midRun.at(-1)!.contentLen).toBeGreaterThan(midRun[0]!.contentLen)
    // 2. It was fresh well before the turn ended.
    expect(midRun[0]!.atMs).toBeLessThan(Date.now() - startedAt)
    // 3. Exactly one assistant row survives.
    expect(assistants).toHaveLength(1)
    // 4. The settled row equals what the single-write path would have written —
    //    the producer's own final projection, which is the ONLY thing today's
    //    `persistAssistantMessage` writes.
    expect(finalRow.content).toBe(capturedProducer!.finalText())
    const expectedParts = capturedProducer!.assistantParts!()
    expect(JSON.stringify(finalRow.parts)).toBe(JSON.stringify(expectedParts))
    // 5. No tool part was left terminalized by a mid-stream snapshot.
    for (const part of finalRow.parts ?? []) {
      if (part.type !== 'tool') continue
      expect((part as { state?: { metadata?: Record<string, unknown> } }).state?.metadata?.terminalized).toBeUndefined()
    }

    if (!reuseId) await box.delete().catch(() => {})
  }, 600_000)
})
