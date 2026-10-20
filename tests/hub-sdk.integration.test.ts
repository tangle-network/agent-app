import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { HubClient } from '@tangle-network/hub-sdk'
import { integrationToolName } from '@tangle-network/agent-integrations/catalog'
import { HubExecClient, invokeIntegrationHub } from '../src/integrations/index'
import type { ChannelsClient } from '../src/channels/types'

// A real HTTP boundary with the installed Hub SDK and its default fetch.
// This protocol fixture proves package compatibility, not a served Hub journey.
describe('published Hub SDK compatibility', () => {
  it('preserves caller execution, approval refusal and complete number pagination', async () => {
    const requests: Array<{ path: string; method: string; authorization?: string; body: unknown }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      const body: unknown = raw ? JSON.parse(raw) : undefined
      const url = new URL(request.url!, 'http://localhost')
      requests.push({ path: url.pathname + url.search, method: request.method!, authorization: request.headers.authorization, body })
      response.setHeader('Content-Type', 'application/json')
      if (request.headers.authorization !== 'Bearer fixture-caller-key') {
        response.writeHead(401).end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Caller required' } }))
      } else if (request.method === 'POST' && url.pathname === '/v1/hub/exec') {
        if ((body as { path?: string }).path === 'gmail.default.list') {
          response.end(JSON.stringify({ success: true, data: { result: { messages: [{ id: 'message-fixture' }] } } }))
        } else {
          response.writeHead(403).end(JSON.stringify({ success: false, error: {
            code: 'HUB_APPROVAL_REQUIRED', message: 'Owner approval required', details: { approval: { id: 'approval-fixture' } },
          } }))
        }
      } else if (request.method === 'GET' && url.pathname === '/v1/hub/numbers/readiness') {
        response.end(JSON.stringify({ success: true, data: { configured: true, transports: ['sms'] } }))
      } else if (request.method === 'GET' && url.pathname === '/v1/hub/numbers') {
        response.end(JSON.stringify({ success: true, data: {
          orders: [], nextCursor: url.searchParams.has('cursor') ? null : 'page-two',
        } }))
      } else {
        response.writeHead(404).end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown operation' } }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    try {
      const client = new HubExecClient({ baseUrl, bearer: 'fixture-caller-key' })
      expect(await client.exec({
        path: 'gmail.default.list', actionInput: { query: 'inbox' }, connectionId: 'connection-fixture',
      })).toEqual({ succeeded: true, result: { messages: [{ id: 'message-fixture' }] } })
      expect(requests[0]).toEqual({
        path: '/v1/hub/exec', method: 'POST', authorization: 'Bearer fixture-caller-key',
        body: { path: 'gmail.default.list', input: { query: 'inbox' }, connectionId: 'connection-fixture' },
      })

      const denied = await invokeIntegrationHub({
        userId: 'user-fixture', toolName: integrationToolName('gmail', 'default', 'send'), args: { subject: 'Fixture' },
      }, { baseUrl, apiKeyResolver: async () => 'fixture-caller-key' })
      expect(denied.status).toBe(409)
      expect(denied.body).toMatchObject({
        success: false, code: 'HUB_APPROVAL_REQUIRED', approval: { id: 'approval-fixture' },
      })
      // Approval-required must remain a refusal, never mint or approve implicitly.
      expect(requests.map(request => request.path)).toEqual(['/v1/hub/exec', '/v1/hub/exec'])
      expect(requests[1]?.body).toEqual({ path: 'gmail.default.send', input: { subject: 'Fixture' } })

      const hub = new HubClient({ baseUrl, apiKey: 'fixture-caller-key' })
      const ordering: NonNullable<ChannelsClient['ordering']> = {
        numbers: hub.numbers, references: { sms: 'agent-fixture-sms', imessage: 'agent-fixture-imessage' },
      }
      expect(await ordering.numbers.readiness()).toMatchObject({ configured: true, transports: ['sms'] })
      const first = await ordering.numbers.list({ clientReference: ordering.references.sms, limit: 100 })
      expect(first.nextCursor).toBe('page-two')
      const last = await ordering.numbers.list({
        clientReference: ordering.references.sms, limit: 100, cursor: first.nextCursor!,
      })
      expect(last).toEqual({ orders: [], nextCursor: null })
      expect(requests.slice(2).map(request => request.path)).toEqual([
        '/v1/hub/numbers/readiness',
        '/v1/hub/numbers?clientReference=agent-fixture-sms&limit=100',
        '/v1/hub/numbers?clientReference=agent-fixture-sms&cursor=page-two&limit=100',
      ])
      expect(requests.every(request => request.authorization === 'Bearer fixture-caller-key')).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
