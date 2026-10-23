import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createIntelligenceClient } from '@tangle-network/agent-runtime/intelligence'
import { expect, it } from 'vitest'
import { produceChatTurnWithIntelligence } from '../../src/chat-routes/intelligence'
import { createRouterTurnProducer } from '../../src/chat-routes/router-producer'
import { createSandboxChatProducer } from '../../src/chat-routes/sandbox-producer'

/** Actual Runtime OTLP export, producer HTTP source, and SQLite credential retirement. */
it('retains a late credential cleanup promise through Intelligence observation', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE TABLE credential(value TEXT); INSERT INTO credential VALUES ('late-key')")
  let exports = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => { exports++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}') })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = createIntelligenceClient({ project: 'observer-capability', apiKey: 'local-fixture', effort: 'off',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  let arrive!: (key: { key: string; revoke(): Promise<void> }) => void
  const credential = new Promise<{ key: string; revoke(): Promise<void> }>(resolve => { arrive = resolve })
  try {
    const source = createRouterTurnProducer({ apiKey: credential, model: 'requested', userMessage: 'Answer once.',
      systemPrompt: Promise.reject(new Error('Profile preparation failed')) })
    const observed = await produceChatTurnWithIntelligence({ produce: () => source, client: () => client, sessionId: 'thread' })
    expect(observed.cleanup).toBe(source.cleanup)
    expect(observed.cleanup).toBeDefined()
    await expect((async () => { for await (const _event of observed.stream) { /* actual failure propagation */ } })())
      .rejects.toThrow('Profile preparation failed')
    expect(database.prepare('SELECT * FROM credential').all()).toHaveLength(1)
    arrive({ key: 'late-key', revoke: async () => { database.prepare('DELETE FROM credential').run() } })
    await observed.cleanup
    expect(database.prepare('SELECT * FROM credential').all()).toEqual([])
    await client.flush()
    expect(exports).toBeGreaterThan(0)
  } finally {
    await client.flush()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    database.close()
  }
})

it('forwards native terminal evidence from a frozen HTTP-backed producer', async () => {
  let exports = 0, reads = 0
  const server = createServer((request, response) => {
    if (request.url === '/events') {
      reads++
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end([
        { type: 'message.part.updated', data: { part: { type: 'text', id: 'answer' }, delta: 'Exact native answer.' } },
        { type: 'result', data: { finalText: 'Exact native answer.', outcome: { type: 'completed' }, toolInvocations: [] } },
      ].map(event => JSON.stringify(event)).join('\n'))
    } else {
      request.resume()
      request.on('end', () => { exports++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}') })
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createIntelligenceClient({ project: 'native-observer', apiKey: 'local-fixture', effort: 'off', baseUrl })
  try {
    const source = Object.freeze(createSandboxChatProducer({ model: 'native', openEvents: async () => {
      const response = await fetch(`${baseUrl}/events`)
      const lines = (await response.text()).split('\n')
      return (async function* () { for (const line of lines) yield JSON.parse(line) as unknown })()
    } }))
    const observed = await produceChatTurnWithIntelligence({ produce: () => source, client: () => client, sessionId: 'thread' })
    expect(observed.terminalObserved?.()).toBe(false)
    for await (const _event of observed.stream) { /* drain the real source */ }
    expect(reads).toBe(1)
    expect(observed.terminalObserved?.()).toBe(true)
    expect(observed.finalText()).toBe('Exact native answer.')
    expect(observed.model).toBe('native')
    await client.flush()
    expect(exports).toBeGreaterThan(0)
  } finally {
    await client.flush()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
