import { timingSafeEqual } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostedAgentError } from '../src/hosted-agent'

const kit = vi.hoisted(() => ({ attachLine: vi.fn(), createHostedAgent: vi.fn() }))
vi.mock('@tangle-network/agent-app/hosted-agent', async () => {
  const source = await vi.importActual<typeof import('../src/hosted-agent')>('../src/hosted-agent')
  return { HostedAgentError: source.HostedAgentError, createHostedAgent: kit.createHostedAgent }
})
const env = { TANGLE_API_KEY: 'local-test-key', OWNER_ADDRESS: 'owner@example.com', SETUP_SECRET: 'local-test-setup' }
// Keep the example's Worker globals in its own TypeScript project.
const workerModule = '../examples/hosted-agent/src/worker'
const { default: worker } = await import(workerModule) as {
  default: { fetch(request: Request, bindings: typeof env): Promise<Response> }
}

beforeEach(() => {
  kit.createHostedAgent.mockReturnValue({ attachLine: kit.attachLine })
  kit.attachLine.mockResolvedValue({ id: 'ln_mail' })
  // This Worker-only WebCrypto method is absent in the Node test runtime.
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', { value: timingSafeEqual, configurable: true })
})
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
})

function setup(body: unknown) {
  return worker.fetch(new Request('https://example.invalid/setup', {
    method: 'POST', headers: { authorization: `Bearer ${env.SETUP_SECRET}` }, body: JSON.stringify(body),
  }), env)
}

describe('hosted email Worker setup', () => {
  it('passes the explicit mailbox to the hosted-agent kit', async () => {
    const response = await setup({ connectionId: 'hubconn_resend', transport: 'email', address: 'assistant@example.com' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'ln_mail' })
    expect(kit.attachLine).toHaveBeenCalledWith('hubconn_resend', expect.objectContaining({
      transport: 'email', address: 'assistant@example.com',
    }))
    expect(kit.createHostedAgent).toHaveBeenCalledWith(expect.objectContaining({ owner: 'owner@example.com' }))
  })

  it('passes the operator assistant mailbox without confusing it with the owner', async () => {
    for (const [name, value] of Object.entries({
      TANGLE_API_KEY: env.TANGLE_API_KEY, OWNER_ADDRESS: env.OWNER_ADDRESS, MODEL: 'local-test-model',
      TRANSPORT: 'email', EMAIL_ADDRESS: 'assistant@example.com', CONNECTION_ID: 'hubconn_resend',
    })) vi.stubEnv(name, value)
    const assistantModule = '../examples/hosted-agent/assistant.mjs'
    const { installAssistant } = await import(assistantModule) as { installAssistant(): Promise<unknown> }
    await expect(installAssistant()).resolves.toEqual({ id: 'ln_mail' })
    expect(kit.attachLine).toHaveBeenCalledWith('hubconn_resend', {
      transport: 'email', mode: 'personal', address: 'assistant@example.com',
    })
    expect(kit.createHostedAgent).toHaveBeenCalledWith(expect.objectContaining({ owner: env.OWNER_ADDRESS }))
  })

  it.each([42, {}, '', 'a'.repeat(321)])('rejects a malformed mailbox field %j before the kit', async address => {
    const response = await setup({ connectionId: 'hubconn_resend', transport: 'email', address })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_line_options' })
    expect(kit.createHostedAgent).not.toHaveBeenCalled()
  })

  it('keeps an existing Hub route conflict explicit without exposing provider details', async () => {
    kit.attachLine.mockRejectedValue(Object.assign(new Error('private provider response'), { status: 409 }))
    const response = await setup({ connectionId: 'hubconn_resend', transport: 'email', address: 'assistant@example.com' })
    expect(response.status).toBe(409)
    const result = await response.json() as { error: string; message: string }
    expect(result.error).toBe('line_setup_conflict')
    expect(result.message).toContain('Setup has not removed either route')
    expect(result.message).not.toContain('private provider response')
    expect(kit.attachLine).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit migration conflict for a legacy email attachment', async () => {
    kit.attachLine.mockRejectedValue(new HostedAgentError('line_policy_migration_required', 'Manage the retained policy in Hub.'))
    const response = await setup({ connectionId: 'hubconn_inkbox', transport: 'email' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'line_policy_migration_required', message: 'Manage the retained policy in Hub.' })
    expect(kit.attachLine).toHaveBeenCalledTimes(1)
  })
})
