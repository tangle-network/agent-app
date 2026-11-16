/**
 * A failed turn shows the person one plain sentence, live and after a reload, and never the harness's own failure
 * text: its loop report, the refused tool and the list of every tool it has, in the answer, a notice, a tool part, a
 * raw harness event or any failure event. Funding, billing, admission and model-policy refusals keep their words, without
 * the harness's wrapper, because the person or the client's recovery UI acts on them. The server keeps the real reason:
 * in its log and in the route's own failure hooks, never on the wire.
 *
 * Driven through the real `createChatTurnRoutes` assembly, the real sandbox and protected producers, the detached lane
 * and the real chat store over SQLite. Only the box (its event stream, or a severed one) and the model grant service at
 * its HTTP boundary are stood in for.
 */

import type { AgentCandidateModelPort } from '@tangle-network/agent-runtime/candidate-execution'
import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  runDetachedTurn,
  type ChatTurnMessageStore,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import { recoverSandboxAssistantMessage } from '../../src/chat-routes/completed-sandbox-turn'
import { personFacing } from '../../src/chat-routes/failure-wording'
import { ModelFailoverExhaustedError } from '../../src/model-resolution/failover'
import { createProtectedRuntimeChatProducer } from '../../src/chat-routes/protected-runtime-producer'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createChatTables } from '../../src/chat-store/schema'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { getChatFundingRecovery } from '../../src/web/turn-funding-recovery'
import { openDatabase, workspacesTable } from '../teams/db-helper'

// The sentences a person reads, one per class: written by agent-app, never taken from the failure.
const PLAIN = 'That answer stopped before it finished. Please send your question again.'
const FUNDING = 'Insufficient credits. Open billing to add funds before trying again.'
const PAID = 'Paid access required. Inference requires verified paid access. Open billing to check your funded balance or paid seat before trying again.'
const BUDGET = "This assistant's spending budget is used up. Raise its cap or wait for it to reset, then send again."
const BALANCE = 'Insufficient credits to cover this request. Add funds, then send again.'
const POLICY = "That model isn't available here. Choose another model and send again."
/** A refusal's sentence after the lead line a client recognizes a stored failure by. */
const led = (sentence: string) => `The sandbox agent returned an error before producing a visible answer.\n\nError: ${sentence}`

const TOOL_LIST = 'Available tools: lookup_lookup, bash, edit, ledger_ledger, list_facts_list_facts.'
const LIST_FRAGMENTS = ['Available tools', 'list_facts_list_facts', 'lookup_lookup']
/** What a box harness reports when it stops a turn after the model repeats a refused tool call. */
const HARNESS_FAILURE = 'opencode execution failed: opencode sent the same save_fact call 3 times and every one was rejected. '
  + `The turn stopped before it ran the model again: Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST} (killed by SIGTERM)`
const RAW_FRAGMENTS = ['execution failed', 'save_fact', 'SIGTERM', '/v1/', ...LIST_FRAGMENTS]
const REFUSED_CALL = `Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST}`
/** The harness's repair tool standing in for a call to a tool the model does not have. */
const REPAIR_PART = { type: 'tool', id: 'call-1', tool: 'invalid', state: { status: 'completed',
  input: { tool: 'save_fact', error: REFUSED_CALL }, output: `The arguments provided to the tool are invalid: ${REFUSED_CALL}` } }

const tables = createChatTables({ workspaceTable: workspacesTable })

type WireEvent = { type: string; turnId?: string; text?: string; noticeKind?: string; data?: { message?: string; code?: string; details?: unknown } }

const textPart = (text: string) => ({ type: 'message.part.updated', data: { part: { type: 'text', id: 't1', text }, delta: text } })
const terminalError = { type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE } }

/** The box's events for one turn and then, when `severed` is given, a dropped stream. */
async function* box(events: unknown[], severed?: Error): AsyncGenerator<unknown> {
  for (const event of events) yield event
  if (severed) throw severed
}

/** One chat turn through the route: the box sends `events`, or `produce` builds the producer. */
async function turn(events: unknown[], options: {
  severed?: Error
  serverLog?: 'default'
  redactValues?: string[]
  produce?: () => ChatTurnRouteProducer
} = {}) {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS 1' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
  const pending: Promise<unknown>[] = []
  const turnStore = createMemoryTurnEventStore()
  let failureReason: string | undefined
  let failed: boolean | undefined
  const routes = createChatTurnRoutes({
    projectId: 'failed-turn-text',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store: store as unknown as ChatTurnMessageStore,
    turnStore,
    produce: options.produce ?? (() => createSandboxChatProducer({
      events: box(events, options.severed),
      model: 'm',
      ...(options.serverLog === 'default' ? {} : { log: () => {} }),
    })),
    ...(options.redactValues ? { redactValues: () => options.redactValues! } : {}),
    onTurnComplete: async (input) => { failureReason = input.failureReason; failed = input.failed },
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
    buffered: (await turnStore.read(streamed.find((event) => event.type === 'turn')!.turnId!, 0)).map((row) => row.event).join('\n'),
    streamed,
    text: streamed.filter((event) => event.type === 'text').map((event) => event.text).join(''),
    error: streamed.find((event) => event.type === 'error')?.data,
    row: rows.find((row) => row.role === 'assistant'),
    failureReason,
    failed,
  }
}

function expectNoRawReason(result: { wire: string; buffered?: string; row?: unknown }, fragments = RAW_FRAGMENTS): void {
  for (const fragment of fragments) {
    expect(result.wire).not.toContain(fragment)
    expect(result.buffered ?? '').not.toContain(fragment)
    expect(JSON.stringify(result.row ?? null)).not.toContain(fragment)
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
    const result = await turn([textPart(answer), terminalError])

    expect(result.text).toBe(`${answer}\n\n---\n${PLAIN}`)
    expect(result.error?.message).toBe(PLAIN)
    expect(result.row?.content).toBe(`${answer}\n\n---\n${PLAIN}`)
    expectNoRawReason(result)
  })

  it.each([
    { message: HARNESS_FAILURE, code: 'AGENT_EXECUTION_FAILED', name: 'TimeoutError', origin: 'runtime', endpoint: '/agents/run/stream' },
    { message: HARNESS_FAILURE, stack: `Error: ${HARNESS_FAILURE}\n at run (/srv/runtime.js:1:1)` },
    { message: HARNESS_FAILURE, turnId: { message: HARNESS_FAILURE }, code: { message: HARNESS_FAILURE },
      status: { message: HARNESS_FAILURE }, statusCode: { message: HARNESS_FAILURE }, retryable: { message: HARNESS_FAILURE },
      retryAt: { message: HARNESS_FAILURE }, resetAt: { message: HARNESS_FAILURE }, reason: 'private_failure_identifier',
      usage: { inputTokens: { message: HARNESS_FAILURE }, [HARNESS_FAILURE]: 1 },
      tokenUsage: { outputTokens: { message: HARNESS_FAILURE } }, details: { code: { message: HARNESS_FAILURE }, class: HARNESS_FAILURE } },
  ])('allows only typed failure data on the wire, in the buffer and in the row (%j)', async (data) => {
    const result = await turn([{ type: 'error', stack: HARNESS_FAILURE, data }])

    expect(result.text).toBe(PLAIN)
    expect(result.error?.message).toBe(PLAIN)
    expect(result.row?.content).toBe(PLAIN)
    expect(result.buffered).toContain(PLAIN)
    expectNoRawReason(result, [...RAW_FRAGMENTS, 'TimeoutError', 'runtime', '/agents/run/stream', '/srv/', 'private_failure_identifier'])
  })

  it('keeps typed retry fields and numeric usage, while withholding error metadata', async () => {
    const values = { turnId: 'turn-1', threadId: 'thread-1', sessionId: 'session-1', executionId: 'execution-1',
      code: 'AGENT_EXECUTION_FAILED', statusCode: 503, retryable: true, retryAt: 2_000, resetAt: 3_000, reason: 'provider_error',
      usage: { inputTokens: 4, outputTokens: 2 }, tokenUsage: { inputTokens: 4, outputTokens: 2, cost: 0.01 },
      details: { code: 'E1', retryable: false } }
    const result = await turn([{ type: 'error', data: { ...values, message: HARNESS_FAILURE } }])

    expect(result.error).toEqual({ ...values, message: PLAIN })
    expect(result.text).toBe(PLAIN)
    expect(result.row?.content).toBe(PLAIN)
    expectNoRawReason(result)
  })

  it('drops a harness warning from the wire and the stored row, logged as a harness warning, while the terminal error reads the plain sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await turn([{ type: 'warning', data: { code: 'OPENCODE_ERROR', message: HARNESS_FAILURE } }, terminalError],
        { serverLog: 'default' })

      expect(result.streamed.filter((event) => event.type === 'warning' || event.type === 'notice')).toEqual([])
      expect(JSON.stringify(result.row?.parts)).not.toContain('OPENCODE_ERROR')
      expect(result.error?.message).toBe(PLAIN)
      expect(result.text).toBe(PLAIN)
      expect(result.row?.content).toBe(PLAIN)
      expectNoRawReason(result)
      // The dropped warning is a harness warning in the log, never a turn failure.
      expect(warn).toHaveBeenCalledWith('[chat-routes] harness warning withheld from the person',
        expect.objectContaining({ failureClass: 'harness_warning', code: 'OPENCODE_ERROR' }))
      expect(warn.mock.calls.filter(([, meta]) => (meta as { code?: string } | undefined)?.code === 'OPENCODE_ERROR'
        && (meta as { failureClass?: string }).failureClass === 'runtime_failure')).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['empty_visible_output_retry', 'The model returned no visible answer, so it is trying once more.'],
    ['OPENCODE_STEP_TRUNCATED', 'A step of this answer was cut short, so the answer may be incomplete.'],
    ['CODEX_UNEXPECTED_APPROVAL', 'The agent asked for an approval it does not need here, and it was declined.'],
    ['FILE_DENIED', 'The agent was refused access to a file.'],
  ])('shows an allowed %s warning as the sentence written for it, never its own text', async (code, sentence) => {
    const answer = 'Here is the answer.'
    const result = await turn([{ type: 'warning', data: { code, message: `${code}: POST /v1/files failed at /srv/app.js:1:1` } },
      textPart(answer), { type: 'result', data: { finalText: answer } }])

    expect(result.streamed.filter((event) => event.type === 'notice').map((event) => event.text)).toEqual([sentence])
    expect(result.streamed.find((event) => event.type === 'warning')?.data).toEqual({ code, message: sentence })
    expect(JSON.stringify(result.row?.parts)).toContain(sentence)
    expect(result.row?.content).toBe(answer)
    expectNoRawReason(result, ['/v1/', '/srv/'])
  })

  it.each([
    ['a data.error string', { type: 'error', data: { error: HARNESS_FAILURE } }],
    ['a raw error', { type: 'raw', data: { backend: 'opencode', event: { type: 'error', error: { name: 'UnknownError', data: { message: HARNESS_FAILURE } } } } }],
    ['a raw turn.failed', { type: 'raw', data: { backend: 'codex', event: { type: 'turn.failed',
      error: { message: `stream error: POST /v1/responses returned HTTP 500 Internal Server Error. ${TOOL_LIST}` } } } }],
    ['a raw error item', { type: 'raw', data: { backend: 'codex', event: { type: 'item.completed',
      item: { id: 'item-1', type: 'error', message: HARNESS_FAILURE } } } }],
    ['a raw failure with tool and SDK metadata', { type: 'raw', stack: HARNESS_FAILURE,
      data: { stack: HARNESS_FAILURE, event: { type: HARNESS_FAILURE, part: REPAIR_PART,
        error: { message: HARNESS_FAILURE }, endpoint: '/v1/responses', stack: HARNESS_FAILURE } } }],
    ['a failed status', { type: 'status', data: { status: 'failed', detail: HARNESS_FAILURE } }],
    ['a failed done', { type: 'done', data: { status: 'failed', message: HARNESS_FAILURE } }],
    ['a session.run.failed', { type: 'session.run.failed', data: { message: HARNESS_FAILURE } }],
    ['a session.error', { type: 'session.error', data: { type: 'session.error',
      properties: { sessionID: 'session-1', error: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE } } } }],
  ])('carries no reason on %s before the terminal error, live or stored, and adds no notice', async (_kind, before) => {
    const result = await turn([before, terminalError])

    expect(result.text).toBe(PLAIN)
    expect(result.streamed.filter((event) => event.type === 'notice')).toEqual([])
    expect(result.streamed.filter((event) => event.type === 'error').every((event) => event.data?.message === PLAIN)).toBe(true)
    expect(result.row?.content).toBe(PLAIN)
    expectNoRawReason(result)
  })

  it('never carries the tool list in a tool part, live or stored, and words the repair tool plainly', async () => {
    const answer = 'Here is the answer.'
    const result = await turn([
      { type: 'message.part.updated', data: { part: REPAIR_PART } },
      // The loop guard's stop message, in another tool's error field.
      { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-2', tool: 'bash', state: { status: 'error',
        input: { command: 'ls' }, error: `The same call repeated 3 times. ${TOOL_LIST}` } } } },
      textPart(answer),
      { type: 'result', data: { finalText: answer } },
    ])

    expectNoRawReason(result, LIST_FRAGMENTS)
    expect(result.text).toBe(answer)
    expect(result.row?.content).toBe(answer)
    for (const shown of [result.wire, JSON.stringify(result.row?.parts)]) {
      expect(shown).toContain("That tool isn't available.")
      expect(shown).toContain('The same call repeated 3 times.')
    }
  })

  it.each(['tool_result', 'tool.result'])('filters a flat %s before it is streamed and stored', async (type) => {
    const answer = 'Here is the answer.'
    const result = await turn([
      { type, data: { id: 'call-failed', name: 'bash', status: 'error',
        error: `The same call repeated 3 times. ${TOOL_LIST}`, output: `Call refused. ${TOOL_LIST}` } },
      { type, data: { id: 'call-invalid', name: 'invalid', output: REFUSED_CALL } },
      textPart(answer),
      { type: 'result', data: { finalText: answer } },
    ])

    expectNoRawReason(result, LIST_FRAGMENTS)
    const outcomes = result.streamed.filter((event) => event.type === 'tool_result')
    expect(outcomes).toEqual([
      { type: 'tool_result', toolCallId: 'call-failed', toolName: 'bash',
        outcome: { ok: false, result: 'Call refused.', message: 'The same call repeated 3 times.' } },
      { type: 'tool_result', toolCallId: 'call-invalid', toolName: 'invalid',
        outcome: { ok: true, result: "That tool isn't available." } },
    ])
    expect(JSON.stringify(result.row?.parts)).toContain("That tool isn't available.")
    expect(result.row?.content).toBe(answer)
  })

  it('never carries the tool list in a raw harness tool event', async () => {
    const answer = 'Here is the answer.'
    const result = await turn([
      { type: 'raw', data: { backend: 'opencode', event: { type: 'tool_use', part: REPAIR_PART } } },
      textPart(answer),
      { type: 'result', data: { finalText: answer } },
    ])

    expectNoRawReason(result, LIST_FRAGMENTS)
    expect(result.wire).toContain("That tool isn't available.")
    expect(result.text).toBe(answer)
    expect(result.row?.content).toBe(answer)
  })

  it('keeps a document a tool read whole, even when it mentions available tools', async () => {
    const document = 'Workshop notes.\nAvailable tools: hammer, saw, level.'
    const answer = 'The workshop has a hammer, a saw and a level.'
    const result = await turn([
      { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'read',
        state: { status: 'completed', input: { path: 'notes.md' }, output: document } } } },
      textPart(answer),
      { type: 'result', data: { finalText: answer } },
    ])

    const toolResult = result.streamed.find((event) => event.type === 'tool_result') as { outcome?: { result?: unknown } } | undefined
    expect(toolResult?.outcome?.result).toBe(document)
    expect(JSON.stringify(result.row?.parts)).toContain(JSON.stringify(document))
    expect(result.row?.content).toBe(answer)
  })

  it('reads a recovered row as a live one: no tool list in its tool parts', () => {
    const recovered = recoverSandboxAssistantMessage({ id: 'message-1', role: 'assistant',
      parts: [REPAIR_PART, { type: 'text', id: 't1', text: 'Here is the answer.' }] } as unknown as Parameters<typeof recoverSandboxAssistantMessage>[0])

    expectNoRawReason({ wire: '', row: recovered }, LIST_FRAGMENTS)
    expect(JSON.stringify(recovered.parts)).toContain("That tool isn't available.")
    expect(recovered.text).toBe('Here is the answer.')
  })

  it.each([
    { kind: 'budget', message: "This key's lifetime budget is exhausted. Increase the cap at https://example.test/keys.", shown: BUDGET, text: BUDGET },
    { kind: 'balance', message: "Available credits cannot cover this request's maximum cost and other in-flight requests. Top up at example.test.",
      shown: BALANCE, text: led(BALANCE) },
  ])('shows a Router $kind refusal as the sentence written for it', async ({ message, shown, text }) => {
    const result = await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: `opencode execution failed: ${message} (exit code 1)` } }])

    expect(result.text).toBe(text)
    expect(result.error?.message).toBe(shown)
    expect(result.row?.content).toBe(text)
    expectNoRawReason(result, ['execution failed', 'exit code', 'example.test', 'Increase the cap', 'Top up'])
  })

  it.each([undefined, 402])('shows a monthly spending cap as budget, without a billing card (HTTP %s)', async (statusCode) => {
    const result = await turn([{ type: 'error', data: { code: 'budget_exceeded', statusCode,
      message: 'Monthly budget exceeded (used: 8, limit: 8)' } }])

    expect(result.error?.message).toBe(BUDGET)
    expect(result.error?.code).toBe('budget_exceeded')
    expect(result.text).toBe(BUDGET)
    expect(result.row?.content).toBe(BUDGET)
    expect(getChatFundingRecovery({ code: result.error?.code, message: result.error?.message })).toBe(null)
    expect(getChatFundingRecovery(result.row?.content)).toBe(null)
    expectNoRawReason(result, ['Monthly budget exceeded', 'used: 8'])
  })

  it('classifies the monthly budget phrase when a harness replaces the Router code', async () => {
    const result = await turn([{ type: 'error', data: { message: 'Monthly budget exceeded (used: 8, limit: 8)' } }])
    expect(result.error?.message).toBe(BUDGET)
    expect(result.text).toBe(BUDGET)
    expect(result.row?.content).toBe(BUDGET)
  })

  it('keeps a typed budget cap ahead of HTTP 402 funding when the reason is unrecognized', async () => {
    const result = await turn([{ type: 'error', data: { code: 'budget_exceeded', statusCode: 402, message: 'The request was refused.' } }])
    expect(result.error?.message).toBe(BUDGET)
    expect(result.text).toBe(BUDGET)
    expect(result.row?.content).toBe(BUDGET)
    expect(getChatFundingRecovery({ code: result.error?.code, message: result.error?.message })).toBe(null)
  })

  it.each(['error', 'session.error', 'raw'])('keeps a nested funding code on the %s carrier', async (type) => {
    const error = { code: 'insufficient_credits', message: 'Payment required' }
    const data = type === 'raw' ? { event: { type: 'error', error, stack: HARNESS_FAILURE } }
      : type === 'session.error' ? { properties: { error } } : { error }
    const result = await turn([{ type, data }, ...(type === 'error' ? [] : [{ type: 'error', data: { error } }])])

    expect(result.error?.message).toBe(FUNDING)
    expect(result.error?.code).toBe('insufficient_credits')
    expect(result.text).toBe(led(FUNDING))
    expect(result.row?.content).toBe(led(FUNDING))
    if (type === 'raw') expect(result.streamed.find((event) => event.type === 'raw')?.data).toMatchObject({
      code: 'insufficient_credits', event: { code: 'insufficient_credits', message: FUNDING },
    })
    expectNoRawReason(result, ['Payment required', ...RAW_FRAGMENTS])
  })

  it.each(['insufficient_credits', 'paid_access_required', 'funding_required'])('keeps a thrown own funding code %s', async (code) => {
    const result = await turn([], { severed: Object.assign(new Error('Payment required'), { code }) })
    const shown = code === 'insufficient_credits' ? FUNDING : PAID
    expect(result.error?.message).toBe(shown)
    expect(result.error?.code).toBe(code)
    expect(result.text).toBe(led(shown))
    expect(result.row?.content).toBe(led(shown))
    expectNoRawReason(result, ['Payment required'])
  })

  it.each([
    { code: 'MODEL_REFUSED', message: 'Insufficient credits; reset at 2030-01-02T03:04:05Z', shown: POLICY },
    { code: 'paid_access_required', message: "This key's monthly budget is exhausted", shown: PAID },
  ])('classifies typed $code before conflicting phrases', async ({ code, message, shown }) => {
    const result = await turn([{ type: 'error', data: { code, message } }])
    expect(result.error?.message).toBe(shown)
    expect(result.text).toBe(led(shown))
    expect(result.row?.content).toBe(led(shown))
  })

  it.each([
    { last: { reason: 'connection reset', errorCode: undefined }, shown: PLAIN, code: 'sandbox.stream_failed' },
    { last: { reason: 'unclassified refusal | earlier text: Insufficient credits', errorCode: 'MODEL_REFUSED' }, shown: POLICY, code: 'MODEL_REFUSED' },
    { last: { reason: 'Monthly budget exceeded (used: 8, limit: 8)', errorCode: 'budget_exceeded' }, shown: BUDGET, code: 'budget_exceeded' },
  ])('classifies a thrown failover by its structured final attempt ($code)', async ({ last, shown, code }) => {
    const error = new ModelFailoverExhaustedError([
      { model: 'model-a', ok: false, reason: 'Insufficient credits', errorCode: 'insufficient_credits' },
      { model: 'model-b', ok: false, ...last },
    ])
    const result = await turn([], { severed: error })

    expect(result.error?.message).toBe(shown)
    expect(result.error?.code).toBe(code)
    expect(result.text).toBe(shown === POLICY ? led(shown) : shown)
    expect(result.row?.content).toBe(result.text)
    expectNoRawReason(result, ['model-a', 'model-b', 'connection reset', 'unclassified refusal', 'Monthly budget exceeded'])
  })

  it('reads a thrown 402 on the wire as in the text, as the funding sentence, logged under the funding class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const refused = Object.assign(new Error('POST /v1/chat/completions returned HTTP 402: The provider declined to bill this request.'),
        { status: 402, code: 'upstream_refused' })
      const result = await turn([], { severed: refused, serverLog: 'default' })

      expect(result.error?.message).toBe(FUNDING)
      expect(result.text).toBe(led(FUNDING))
      expect(result.row?.content).toBe(led(FUNDING))
      expectNoRawReason(result, ['/v1/', 'POST ', 'HTTP 402', 'declined to bill'])
      // Only the failure lines carry a class; other warnings (a trace export with no key) carry no meta.
      expect(warn.mock.calls.flatMap(([, meta]) => (meta as { failureClass?: string } | undefined)?.failureClass ?? []))
        .toEqual(['funding'])
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    { answer: 'Here is the full answer.', shown: 'The answer above is complete.' },
    { answer: '', shown: PLAIN },
  ])('reads a settlement failure after "$answer" as "$shown"', async ({ answer, shown }) => {
    const settlement = { type: 'error', data: { code: 'settlement_over_limit', message: 'Provider settlement exceeded execution limits' } }
    const result = await turn(answer ? [textPart(answer), settlement] : [settlement])

    expect(result.error).toMatchObject({ code: 'settlement_over_limit', message: shown })
    expect(result.text).toBe(answer ? `${answer}\n\n---\n${shown}` : shown)
    expect(result.failed).toBe(true)
    expectNoRawReason(result, ['exceeded execution limits'])
  })

  it('keeps a completed answer when a settlement reason contains funding words', async () => {
    const answer = 'Here is the full answer.'
    const result = await turn([textPart(answer), { type: 'error', data: { code: 'settlement_over_limit', message: 'Insufficient credits' } }])
    expect(result.error?.message).toBe('The answer above is complete.')
    expect(result.text).toBe(`${answer}\n\n---\nThe answer above is complete.`)
    expect(result.row?.content).toBe(result.text)
    expectNoRawReason(result, ['Insufficient credits'])
  })

  // A model failover trail: an earlier attempt's route, status and model id, then the last attempt's reason.
  const trail = (last: string, first = 'POST /v1/sandboxes/sbx_test/runtime/agents/run/stream returned HTTP 502 Bad Gateway') =>
    `All 2 model(s) failed. model-a: ${first} | model-b: ${last}`
  const TRAIL_FRAGMENTS = ['/v1/', 'POST ', 'model-a', 'model-b', 'model(s) failed', 'HTTP 502', 'Bad Gateway', 'example.test']
  const TRAIL_REASONS = [
    { kind: 'withheld', last: `opencode execution failed: the tool loop stopped. ${TOOL_LIST}`, shows: PLAIN },
    { kind: 'earlier attempt ignored', first: 'Insufficient credits for this request', last: 'upstream connection reset', shows: PLAIN },
    { kind: '402 payment', last: 'The account has no balance or plan for this request.', code: 'PAYMENT_REQUIRED', statusCode: 402, shows: FUNDING },
    { kind: 'funding words', last: 'POST /v1/chat/completions returned HTTP 402: Insufficient credits. Top up at https://example.test/billing.',
      shows: FUNDING },
    { kind: 'Router budget', last: "This key's monthly budget is exhausted. Increase the cap or wait for the next billing cycle.", shows: BUDGET },
    { kind: 'provider reset', last: 'Rate limit exceeded (HTTP 429); the provider asked to wait, reset at 2030-01-02T03:04:05Z',
      shows: 'The model provider asked us to wait. Try again after 03:04:05 UTC on 2030-01-02.' },
    { kind: 'policy denied', last: 'model "model-b" is not admitted by policy: the policy filter rejected it', code: 'model_policy_denied',
      shows: POLICY },
  ]
  const CARRIERS = ['error event', 'thrown stream', 'warning', 'done failed', 'status failed', 'session.run.failed', 'detached result']
  /** The wire event that carries each failure's sentence; an error event otherwise (the route turns a producer's
   *  session.run.failed into one). */
  const CARRIED_TYPE: Record<string, string> = { 'done failed': 'done', 'status failed': 'status' }

  /** One failure carrying `failure` on `carrier`: what reached the client, what was stored, and the sentence it shows. */
  async function trailFailure(carrier: string, failure: { message: string; code?: string; statusCode?: number }) {
    if (carrier === 'detached result') {
      const store = createMemoryTurnEventStore()
      const result = await runDetachedTurn({ store, turnId: 'detached-1', scopeId: 'thread-1',
        events: box([{ type: 'error', data: failure }]), log: () => {} })
      return { wire: (await store.read('detached-1', 0)).map((row) => row.event).join('\n'), stored: JSON.stringify(result), shown: result.error }
    }
    const { message, code, statusCode } = failure
    const events: Record<string, unknown[]> = {
      'error event': [{ type: 'error', data: failure }],
      warning: [{ type: 'warning', data: failure }],
      'done failed': [{ type: 'done', data: { ...failure, status: 'failed' } }],
      'status failed': [{ type: 'status', data: { status: 'failed', detail: message, code, statusCode } }],
      'session.run.failed': [{ type: 'session.run.failed', data: failure }],
    }
    const result = await turn(events[carrier] ?? [],
      carrier === 'thrown stream' ? { severed: Object.assign(new Error(message), { code, status: statusCode }) } : {})
    const carried = result.streamed.filter((event) => event.type === (CARRIED_TYPE[carrier] ?? 'error'))
      .map((event) => event.data as { message?: string; detail?: string } | undefined)
      .find((data) => data?.message !== undefined || data?.detail !== undefined)
    return { wire: result.wire, stored: JSON.stringify(result.row ?? null), shown: carried?.message ?? carried?.detail }
  }

  it.each(CARRIERS.flatMap((carrier) => TRAIL_REASONS.map((reason) => ({ carrier, ...reason }))))(
    'reads a model failover trail on the $carrier by its last attempt ($kind) as the sentence for its class',
    async ({ carrier, first, last, code, statusCode, shows }) => {
      const failure = { message: trail(last, first), ...(code ? { code } : {}), ...(statusCode ? { statusCode } : {}) }
      const { wire, stored, shown } = await trailFailure(carrier, failure)

      for (const fragment of TRAIL_FRAGMENTS) {
        expect(wire).not.toContain(fragment)
        expect(stored).not.toContain(fragment)
      }
      // No warning code here is allowed, so a warning carrier leaves nothing on the wire.
      if (carrier === 'warning') expect(wire).not.toMatch(/"type":"(?:warning|notice)"/)
      else expect(shown).toBe(shows)
      if (code && carrier !== 'warning') expect(wire).toContain(`"code":"${code}"`)
    })

  it.each([
    { kind: 'funding', card: true, shown: FUNDING, data: { code: 'insufficient_credits', message: 'Insufficient credits. Add funds to continue.' } },
    { kind: 'admission', card: true, shown: PAID,
      data: { message: `opencode execution failed: Inference requires verified paid access. Add funds or activate a paid seat. ${TOOL_LIST} (exit code 1)` } },
    { kind: 'billing', card: true, shown: FUNDING,
      data: { code: 'AGENT_EXECUTION_FAILED', statusCode: 402, message: 'opencode execution failed: The provider refused payment for this call.' } },
    { kind: 'payment', card: true, shown: FUNDING, data: { code: 'PAYMENT_REQUIRED', message: 'The account has no balance or plan for this request.' } },
    { kind: 'model policy', card: false, shown: POLICY, data: { code: 'MODEL_REFUSED', message: 'The selected model is outside the allowed models.' } },
  ])('the $kind refusal reads the sentence written for its class, where the person and the recovery UI read it', async ({ data, card, shown }) => {
    const refused = await turn([{ type: 'error', data }])

    expect(refused.text).toBe(led(shown))
    expect(refused.row?.content).toBe(led(shown))
    expect(refused.error?.message).toBe(shown)
    expectNoRawReason(refused, ['execution failed', 'exit code', 'Add funds or activate', 'refused payment', 'no balance or plan',
      'outside the allowed', ...LIST_FRAGMENTS])
    // The recovery UI reads the live error event and the stored reason alike.
    expect(getChatFundingRecovery({ code: refused.error?.code, message: refused.error?.message }) !== null).toBe(card)
    expect(getChatFundingRecovery(refused.row!.content.split('\n\nError: ')[1]) !== null).toBe(card)

    // The same route withholds a runtime failure, so the pass-through is a decision, not the absence of one.
    const failed = await turn([{ type: 'error', data: { message: HARNESS_FAILURE } }])
    expect(failed.row?.content).toBe(PLAIN)
  })

  const ANSWER = 'Here is the answer.'
  const ANSWERED = [textPart(ANSWER), { type: 'result', data: { finalText: ANSWER } }]
  // Harness text no cleaning rule anticipated: each reads only its class's sentence, live and stored.
  it.each([
    { kind: 'a stack after "Insufficient credits"', error: FUNDING, text: led(FUNDING), leaks: ['/srv/', 'at charge'],
      events: [{ type: 'error', data: { message: 'Insufficient credits\n    at charge (/srv/billing.js:10:5)\n    at run (/srv/app.js:20:1)' } }] },
    { kind: 'a host and /v1 route without a scheme', error: PLAIN, text: PLAIN, leaks: ['example.test', '/v1/', 'socket hang up'],
      events: [{ type: 'error', data: { message: 'request to router.example.test/v1/chat/completions failed: socket hang up' } }] },
    { kind: 'a JSON 402 body', error: FUNDING, text: led(FUNDING), leaks: ['Payment required for', 'model-a', 'payment_required'],
      events: [{ type: 'error', data: { statusCode: 402,
        message: '{"error":{"code":402,"message":"Payment required for model-a","type":"payment_required"}}' } }] },
    { kind: 'a data.error object with harness support details', error: PLAIN, text: PLAIN, leaks: RAW_FRAGMENTS,
      events: [{ type: 'error', data: { error: { code: 'AGENT_EXECUTION_FAILED', message: HARNESS_FAILURE },
        details: { supportDetails: HARNESS_FAILURE } } }] },
    { kind: 'a raw Codex error message', error: PLAIN, text: PLAIN, leaks: ['example.test', '/v1/', 'stream disconnected'],
      events: [{ type: 'raw', data: { backend: 'codex', event: { type: 'error',
        message: 'stream disconnected before completion: error sending request for url (https://api.example.test/v1/responses)' } } },
      terminalError] },
    { kind: 'a raw OpenCode retry message', notices: ['The model provider is busy; retrying at 03:04:05 UTC.'], text: ANSWER,
      leaks: ['example.test', 'Provider returned'],
      events: [{ type: 'raw', data: { backend: 'opencode', event: { type: 'retry', attempt: 1, next: Date.UTC(2030, 0, 2, 3, 4, 5),
        message: 'Provider returned 503 from https://api.example.test/v1/chat' } } }, ...ANSWERED] },
    { kind: 'a session.error data message', error: PLAIN, text: PLAIN, leaks: ['example.test', '/v1/', 'APIError'],
      events: [{ type: 'session.error', data: { properties: { sessionID: 'session-1',
        error: { name: 'APIError', data: { message: 'POST https://api.example.test/v1/chat returned 500' } } } } }, terminalError] },
    { kind: 'details.stderr', error: PLAIN, text: PLAIN, details: { code: 'E1', retryable: false }, leaks: ['Traceback', '/srv/'],
      events: [{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: 'agent exited with code 1',
        details: { stderr: 'Traceback (most recent call last):\n  File "/srv/agent.py", line 3', code: 'E1', retryable: false } } }] },
    { kind: 'an unknown warning with a provider 503', text: ANSWER, leaks: ['example.test', '503 Service', 'PROVIDER_UNAVAILABLE'],
      events: [{ type: 'warning', data: { code: 'PROVIDER_UNAVAILABLE',
        message: 'Provider returned 503 Service Unavailable from https://api.example.test/v1' } }, ...ANSWERED] },
  ])('$kind reads only the sentence for its class', async ({ events, error, text, notices, details, leaks }) => {
    const result = await turn(events)

    expect(result.error?.message).toBe(error)
    expect(result.error?.details).toEqual(details)
    expect(result.text).toBe(text)
    expect(result.row?.content).toBe(text)
    expect(result.streamed.filter((event) => event.type === 'notice').map((event) => event.text)).toEqual(notices ?? [])
    expectNoRawReason(result, leaks)
  })

  it('classifies a 32 KB whitespace run in linear time', () => {
    const person = personFacing({ log: () => {}, failedTurnText: PLAIN })
    const reason = `All 2 model(s) failed. model-a: ${' '.repeat(16_384)} | model-b: Insufficient credits${' \t'.repeat(8_192)}x`
    const started = performance.now()
    const seen = person.view(reason)

    expect(performance.now() - started).toBeLessThan(50)
    expect(seen).toEqual({ class: 'funding', shown: FUNDING })
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

  it('keeps the redacted real reason for the route hooks when the product registers a secret', async () => {
    const secret = 'box-credential-0123456789'
    const reason = `${HARNESS_FAILURE} while reading ${secret}`
    const result = await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED', message: reason } }], { redactValues: [secret] })

    expect(result.failureReason).toBe(reason.replace(secret, '[redacted]'))
    expect(result.row?.content).toBe(PLAIN)
    expectNoRawReason(result, [...RAW_FRAGMENTS, secret])
  })

  it('words the detached result\'s error plainly and keeps the reason off its buffered stream', async () => {
    const store = createMemoryTurnEventStore()
    const result = await runDetachedTurn({ store, turnId: 'detached-1', scopeId: 'thread-1', events: box([terminalError]), log: () => {} })
    const buffered = (await store.read('detached-1', 0)).map((row) => row.event).join('\n')

    expect(result).toMatchObject({ state: 'failed', error: PLAIN, text: PLAIN })
    expectNoRawReason({ wire: buffered, row: result })
  })

  it('keeps a charged answer whole when its settlement fails afterwards: the turn fails, the person reads that it is complete', async () => {
    const model = 'anthropic/claude-haiku-4-5-20251001'
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    // The model grant service: it settles the answer's call, then reports usage beyond the grant's limits.
    const port: AgentCandidateModelPort = {
      resolve: async () => ({ requested: model, model, snapshot: model, provider: 'anthropic', reasoningEffort: 'none' as const }),
      reserveGrant: async (input) => ({ preparationId: input.preparationId, digest, expiresAtMs: input.expiresAtMs,
        enforcedLimits: input.limits, network: { mode: 'gateway-only', domains: ['candidate-router.tangle.tools'] } }),
      activateGrant: async () => ({ env: { OPENAI_API_KEY: 'scoped-fixture-token', OPENAI_BASE_URL: 'https://candidate-router.tangle.tools/v1' } }),
      settleGrant: async (input) => ({ preparationId: input.preparationId, grantDigest: digest, closed: true, usageWithinLimits: false,
        calls: [{ callId: 'call-1', generationId: 'generation-1', traceSpanId: 'generation-1', model, status: 'succeeded', startedAtMs: 1,
          endedAtMs: 2, inputTokens: 3, accountedInputTokens: 3, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0,
          costUsdNanos: 100_000, costProvenance: 'observed' }] }),
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'completion-1', object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Completed work.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, cost: 0.0001 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await turn([], { produce: () => createProtectedRuntimeChatProducer({
        profile: { name: 'protected-test', harness: 'cli-base', prompt: { systemPrompt: 'Answer.' },
          model: { provider: 'tangle-router', default: model, reasoningEffort: 'none', maxVisibleOutputTokens: 100 } },
        prompt: 'Summarize the brief.', tools: [], maxToolCalls: 0,
        grant: { port, resolve: { requested: model, harness: 'cli-base', reasoningEffort: 'none' },
          reserve: { executionId: 'execution-1', preparationId: 'preparation-1', bundleDigest: digest, expiresAtMs: Date.now() + 30_000,
            attempt: { number: 1, maxAttempts: 1, retryPolicy: 'none' },
            limits: { maxModelCalls: 3, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsd: 1 } },
          deadlineAtMs: Date.now() + 20_000 },
      }) })

      // The full answer stands; the turn still ends failed, so billing treats it as main does.
      expect(result.text).toBe('Completed work.')
      expect(result.row?.content).toBe('Completed work.')
      expect(result.failed).toBe(true)
      expect(result.error).toMatchObject({ code: 'settlement_over_limit', message: 'The answer above is complete.' })
      expect(result.streamed.filter((event) => event.type === 'notice').map((event) => event.text)).toEqual(['The answer above is complete.'])
      expect(result.wire).not.toMatch(/\bsend\b/i)
      expect(JSON.stringify(result.row)).not.toMatch(/\bsend\b/i)
      expectNoRawReason(result, ['exceeded execution limits'])
      expect(warn).toHaveBeenCalledWith('[chat-routes] turn failure withheld from the person',
        expect.objectContaining({ code: 'settlement_over_limit', error: expect.stringContaining('exceeded execution limits') }))
    } finally {
      warn.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
