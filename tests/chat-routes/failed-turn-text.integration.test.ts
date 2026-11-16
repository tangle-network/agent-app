/**
 * A failed turn shows the person one plain sentence, live and after a reload, and never the harness's own failure
 * text: its loop report, the refused tool and the list of every tool it has. Funding and admission refusals keep their
 * words, because the client's recovery UI reads them, and the server log keeps the real reason.
 *
 * Driven through the real `createChatTurnRoutes` assembly, the real `createSandboxChatProducer` and the real chat store
 * over SQLite. Only the box is stood in for, at its event boundary: the events its sidecar sends, or a severed stream.
 */

import { describe, expect, it, vi } from 'vitest'

import { createChatTurnRoutes, createSandboxChatProducer, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createChatTables } from '../../src/chat-store/schema'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { getChatFundingRecovery } from '../../src/web/turn-funding-recovery'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const PLAIN = 'That answer stopped before it finished. Please send your question again.'

/** What a box harness reports when it stops a turn after the model repeats a refused tool call. */
const HARNESS_FAILURE = 'opencode execution failed: opencode sent the same save_fact call 3 times and every one was rejected. '
  + "The turn stopped before it ran the model again: Model tried to call unavailable tool 'save_fact'. "
  + 'Available tools: lookup_lookup, bash, edit, ledger_ledger, list_facts_list_facts. (killed by SIGTERM)'
const RAW_FRAGMENTS = ['execution failed', 'save_fact', 'Available tools', 'list_facts_list_facts', 'SIGTERM']

const tables = createChatTables({ workspaceTable: workspacesTable })

type WireEvent = { type: string; text?: string; data?: { message?: string; code?: string; details?: unknown } }

/** One chat turn whose box sends `events` and then, when `severed` is given, drops the stream with it. */
async function turn(events: unknown[], options: { severed?: Error; serverLog?: 'default' } = {}) {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS 1' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
  async function* box(): AsyncGenerator<unknown> {
    for (const event of events) yield event
    if (options.severed) throw options.severed
  }
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'failed-turn-text',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
    produce: () => createSandboxChatProducer({
      events: box(),
      model: 'm',
      ...(options.serverLog === 'default' ? {} : { log: () => {} }),
    }),
    log: () => {},
  })
  const response = await routes.turn(new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: thread.id, content: 'What is left to file?' }),
  }), { waitUntil: (work: Promise<unknown>) => void pending.push(work) })
  const wire = await response.text()
  await Promise.all(pending)
  const streamed = wire.trim().split('\n').map((line) => JSON.parse(line) as WireEvent)
  const rows = (await store.listMessages(thread.id)) as unknown as Array<{ role: string; content: string; parts: unknown }>
  return {
    wire,
    text: streamed.filter((event) => event.type === 'text').map((event) => event.text).join(''),
    error: streamed.find((event) => event.type === 'error')?.data,
    row: rows.find((row) => row.role === 'assistant'),
  }
}

function expectNoRawReason(result: Awaited<ReturnType<typeof turn>>): void {
  for (const fragment of RAW_FRAGMENTS) {
    expect(result.wire).not.toContain(fragment)
    expect(JSON.stringify(result.row)).not.toContain(fragment)
  }
}

describe('a failed turn never shows the person the raw failure reason', () => {
  it.each(['error event', 'severed stream'] as const)('a harness failure before any text reads as one plain sentence, live and stored (%s)', async (carrier) => {
    const result = carrier === 'error event'
      ? await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE, reason: 'provider_error' } }])
      : await turn([], { severed: new Error(HARNESS_FAILURE) })

    expect(result.text).toBe(PLAIN)
    expect(result.error?.message).toBe(PLAIN)
    expect(result.error?.details).toBeUndefined()
    // The failure's class still reaches the client as a code.
    expect(result.error?.code).toBe(carrier === 'error event' ? 'AGENT_EXECUTION_FAILED' : 'sandbox.stream_failed')
    expect(result.row?.content).toBe(PLAIN)
    expectNoRawReason(result)
  })

  it('keeps the partial answer the person already saw and appends only the plain sentence', async () => {
    const answer = 'Here is what I found so far.'
    const result = await turn([
      { type: 'message.part.updated', data: { part: { type: 'text', id: 't1', text: answer }, delta: answer } },
      { type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE } },
    ])

    expect(result.text).toBe(`${answer}\n\n---\n${PLAIN}`)
    expect(result.error?.message).toBe(PLAIN)
    expect(result.row?.content).toBe(`${answer}\n\n---\n${PLAIN}`)
    expectNoRawReason(result)
  })

  it.each([
    { kind: 'funding', card: true, data: { code: 'insufficient_credits', message: 'Insufficient credits. Add funds to continue.' } },
    { kind: 'admission', card: true,
      data: { message: 'opencode execution failed: Inference requires verified paid access. Add funds or activate a paid seat.' } },
    { kind: 'billing', card: false,
      data: { code: 'AGENT_EXECUTION_FAILED', statusCode: 402, message: "opencode execution failed: This key's budget is exhausted. Raise its cap." } },
  ])('the $kind refusal keeps its words, live and stored, where the person and the recovery UI read them', async ({ data, card }) => {
    const refused = await turn([{ type: 'error', data }])

    const stored = `The sandbox agent returned an error before producing a visible answer.\n\nError: ${data.message}`
    expect(refused.text).toBe(stored)
    expect(refused.row?.content).toBe(stored)
    expect(refused.error?.message).toBe(data.message)
    // The recovery UI reads the live error event and the stored reason alike.
    expect(getChatFundingRecovery({ code: refused.error?.code, message: refused.error?.message }) !== null).toBe(card)
    expect(getChatFundingRecovery(refused.row!.content.split('\n\nError: ')[1]) !== null).toBe(card)

    // The same route withholds a runtime failure, so the pass-through is a decision, not the absence of one.
    const failed = await turn([{ type: 'error', data: { message: HARNESS_FAILURE } }])
    expect(failed.row?.content).toBe(PLAIN)
  })

  it('sends the real reason to the server log at warn, under one fixed class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await turn(
        [{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE } }],
        { serverLog: 'default' },
      )

      expect(result.row?.content).toBe(PLAIN)
      expect(warn).toHaveBeenCalledWith('[chat-routes] turn failure withheld from the person', {
        failureClass: 'runtime_failure',
        code: 'AGENT_EXECUTION_FAILED',
        error: HARNESS_FAILURE,
      })
    } finally {
      warn.mockRestore()
    }
  })
})
