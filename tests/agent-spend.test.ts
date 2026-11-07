import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlatformAgentSpend } from '../src/platform'

// A local HTTP Platform peer: each path answers what the test set for it.
const answers = new Map<string, { status: number; body: unknown }>()
const calls: Array<{ path: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = []
const peer = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    calls.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') })
    const answer = answers.get(req.url ?? '') ?? { status: 404, body: {} }
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body))
  })
})
let spend: ReturnType<typeof createPlatformAgentSpend>
beforeAll(async () => {
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const platformUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}/`
  spend = createPlatformAgentSpend({ platformUrl, serviceName: 'gtm-agent', serviceToken: () => 'svc_token', product: 'gtm-agent' })
})
afterAll(() => new Promise<void>((resolve) => { peer.close(() => resolve()) }))

const expiresAt = new Date('2026-10-10T00:00:00.000Z')
const answer = (path: string, status: number, body: unknown) => answers.set(path, { status, body })

describe('agent key spend', () => {
  it('delegates a spend-through Router key, holds a key-cap amount and spends what the work measured', async () => {
    answer('/v1/keys/delegate', 201, { success: true, data: { key: 'sk-tan-child', id: 'key_child' } })
    answer('/v1/billing/authorizations', 201, { success: true, data: { id: 'auth_1' } })
    answer('/v1/billing/authorizations/auth_1/consume', 200, { success: true, data: { consumedAmount: 0.12 } })
    expect(await spend.modelKey({ agentKey: 'sk-tan-agent', name: 'auto:gtm-agent:router:turn-1', expiresAt }))
      .toEqual({ succeeded: true, value: { key: 'sk-tan-child', keyId: 'key_child' } })
    expect(await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt }))
      .toEqual({ succeeded: true, value: { authorizationId: 'auth_1' } })
    expect(await spend.consume({ authorizationId: 'auth_1', amountUsd: 0.12 })).toEqual({ succeeded: true, value: { consumedUsd: 0.12 } })
    const [delegate, hold, consume] = calls.splice(0)
    expect(delegate!.headers).toMatchObject({ authorization: 'Bearer svc_token', 'x-service-name': 'gtm-agent' })
    expect(delegate!.body).toEqual({
      sourceKey: 'sk-tan-agent', name: 'auto:gtm-agent:router:turn-1', product: 'router', spendThrough: true, expiresAt: expiresAt.toISOString(),
    })
    expect(hold!.body).toEqual({ keyId: 'key_agent', amount: 0.5, type: 'key_cap', product: 'gtm-agent', referenceId: 'turn-1', expiresAt: expiresAt.toISOString() })
    expect(consume!.body).toEqual({ amount: 0.12 })
  })

  it('answers a spent cap with a typed 402 wherever Platform refuses it', async () => {
    answer('/v1/keys/delegate', 402, { success: false, error: { code: 'KEY_BUDGET_EXHAUSTED' } })
    answer('/v1/billing/authorizations', 403, { success: false, error: { code: 'KEY_BUDGET_EXCEEDED' } })
    const exhausted = { succeeded: false, error: { status: 402, code: 'agent_key.budget_exhausted' } }
    expect(await spend.modelKey({ agentKey: 'sk-tan-agent', name: 'auto:x', expiresAt })).toMatchObject(exhausted)
    expect(await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt })).toMatchObject(exhausted)
  })

  it("carries Platform's code and message on a refusal it does not type, without a credential", async () => {
    const message = 'Authorization reference was reused with different parameters for sk-tan-B3V7NECxSECRET'
    answer('/v1/billing/authorizations', 409, { success: false, error: { code: 'AUTHORIZATION_CONFLICT', message } })
    const refused = await spend.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-2', expiresAt })
    expect(refused).toEqual({ succeeded: false, error: {
      status: 403, code: 'agent_key.spend_refused', platformCode: 'AUTHORIZATION_CONFLICT',
      message: 'Platform refused to bill this work to the key (AUTHORIZATION_CONFLICT: Authorization reference was reused with different parameters for [redacted]).',
    } })
  })

  it('reports an unreachable Platform as retryable rather than as success', async () => {
    const down = createPlatformAgentSpend({ platformUrl: 'http://127.0.0.1:9', serviceName: 'gtm-agent', serviceToken: 'svc', product: 'gtm-agent' })
    expect(await down.hold({ keyId: 'key_agent', amountUsd: 0.5, referenceId: 'turn-1', expiresAt }))
      .toMatchObject({ succeeded: false, error: { status: 503, code: 'agent_key.spend_unavailable' } })
    expect(await down.release('auth_1')).toMatchObject({ succeeded: false, error: { status: 503 } })
  })
})
