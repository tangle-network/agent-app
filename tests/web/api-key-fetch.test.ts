import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { it } from 'vitest'
import { createApiKeyFetch } from '../../src/web/api-key-fetch'

it('sends a real request with a rotating key and preserves request/response bodies', async () => {
  const seen: Array<{ url?: string; authorization?: string; cookie?: string; body: string }> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    seen.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ receipt: 'fixture-receipt' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let key = 'fixture-first'
  const client = createApiKeyFetch({ origin: `http://127.0.0.1:${address.port}`, allowHttpLoopback: true, getApiKey: () => key })
  try {
    assert.deepEqual(await (await client('/api/chat', { method: 'POST', body: '{"turnId":"fixed"}' })).json(), { receipt: 'fixture-receipt' })
    key = 'fixture-second'
    await client('/api/receipt?turnId=fixed')
    assert.deepEqual(seen, [
      { url: '/api/chat', authorization: 'Bearer fixture-first', cookie: undefined, body: '{"turnId":"fixed"}' },
      { url: '/api/receipt?turnId=fixed', authorization: 'Bearer fixture-second', cookie: undefined, body: '' },
    ])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('does not follow a real redirect or send the credential to its target', async () => {
  let redirectedRequests = 0
  const target = createServer((_req, res) => { redirectedRequests++; res.end('unexpected') })
  target.listen(0, '127.0.0.1'); await once(target, 'listening')
  const address = target.address(); assert.ok(address && typeof address !== 'string')
  const source = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${address.port}/stolen` }); res.end() })
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  const sourceAddress = source.address(); assert.ok(sourceAddress && typeof sourceAddress !== 'string')
  const client = createApiKeyFetch({ origin: `http://127.0.0.1:${sourceAddress.port}`, allowHttpLoopback: true, getApiKey: () => 'fixture-secret' })
  try {
    await assert.rejects(client('/api/chat', { method: 'POST', body: 'message', redirect: 'follow' }), /redirects are not allowed/)
    assert.equal(redirectedRequests, 0)
  } finally {
    source.closeAllConnections(); target.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))])
  }
})

for (const origin of ['http://remote.test', 'https://user:pass@api.test', 'https://api.test/path', 'https://api.test/?key=x', 'https://api.test/#x', 'ftp://api.test']) {
  it(`rejects unsafe origin ${origin}`, () => {
    assert.throws(() => createApiKeyFetch({ origin, allowHttpLoopback: true, getApiKey: () => 'secret' }), /API origin/)
  })
}
it('requires opt-in even for localhost HTTP', () => {
  assert.throws(() => createApiKeyFetch({ origin: 'http://localhost:1234', getApiKey: () => 'secret' }), /API origin/)
})
for (const path of ['https://elsewhere.test', '//elsewhere.test', '/\\elsewhere.test', '/\n/elsewhere.test', '/api#fragment', ' /api']) {
  it(`rejects unsafe path ${JSON.stringify(path)} before retrieving a secret`, async () => {
    let resolved = false
    const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => { resolved = true; return 'secret' } })
    await assert.rejects(client(path), TypeError)
    assert.equal(resolved, false)
  })
}
for (const name of ['Authorization', 'Cookie', 'Proxy-Authorization']) {
  it(`rejects caller-controlled ${name}`, async () => {
    let resolved = false
    const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => { resolved = true; return 'secret' } })
    await assert.rejects(client('/api', { headers: { [name]: 'injected' } }), /Authentication headers/)
    assert.equal(resolved, false)
  })
}
it('preserves explicit HTTP errors without retries or credential fallback', async () => {
  let calls = 0
  const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => 'secret', fetchImpl: async (_url, init) => {
    calls++
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual')
    return new Response('denied', { status: 403 })
  } })
  const response = await client('/api', { credentials: 'include', redirect: 'follow' })
  assert.equal(response.status, 403); assert.equal(await response.text(), 'denied'); assert.equal(calls, 1)
})
it('preserves 304 conditional-read responses', async () => {
  const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => 'secret', fetchImpl: async () => new Response(null, { status: 304 }) })
  assert.equal((await client('/api')).status, 304)
})
it('does not retry or expose adapter error content', async () => {
  let calls = 0
  const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => 'fixture-secret', fetchImpl: async () => { calls++; throw new Error('Bearer fixture-secret') } })
  await assert.rejects(client('/api', { method: 'POST' }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /inspect retained state/)
    assert.ok(!String(error.stack).includes('fixture-secret')); assert.equal(error.cause, undefined); return true
  })
  assert.equal(calls, 1)
})
it('cancels before reading credentials and after a pending credential resolution', async () => {
  const controller = new AbortController(); controller.abort()
  let read = false
  const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => { read = true; return 'secret' } })
  await assert.rejects(client('/api', { signal: controller.signal })); assert.equal(read, false)
  const later = new AbortController(); let fetched = false
  const pending = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => { later.abort(); return 'secret' }, fetchImpl: async () => { fetched = true; return new Response() } })
  await assert.rejects(pending('/api', { signal: later.signal })); assert.equal(fetched, false)
})
it('masks failures resolving credentials', async () => {
  const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => { throw new Error('fixture-secret') } })
  await assert.rejects(client('/api'), { message: 'API credential is unavailable' })
})
for (const key of ['', 'has space', 'has\nnewline']) {
  it('rejects invalid credentials before fetch', async () => {
    const client = createApiKeyFetch({ origin: 'https://api.test', getApiKey: () => key })
    await assert.rejects(client('/api'), /credential must/)
  })
}
