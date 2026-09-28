import { describe, it, expect } from 'vitest'
import { integrationToolName } from '@tangle-network/agent-integrations/catalog'
import { resolveIntegrationAction, invokeIntegrationHub, HubExecClient, type HubInvokeDeps } from '../src/integrations/index'

const READ_TOOL = integrationToolName('gmail', 'default', 'list')
const WRITE_TOOL = integrationToolName('gmail', 'default', 'send')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const env = { TANGLE_PLATFORM_URL: 'https://id.tangle.tools' }
const okKey: HubInvokeDeps['apiKeyResolver'] = async () => 'sk-tan-user'

describe('resolveIntegrationAction', () => {
  it('parses a catalog tool name into provider.connector.action', () => {
    const a = resolveIntegrationAction(READ_TOOL)
    expect(a).toEqual({ providerId: 'gmail', connectorId: 'default', actionId: 'list', path: 'gmail.default.list' })
  })
  it('returns undefined for a non-integration tool name (so the loop routes it elsewhere)', () => {
    expect(resolveIntegrationAction('submit_proposal')).toBeUndefined()
    expect(resolveIntegrationAction('not-an-int-tool')).toBeUndefined()
  })
})

describe('invokeIntegrationHub', () => {
  it('runs a read: posts to /v1/hub/exec with the bearer, returns 200 + result', async () => {
    const seen: { url: string; init: RequestInit } = { url: '', init: {} }
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url); seen.init = init ?? {}
      return jsonResponse(200, { success: true, data: { result: { messages: [{ id: 'm1' }] } } })
    }) as unknown as typeof fetch
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: READ_TOOL, args: { q: 'x' } }, { apiKeyResolver: okKey, fetchImpl, env })
    expect(seen.url).toBe('https://id.tangle.tools/v1/hub/exec')
    expect((seen.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-tan-user')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ success: true, path: 'gmail.default.list', result: { messages: [{ id: 'm1' }] } })
  })

  it('surfaces an approval-gated write as 409 + the pending approval, never executes silently', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return jsonResponse(403, { success: false, error: { code: 'HUB_APPROVAL_REQUIRED', message: 'needs approval', details: { approval: { id: 'appr-1' } } } }) }) as unknown as typeof fetch
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: WRITE_TOOL }, { apiKeyResolver: okKey, fetchImpl, env })
    expect(calls).toBe(1)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ success: false, code: 'HUB_APPROVAL_REQUIRED', approval: { id: 'appr-1' } })
  })

  it('fails loud (401) when the user has not linked Tangle — never calls the hub', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return jsonResponse(200, {}) }) as unknown as typeof fetch
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: READ_TOOL }, { apiKeyResolver: async () => null, fetchImpl, env })
    expect(calls).toBe(0)
    expect(out.status).toBe(401)
  })

  it('rejects an unknown tool name with 400 (no guessed path)', async () => {
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: 'definitely-not-a-tool' }, { apiKeyResolver: okKey, env })
    expect(out.status).toBe(400)
    expect(String(out.body.error)).toMatch(/Unsupported integration tool/)
  })

  it('fails loud (500) when TANGLE_PLATFORM_URL is unset', async () => {
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: READ_TOOL }, { apiKeyResolver: okKey, env: {} })
    expect(out.status).toBe(500)
  })

  it('maps a non-approval hub failure to 502 with the code verbatim', async () => {
    const fetchImpl = (async () => jsonResponse(409, { success: false, error: { code: 'HUB_CONNECTION_MISSING', message: 'no gmail connection' } })) as unknown as typeof fetch
    const out = await invokeIntegrationHub({ userId: 'u1', toolName: READ_TOOL }, { apiKeyResolver: okKey, fetchImpl, env })
    expect(out.status).toBe(502)
    expect(out.body.code).toBe('HUB_CONNECTION_MISSING')
  })
})

describe('HubExecClient', () => {
  it('requires baseUrl + bearer', () => {
    expect(() => new HubExecClient({ baseUrl: '', bearer: 'x' })).toThrow(/baseUrl/)
    expect(() => new HubExecClient({ baseUrl: 'https://x', bearer: '' })).toThrow(/bearer/)
  })
})
