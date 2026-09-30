import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { abortSession, getSessionState, listSessionInteractions, respondToSessionInteraction,
  type SidecarInteractionsConnection } from '../src/interactions/sidecar'

let server: Server
let runtimeUrl: string
let status: number
let body: string
let redirected: number
const requests: Array<{ path: string; method: string; authorization: string | undefined; body: string }> = []

beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/redirect-target') { redirected++; response.end('{"data":{"ok":true}}'); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ path: request.url!, method: request.method!, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString() })
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 307 ? { location: '/redirect-target' } : {}) })
    response.end(body)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  runtimeUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
beforeEach(() => { status = 200; body = '{}'; redirected = 0; requests.length = 0 })

const operations = [
  { name: 'list', call: listSessionInteractions, method: 'GET', path: '/interactions', payload: { data: { interactions: [] } } },
  { name: 'answer', call: (connection: SidecarInteractionsConnection) => respondToSessionInteraction(connection, { id: 'ask-1', outcome: 'declined' }),
    method: 'POST', path: '/interactions', payload: { data: { ok: true } } },
  { name: 'status', call: getSessionState, method: 'GET', path: '', payload: { state: 'completed' } },
  { name: 'abort', call: abortSession, method: 'POST', path: '/abort', payload: { data: { cancelled: true } } },
] as const
const connection = (): SidecarInteractionsConnection => ({ runtimeUrl, sessionId: 'session/one', authToken: 'fixture-token' })

describe.each(operations)('shared sidecar HTTP transport: $name', operation => {
  it('uses the original authorized session and operation', async () => {
    body = JSON.stringify(operation.payload)
    expect(await operation.call(connection())).toMatchObject({ succeeded: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: `/agents/sessions/session%2Fone${operation.path}`,
      method: operation.method, authorization: 'Bearer fixture-token' })
  })
  it('does not follow redirects or apply the operation to a different endpoint', async () => {
    status = 307
    expect(await operation.call(connection())).toMatchObject({ succeeded: false, error: { code: 'UPSTREAM_REDIRECT', status: 307 } })
    expect(redirected).toBe(0)
  })
  it.each(['null', '[]', '<html>not an acknowledgement</html>'])('refuses malformed successful JSON: %s', async payload => {
    body = payload
    expect(await operation.call(connection())).toMatchObject({ succeeded: false, error: { code: 'MALFORMED_RESPONSE', status: 200 } })
  })
  it('does not turn an explicit refusal into a successful write or empty state', async () => {
    body = JSON.stringify({ success: false, error: { code: 'REFUSED', message: 'Not permitted' } })
    expect(await operation.call(connection())).toMatchObject({ succeeded: false, error: { code: 'REFUSED', status: 200 } })
  })
  it('retains HTTP error status even when the response is not JSON', async () => {
    status = 502; body = '<html>unavailable</html>'
    expect(await operation.call(connection())).toMatchObject({ succeeded: false, error: { status: 502 } })
  })
})


describe('interaction answer acknowledgement', () => {
  it.each([{}, { data: {} }, { data: { ok: false } }, { success: 'true' }, { data: { ok: 'true' } }])(
    'does not turn an unacknowledged successful response into an applied answer: %j', async payload => {
      body = JSON.stringify(payload)
      expect(await respondToSessionInteraction(connection(), { id: 'ask-1', outcome: 'declined' }))
        .toMatchObject({ succeeded: false, error: { code: 'MALFORMED_RESPONSE' } })
      expect(requests).toHaveLength(1)
    },
  )
  it.each([{ success: true }, { success: true, resolution: 'applied' }, { data: { ok: true } }])(
    'accepts an explicit current or legacy acknowledgement: %j', async payload => {
      body = JSON.stringify(payload)
      expect(await respondToSessionInteraction(connection(), { id: 'ask-1', outcome: 'declined' }))
        .toEqual({ succeeded: true, value: undefined })
      expect(requests).toHaveLength(1)
    },
  )
})
