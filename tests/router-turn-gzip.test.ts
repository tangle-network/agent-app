/**
 * A Router turn's large request body leaves gzipped and arrives as the same JSON.
 * Real `fetch` against a real HTTP server on loopback that decodes the body the
 * way the Tangle Router does (tangle-router `readInferenceRequestText`).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_TANGLE_ROUTER_BASE_URL } from '../src/runtime/model'
import { runRouterTurn } from '../src/runtime/router-turn'

type Received = { encoding: string | null; wireBytes: number; body: { messages: Array<{ role: string; content: string }> } }

let server: Server
let baseUrl = ''
const received: Received[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const wire = Buffer.concat(chunks)
      const encoding = req.headers['content-encoding'] ?? null
      const text = (encoding === 'gzip' ? gunzipSync(wire) : wire).toString('utf8')
      received.push({ encoding, wireBytes: wire.byteLength, body: JSON.parse(text) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('gzipRequestAboveBytes', () => {
  const systemPrompt = 'You are Creative, a studio assistant. Keep the brand voice. '.repeat(2_500)

  it('gzips a body over the threshold and the server reads the same prompt', async () => {
    received.length = 0
    const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', baseUrl, systemPrompt, userMessage: 'Plan a deck.',
      gzipRequestAboveBytes: 32 * 1024, repeat: false })
    expect(outcome.failure).toBeUndefined()
    expect(outcome.text).toBe('Done.')
    expect(received).toHaveLength(1)
    const request = received[0]
    if (!request) throw new Error('the server received no request')
    expect(request.encoding).toBe('gzip')
    expect(request.body.messages.find(message => message.role === 'system')?.content).toContain(systemPrompt)
    expect(request.body.messages.at(-1)).toEqual({ role: 'user', content: 'Plan a deck.' })
    expect(request.wireBytes * 10).toBeLessThan(systemPrompt.length)
  })

  it('sends a body under the threshold, or with the option unset, as it is', async () => {
    received.length = 0
    await runRouterTurn({ apiKey: 'k', model: 'm', baseUrl, systemPrompt: 'Short.', userMessage: 'Hi.', gzipRequestAboveBytes: 32 * 1024, repeat: false })
    await runRouterTurn({ apiKey: 'k', model: 'm', baseUrl, systemPrompt, userMessage: 'Hi.', repeat: false })
    expect(received.map(request => request.encoding)).toEqual([null, null])
    expect(received[1]?.wireBytes).toBeGreaterThan(systemPrompt.length)
  })

  it('defaults only the canonical Router origin, preserving explicit thresholds and opt-out', async () => {
    received.length = 0
    // Keep the real request/response pipeline, forwarding the canonical origin
    // to the loopback Router so no credentials or external calls are needed.
    const forward: typeof fetch = (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe(new URL(DEFAULT_TANGLE_ROUTER_BASE_URL).origin)
      return fetch(`${baseUrl}${url.pathname.replace(/^\/v1/, '')}`, init)
    }
    for (const options of [
      { systemPrompt },
      { systemPrompt: 'Short.' },
      { systemPrompt, gzipRequestAboveBytes: -1 },
      { systemPrompt, gzipRequestAboveBytes: 1_000_000 },
      { systemPrompt: 'Short.', gzipRequestAboveBytes: 0 },
    ]) {
      const outcome = await runRouterTurn({ apiKey: 'k', model: 'm', userMessage: 'Hi.', repeat: false,
        fetchImpl: forward, ...options })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.text).toBe('Done.')
    }
    expect(received.map(request => request.encoding)).toEqual(['gzip', null, null, null, 'gzip'])
  })

})
