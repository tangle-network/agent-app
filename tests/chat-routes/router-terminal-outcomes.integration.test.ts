import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createRouterTurnProducer } from '../../src/chat-routes/router-producer'
import { runRouterTurn, type RouterTurnOptions, type RouterTurnOutcome } from '../../src/runtime/router-turn'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { consumeTurnStream } from '../../src/stream/turn-observation'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_SCHEMA_SQL } from '../../src/rollout/d1'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

type Mode = 'deadline' | 'recovery' | 'fallback' | 'cancel' | 'durable'

/** Real HTTP model/tool peers, wall-clock budget, chat settlement and SQLite persistence. No model spend. */
it.each<Mode>(['deadline', 'recovery', 'fallback', 'cancel', 'durable'])('keeps Router terminal outcomes honest: %s', async mode => {
  const { sqlite, d1 } = sqliteD1(`${ROLLOUT_TURN_TIMING_SCHEMA_SQL}
    CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, parts TEXT);
    CREATE TABLE outcomes(failure TEXT, hops INTEGER, calls INTEGER);
    CREATE TABLE settlements(failed INTEGER);`)
  const timing = createD1TurnTimingStore({ db: d1 })
  const requested: string[] = []
  const toolRequests: string[] = []
  const cancellation = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const peer = createServer((request, response) => {
    if (request.url === '/work') {
      toolRequests.push(request.url)
      if (mode === 'cancel') {
        cancellation.abort(new DOMException('Member stopped the turn', 'AbortError'))
        return
      }
      const refuse = () => {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'CAPACITY_EXHAUSTED' }))
      }
      if (mode === 'deadline' || mode === 'durable') {
        const timer = setTimeout(() => { timers.delete(timer); refuse() }, 1200)
        timers.add(timer)
      } else refuse()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', chunk => { chunks.push(Buffer.from(chunk)) }).on('end', () => {
      const bytes = Buffer.concat(chunks)
      const body = JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString())
      requested.push(body.model)
      if (mode === 'fallback' && requested.length === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Local provider unavailable' } }))
        return
      }
      const useTool = mode !== 'fallback' && requested.length === 1
      const delta = useTool ? { content: 'Preparing the output.', tool_calls: [{ index: 0,
        id: 'work-1', type: 'function', function: { name: 'work', arguments: '{}' } }] }
        : { content: 'Here is an answer using the supplied information.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta,
        finish_reason: useTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`
  const options: RouterTurnOptions = {
    apiKey: 'local-no-spend', model: 'local/primary', baseUrl, api: 'chat',
    systemPrompt: 'Answer the member.', userMessage: 'Prepare the output.',
    budgetMs: mode === 'deadline' || mode === 'durable' ? 1000 : 10_000,
    repeat: mode === 'fallback', fallbackModels: ['local/fallback'],
    signal: cancellation.signal,
    tools: [{ name: 'work', description: 'Prepare output with the work service.', inputSchema: { type: 'object' },
      async run(_args, context) {
        const response = await fetch(`${baseUrl}/work`, { signal: context.signal })
        if (!response.ok) throw Object.assign(new Error('Work service unavailable'), { code: 'sandbox_unavailable' })
        return response.json()
      } }],
  }
  const outcomes: RouterTurnOutcome[] = []
  const pending: Promise<unknown>[] = []
  const record = async (turnId: string, failed: boolean, duration: number) => {
    sqlite.prepare('INSERT INTO settlements VALUES (?)').run(Number(failed))
    await timing.record({ rollout: 'terminal-truth', workspaceId: 'workspace', lane: 'loop',
      turnId, failed, settledMs: duration }, { throwOnError: true })
  }
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return sqlite.prepare('SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY rowid')
        .all(threadId) as Array<{ id: string; role: 'user' | 'assistant'; content: string }>
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
        .run(id, input.threadId, input.role, input.content, JSON.stringify(input.parts ?? []))
      return { id }
    },
  }
  try {
    if (mode === 'durable') {
      const outcome = await runRouterTurn(options)
      expect(requested).toEqual(['local/primary'])
      expect(toolRequests).toEqual(['/work'])
      expect(outcome.failure).toBeUndefined()
      expect(outcome.continuation?.hops).toBe(1)
      expect(outcome.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
      return
    }
    const routes = createChatTurnRoutes({ projectId: 'router-terminal', store,
      turnStore: createMemoryTurnEventStore(), turnTrace: false,
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
      produce: { router: args => createRouterTurnProducer({ ...options, admitted: args.admitted,
        signal: args.admissionSignal ? AbortSignal.any([args.admissionSignal, cancellation.signal]) : cancellation.signal,
        onOutcome(outcome) {
        outcomes.push(outcome)
        // Domain settlement observes this value before the producer projects its terminal frame.
        sqlite.prepare('INSERT INTO outcomes VALUES (?, ?, ?)')
          .run(outcome.failure?.code ?? null, outcome.continuation?.hops ?? null, outcome.usage.modelCalls)
      } }) },
      lifecycle: {
        onTurnComplete: info => record(info.turnStreamId, false, info.durationMs),
        onTurnError: info => record(info.turnStreamId, true, info.durationMs),
      },
    })
    const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: options.userMessage }) }),
    { waitUntil: work => { pending.push(work) } })
    expect(response.status).toBe(200)
    const wire = await response.text()
    await Promise.all(pending)
    const observation = await consumeTurnStream((async function* () { yield new TextEncoder().encode(wire) })(),
      { commit: async () => {} })
    const failure = mode === 'deadline' ? 'turn_deadline' : mode === 'cancel' ? 'turn_aborted' : null
    expect(requested).toEqual(mode === 'fallback' ? ['local/primary', 'local/fallback']
      : mode === 'recovery' ? ['local/primary', 'local/primary'] : ['local/primary'])
    expect(toolRequests).toEqual(mode === 'fallback' ? [] : ['/work'])
    expect(outcomes).toHaveLength(1)
    expect(sqlite.prepare('SELECT * FROM outcomes').all()).toEqual([
      { failure, hops: mode === 'deadline' ? 1 : null, calls: requested.length },
    ])
    expect(observation.outcome).toBe(failure ? 'failed' : 'completed')
    expect(sqlite.prepare('SELECT failed FROM settlements').all()).toEqual([{ failed: Number(Boolean(failure)) }])
    expect(sqlite.prepare('SELECT failed FROM rollout_turn_timing').all()).toEqual([{ failed: Number(Boolean(failure)) }])
    const messages = sqlite.prepare("SELECT parts FROM messages WHERE role = 'assistant'").all() as Array<{ parts: string }>
    expect(messages).toHaveLength(1)
    const parts = JSON.parse(messages[0].parts) as Array<Record<string, unknown>>
    if (failure) expect(parts).toContainEqual(expect.objectContaining({ type: 'notice', code: failure }))
    else expect(parts.filter(part => part.type === 'notice' && part.noticeKind === 'error')).toEqual([])
    if (mode === 'deadline') expect(outcomes[0].continuation?.messages.some(message => message.role === 'tool')).toBe(true)
    if (mode === 'recovery') expect(outcomes[0].toolCalls).toEqual([{ callId: 'work-1', toolName: 'work', ok: false }])
  } finally {
    for (const timer of timers) clearTimeout(timer)
    peer.closeAllConnections()
    await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()))
    sqlite.close()
  }
}, 15_000)
