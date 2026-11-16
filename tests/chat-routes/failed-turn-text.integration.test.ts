/**
 * A failed turn shows the person one plain sentence, live and after a reload, and never the harness's own failure
 * text: its loop report, the refused tool and the list of every tool it has, in the answer or in a tool part. Funding,
 * billing, admission and model-policy refusals keep their words, because the person or the client's recovery UI acts on
 * them. The server keeps the real reason: in its log and in the route's own failure hooks, never on the wire.
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

const TOOL_LIST = 'Available tools: lookup_lookup, bash, edit, ledger_ledger, list_facts_list_facts.'
/** What a box harness reports when it stops a turn after the model repeats a refused tool call. */
const HARNESS_FAILURE = 'opencode execution failed: opencode sent the same save_fact call 3 times and every one was rejected. '
  + `The turn stopped before it ran the model again: Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST} (killed by SIGTERM)`
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
  let failureReason: string | undefined
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
    onTurnComplete: async (input) => { failureReason = input.failureReason },
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
    failureReason,
  }
}

function expectNoRawReason(result: Awaited<ReturnType<typeof turn>>, fragments = RAW_FRAGMENTS): void {
  for (const fragment of fragments) {
    expect(result.wire).not.toContain(fragment)
    expect(JSON.stringify(result.row)).not.toContain(fragment)
  }
}

describe('a failed turn never shows the person the raw failure reason', () => {
  it.each(['error event', 'severed stream'] as const)('a harness failure before any text reads as one plain sentence, live and stored (%s)', async (carrier) => {
    const result = carrier === 'error event'
      ? await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE, reason: 'provider_error',
        details: { supportDetails: HARNESS_FAILURE, hint: 'Call save_fact once more.' } } }])
      : await turn([], { severed: new Error(HARNESS_FAILURE) })

    expect(result.text).toBe(PLAIN)
    expect(result.error?.message).toBe(PLAIN)
    // The detail fields a client renders as text are dropped with the reason.
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

  it('never carries the tool list in a tool part, live or stored, and words the repair tool plainly', async () => {
    const refused = `Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST}`
    const answer = 'Here is the answer.'
    const result = await turn([
      // The harness's repair tool stands in for the call to a tool the model does not have.
      { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'invalid', state: { status: 'completed',
        input: { tool: 'save_fact', error: refused }, output: `The arguments provided to the tool are invalid: ${refused}` } } } },
      // The loop guard's stop message, in another tool's error field.
      { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-2', tool: 'bash', state: { status: 'error',
        input: { command: 'ls' }, error: `The same call repeated 3 times. ${TOOL_LIST}` } } } },
      { type: 'message.part.updated', data: { part: { type: 'text', id: 't1', text: answer }, delta: answer } },
      { type: 'result', data: { finalText: answer } },
    ])

    expectNoRawReason(result, ['Available tools', 'list_facts_list_facts', 'lookup_lookup'])
    expect(result.row?.content).toBe(answer)
    for (const shown of [result.wire, JSON.stringify(result.row?.parts)]) {
      expect(shown).toContain("That tool isn't available.")
      expect(shown).toContain('The same call repeated 3 times.')
    }
  })

  it('shows a Router budget refusal as the Router\'s own sentence, without the harness wrapper', async () => {
    const sentence = "This key's lifetime budget is exhausted. Increase the cap on id.tangle.tools."
    const result = await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED',
      message: `opencode execution failed: ${sentence} (exit code 1)` } }])

    expect(result.text).toBe(sentence)
    expect(result.error?.message).toBe(sentence)
    expect(result.row?.content).toBe(sentence)
  })

  it.each([
    { kind: 'funding', card: true, data: { code: 'insufficient_credits', message: 'Insufficient credits. Add funds to continue.' } },
    { kind: 'admission', card: true,
      data: { message: 'opencode execution failed: Inference requires verified paid access. Add funds or activate a paid seat.' } },
    { kind: 'billing', card: false,
      data: { code: 'AGENT_EXECUTION_FAILED', statusCode: 402, message: 'opencode execution failed: The provider refused payment for this call.' } },
    { kind: 'payment', card: false, data: { code: 'PAYMENT_REQUIRED', message: 'The account has no balance or plan for this request.' } },
    { kind: 'model policy', card: false, data: { code: 'MODEL_REFUSED', message: 'The selected model is outside the allowed models.' } },
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

  it('keeps the real reason for the server: its warn log and the route failure hooks, never the wire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await turn(
        [{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE, sessionId: 'session-1', executionId: 'execution-1' } }],
        { serverLog: 'default' },
      )

      expect(result.row?.content).toBe(PLAIN)
      expectNoRawReason(result)
      expect(result.failureReason).toBe(HARNESS_FAILURE)
      expect(warn).toHaveBeenCalledWith('[chat-routes] turn failure withheld from the person', {
        failureClass: 'runtime_failure',
        code: 'AGENT_EXECUTION_FAILED',
        error: HARNESS_FAILURE,
        sessionId: 'session-1',
        executionId: 'execution-1',
      })
    } finally {
      warn.mockRestore()
    }
  })
})
