import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createRouterTurnProducer } from '../../src/chat-routes/router-producer'
import type { RouterTurnOptions } from '../../src/runtime/router-turn'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

type Case = 'answered' | 'tool-failed'

/**
 * Real HTTP model and tool peers, the chat routes' Router producer and SQLite persistence; no model spend.
 * A round's text before its tool call narrates the work ("Let me look at the brief."): it is stored as a
 * reasoning part and left out of the answer when the model answers after the tool, and kept as the answer
 * when nothing follows the tool (here the tool fails and the model writes nothing more).
 */
it.each<Case>(['answered', 'tool-failed'])('keeps narration before a tool call out of the answer: %s', async mode => {
  const { sqlite } = sqliteD1('CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, parts TEXT);')
  let calls = 0
  const peer = createServer((request, response) => {
    if (request.url === '/brief') {
      response.writeHead(mode === 'answered' ? 200 : 503, { 'content-type': 'application/json' })
      response.end(JSON.stringify(mode === 'answered' ? { brief: 'Warm, plain-spoken, no puns.' } : { error: 'unavailable' }))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', chunk => { chunks.push(Buffer.from(chunk)) }).on('end', () => {
      const bytes = Buffer.concat(chunks)
      const body = JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString())
      calls++
      const delta = calls === 1
        ? { content: 'Let me look at the brief for case ACME-1234.', tool_calls: [{ index: 0, id: 'brief-1', type: 'function',
          function: { name: 'read_brief', arguments: '{}' } }] }
        : { content: mode === 'answered' ? 'Here are three taglines that fit the brief.' : '' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta,
        finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`
  const options: RouterTurnOptions = {
    apiKey: 'local-no-spend', model: 'local/primary', baseUrl, api: 'chat', repeat: false,
    systemPrompt: 'Answer the member.', userMessage: 'Suggest three taglines that fit my brief.',
    tools: [{ name: 'read_brief', description: 'Read the brief.', inputSchema: { type: 'object' },
      async run(_args, context) {
        const reply = await fetch(`${baseUrl}/brief`, { signal: context.signal })
        if (!reply.ok) throw Object.assign(new Error('Brief unavailable'), { code: 'brief_unavailable' })
        return reply.json()
      } }],
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
  const pending: Promise<unknown>[] = []
  try {
    const routes = createChatTurnRoutes({ projectId: 'router-narration', store,
      turnStore: createMemoryTurnEventStore(), turnTrace: false,
      // A product redactor applies to every stored part a reader sees as words, the narration too.
      transformFinalText: text => text.replaceAll(/ACME-\d+/g, '[REDACTED]'),
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
      produce: { router: args => createRouterTurnProducer({ ...options, admitted: args.admitted }) },
    })
    const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: options.userMessage }) }),
    { waitUntil: work => { pending.push(work) } })
    expect(response.status).toBe(200)
    await response.text()
    await Promise.all(pending)
    expect(calls).toBe(2)

    const [assistant] = sqlite.prepare("SELECT content, parts FROM messages WHERE role = 'assistant'").all() as Array<{ content: string; parts: string }>
    const parts = (JSON.parse(assistant!.parts) as Array<Record<string, unknown>>)
      .map(part => part.type === 'tool' ? { type: 'tool', status: (part.state as { status: string }).status } : { type: part.type, text: part.text })
    if (mode === 'answered') {
      expect(assistant!.content).toBe('Here are three taglines that fit the brief.')
      expect(parts).toEqual([
        { type: 'reasoning', text: 'Let me look at the brief for case [REDACTED].' },
        { type: 'tool', status: 'completed' },
        { type: 'text', text: 'Here are three taglines that fit the brief.' },
      ])
    } else {
      // Nothing followed the failed tool, so the narration is the only text and stays the answer.
      expect(assistant!.content).toBe('Let me look at the brief for case [REDACTED].')
      expect(parts).toEqual([
        { type: 'text', text: 'Let me look at the brief for case [REDACTED].' },
        { type: 'tool', status: 'error' },
      ])
    }
  } finally {
    peer.closeAllConnections()
    await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()))
    sqlite.close()
  }
}, 15_000)
