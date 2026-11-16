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
import { createProtectedRuntimeChatProducer } from '../../src/chat-routes/protected-runtime-producer'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createChatTables } from '../../src/chat-store/schema'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { getChatFundingRecovery } from '../../src/web/turn-funding-recovery'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const PLAIN = 'That answer stopped before it finished. Please send your question again.'

const TOOL_LIST = 'Available tools: lookup_lookup, bash, edit, ledger_ledger, list_facts_list_facts.'
const LIST_FRAGMENTS = ['Available tools', 'list_facts_list_facts', 'lookup_lookup']
/** What a box harness reports when it stops a turn after the model repeats a refused tool call. */
const HARNESS_FAILURE = 'opencode execution failed: opencode sent the same save_fact call 3 times and every one was rejected. '
  + `The turn stopped before it ran the model again: Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST} (killed by SIGTERM)`
const RAW_FRAGMENTS = ['execution failed', 'save_fact', 'SIGTERM', ...LIST_FRAGMENTS]
const REFUSED_CALL = `Model tried to call unavailable tool 'save_fact'. ${TOOL_LIST}`
/** The harness's repair tool standing in for a call to a tool the model does not have. */
const REPAIR_PART = { type: 'tool', id: 'call-1', tool: 'invalid', state: { status: 'completed',
  input: { tool: 'save_fact', error: REFUSED_CALL }, output: `The arguments provided to the tool are invalid: ${REFUSED_CALL}` } }

const tables = createChatTables({ workspaceTable: workspacesTable })

type WireEvent = { type: string; text?: string; noticeKind?: string; data?: { message?: string; code?: string; details?: unknown } }

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
  let failureReason: string | undefined
  let failed: boolean | undefined
  const routes = createChatTurnRoutes({
    projectId: 'failed-turn-text',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
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
    streamed,
    text: streamed.filter((event) => event.type === 'text').map((event) => event.text).join(''),
    error: streamed.find((event) => event.type === 'error')?.data,
    row: rows.find((row) => row.role === 'assistant'),
    failureReason,
    failed,
  }
}

function expectNoRawReason(result: { wire: string; row?: unknown }, fragments = RAW_FRAGMENTS): void {
  for (const fragment of fragments) {
    expect(result.wire).not.toContain(fragment)
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

  it('drops a withheld harness warning from the wire and the stored row, while the terminal error reads the plain sentence', async () => {
    const result = await turn([{ type: 'warning', data: { code: 'OPENCODE_ERROR', message: HARNESS_FAILURE } }, terminalError])

    expect(result.streamed.filter((event) => event.type === 'warning' || event.type === 'notice')).toEqual([])
    expect(JSON.stringify(result.row?.parts)).not.toContain('OPENCODE_ERROR')
    expect(result.error?.message).toBe(PLAIN)
    expect(result.text).toBe(PLAIN)
    expect(result.row?.content).toBe(PLAIN)
    expectNoRawReason(result)
  })

  it.each([
    ['a raw error', { type: 'raw', data: { backend: 'opencode', event: { type: 'error', error: { name: 'UnknownError', data: { message: HARNESS_FAILURE } } } } }],
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

  it('shows a Router budget refusal as the Router\'s own sentence, without the harness wrapper', async () => {
    const sentence = "This key's lifetime budget is exhausted. Increase the cap on id.tangle.tools."
    const result = await turn([{ type: 'error', data: { code: 'AGENT_EXECUTION_FAILED',
      message: `opencode execution failed: ${sentence} (exit code 1)` } }])

    expect(result.text).toBe(sentence)
    expect(result.error?.message).toBe(sentence)
    expect(result.row?.content).toBe(sentence)
    expectNoRawReason(result, ['execution failed', 'exit code'])
  })

  it.each([
    { kind: 'funding', card: true, shown: 'Insufficient credits. Add funds to continue.',
      data: { code: 'insufficient_credits', message: 'Insufficient credits. Add funds to continue.' } },
    { kind: 'admission', card: true, shown: 'Inference requires verified paid access. Add funds or activate a paid seat.',
      data: { message: `opencode execution failed: Inference requires verified paid access. Add funds or activate a paid seat. ${TOOL_LIST} (exit code 1)` } },
    { kind: 'billing', card: false, shown: 'The provider refused payment for this call.',
      data: { code: 'AGENT_EXECUTION_FAILED', statusCode: 402, message: 'opencode execution failed: The provider refused payment for this call.' } },
    { kind: 'payment', card: false, shown: 'The account has no balance or plan for this request.',
      data: { code: 'PAYMENT_REQUIRED', message: 'The account has no balance or plan for this request.' } },
    { kind: 'model policy', card: false, shown: 'The selected model is outside the allowed models.',
      data: { code: 'MODEL_REFUSED', message: 'The selected model is outside the allowed models.' } },
  ])('the $kind refusal keeps its own words, without the harness wrapper, where the person and the recovery UI read them', async ({ data, card, shown }) => {
    const refused = await turn([{ type: 'error', data }])

    const stored = `The sandbox agent returned an error before producing a visible answer.\n\nError: ${shown}`
    expect(refused.text).toBe(stored)
    expect(refused.row?.content).toBe(stored)
    expect(refused.error?.message).toBe(shown)
    expectNoRawReason(refused, ['execution failed', 'exit code', ...LIST_FRAGMENTS])
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
