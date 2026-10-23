import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createHybridTurnProducer } from '../../src/chat-routes/hybrid-producer'
import { createRouterTurnProducer } from '../../src/chat-routes/router-producer'

// Real HTTP Router -> producer -> engine tool loop -> sandbox_run -> product box seam.
// The upstream deliberately substitutes code for the member's output contract.
it.each([{ long: false, resumed: false, opaque: false }, { long: true, resumed: false, opaque: false },
  { long: false, resumed: true, opaque: false }, { long: false, resumed: false, opaque: true }])('preserves the exact member contract at the box boundary ($long, resumed: $resumed)', async ({ long, resumed, opaque }) => {
  const memberRequest = '  Read /workspace/campaign.csv.\nWrite /workspace/report.json as JSON with numeric spendUsd, revenueUsd, and roas at the root.\nDo not nest them under totals.  ' + (long ? 'Additional context. '.repeat(1200) : '')
  const routerTask = 'Run Python and write {"totals":{"spendUsd":10,"revenueUsd":30,"roas":3}}.'
  const tasks: string[] = []
  let calls = 0
  const systemPrompts: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      systemPrompts.push(payload.messages[0].content)
      const delta = ++calls === 1
        ? { tool_calls: [{ index: 0, id: 'box-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: routerTask }) } }] }
        : { content: 'Report saved.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const producer = createHybridTurnProducer({
      apiKey: 'test-key', model: 'test-model',
      systemPrompt: { profile: opaque ? {} : { prompt: { systemPrompt: 'Complete the member request.' } },
        stable: ['Fixed workspace policy.'], context: [
          ...(opaque ? ['Complete the member request. Dynamic certified revision.'] : []),
          'This request context is carried only after all stable guidance.',
        ] },
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, userMessage: resumed ? 'ignored placeholder' : memberRequest,
      ...(resumed ? { continueFrom: { messages: [{ role: 'user' as const, content: memberRequest }], hops: 1, text: '' } } : {}),
      box: {
        acquire: async () => ({ id: 'test-box' }) as unknown as SandboxInstance,
        runTask: async (_box, task) => { tasks.push(task); return 'Report saved.' },
      },
    })
    for await (const _event of producer.stream) { /* drain the real tool loop */ }
    expect(calls).toBe(2)
    expect(systemPrompts).toHaveLength(2)
    for (const prompt of systemPrompts) {
      expect(prompt).toContain('Complete the member request.')
      expect(prompt).toContain('Fixed workspace policy.')
      expect(prompt).not.toContain('[object Object]')
      expect(prompt.indexOf('Fixed workspace policy.')).toBeLessThan(prompt.indexOf('This request context'))
      expect(prompt.indexOf('sandbox_run')).toBeLessThan(prompt.indexOf('This request context'))
    }
    expect(tasks).toHaveLength(1)
    const prefix = `The member's request (verbatim):\n${memberRequest}\n\nYour part of it:\n`
    expect(tasks[0]!.slice(0, prefix.length)).toBe(prefix)
    expect(tasks[0]!.slice(prefix.length)).toBe(routerTask.slice(0, Math.max(0, 20_000 - prefix.length)))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})


it.each([{ tool: 'sandbox_run', hybrid: true }, { tool: 'write_record', hybrid: true }, { tool: 'write_record', hybrid: false }])('owns promised credentials and fences $tool effects until admission commits (hybrid: $hybrid)', async ({ tool, hybrid }) => {
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE TABLE credential(key TEXT); INSERT INTO credential VALUES ('leased-key'); CREATE TABLE effect(name TEXT)")
  let admit: () => void = () => {}
  const admitted = new Promise<void>(resolve => { admit = resolve })
  let observed: () => void = () => {}
  const toolObserved = new Promise<void>(resolve => { observed = resolve })
  let calls = 0, disposed = 0, retired = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      expect(request.headers.authorization).toBe('Bearer leased-key')
      const delta = ++calls === 1
        ? { tool_calls: [{ index: 0, id: 'effect', function: { name: tool,
          arguments: JSON.stringify(tool === 'sandbox_run' ? { task: 'Read the file.' } : {}) } }] }
        : { content: 'Done.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const effect = (name: string) => { database.prepare('INSERT INTO effect VALUES (?)').run(name) }
  try {
    const key = { key: String((database.prepare('SELECT key FROM credential').get() as { key: string }).key),
      fetchImpl: fetch, revoke: async () => { retired++; database.prepare('DELETE FROM credential').run() } }
    const producer = (hybrid ? createHybridTurnProducer : createRouterTurnProducer)({
      apiKey: Promise.resolve(key), systemPrompt: Promise.resolve('Answer the member.'), admitted,
      model: 'requested/model', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, userMessage: 'Hello.',
      tools: [{ name: 'write_record', description: 'Write a record.', inputSchema: { type: 'object', properties: {} },
        run: async () => { effect('write_record'); return 'Done.' } }],
      box: {
        acquire: async () => { effect('acquire'); return { id: 'box' } as unknown as SandboxInstance },
        runTask: async () => { effect('sandbox_run'); return 'Done.' },
        dispose: () => { disposed++ },
      },
    })
    const draining = (async () => {
      for await (const event of producer.stream) if ((event as { type?: string }).type === 'tool_call') observed()
    })()
    await toolObserved
    expect(calls).toBe(1)
    expect(database.prepare('SELECT * FROM effect').all()).toEqual([])
    admit()
    await draining
    expect(calls).toBe(2)
    expect(database.prepare('SELECT name FROM effect ORDER BY rowid').all()).toEqual(
      tool === 'sandbox_run' ? [{ name: 'acquire' }, { name: 'sandbox_run' }] : [{ name: 'write_record' }])
    expect(database.prepare('SELECT * FROM credential').all()).toEqual([])
    expect(retired).toBe(1)
    expect(disposed).toBe(hybrid ? 1 : 0)
    expect(producer.finalText()).toBe('Done.')
    expect(producer.model).toBe('served/model')
    expect(producer.assistantParts?.().some(part => part.type === 'text')).toBe(true)
  } finally {
    admit()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    database.close()
  }
})

it.each(['prompt failure', 'unread stream cancellation', 'unread stream throw'])('retires a credential arriving after %s without waiting to expose the failure', async mode => {
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE TABLE credential(key TEXT); INSERT INTO credential VALUES ('late-key')")
  let arrive: (key: { key: string; revoke(): Promise<void> }) => void = () => {}
  const credential = new Promise<{ key: string; revoke(): Promise<void> }>(resolve => { arrive = resolve })
  let didRetire: () => void = () => {}
  const retired = new Promise<void>(resolve => { didRetire = resolve })
  let didDispose: () => void = () => {}
  const disposed = new Promise<void>(resolve => { didDispose = resolve })
  let revokes = 0, disposals = 0
  const producer = createHybridTurnProducer({
    apiKey: credential, model: 'model', userMessage: 'Hello.',
    systemPrompt: mode === 'prompt failure' ? Promise.reject(new Error('profile rejected')) : Promise.resolve('Answer.'),
    box: { acquire: async () => { throw new Error('no box should start') }, runTask: async () => { throw new Error('no task') },
      dispose: () => { disposals++; didDispose() } },
  })
  try {
    if (mode === 'prompt failure') {
      await expect((async () => { for await (const _event of producer.stream) { /* no provider starts */ } })()).rejects.toThrow('profile rejected')
    } else if (mode === 'unread stream cancellation') {
      await producer.stream[Symbol.asyncIterator]().return?.()
    } else {
      await expect(producer.stream[Symbol.asyncIterator]().throw?.(new Error('consumer stopped'))).rejects.toThrow('consumer stopped')
    }
    arrive({ key: 'late-key', revoke: async () => { revokes++; database.prepare('DELETE FROM credential').run(); didRetire() } })
    expect(producer.cleanup).toBeDefined()
    await producer.cleanup
    await Promise.all([retired, disposed])
    expect(database.prepare('SELECT * FROM credential').all()).toEqual([])
    expect(revokes).toBe(1)
    expect(disposals).toBe(1)
  } finally { database.close() }
})
