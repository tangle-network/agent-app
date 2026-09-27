import { beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ fromConnection: vi.fn(), attach: vi.fn(), get: vi.fn(), enableVoice: vi.fn() }))
vi.mock('@tangle-network/sandbox/core', () => ({ Sandbox: class { lines = platform } }))
const { createHostedAgent } = await import('../src/hosted-agent')
const owner = { context: 'own', tools: 'act' } as const
const emailAgent = () => createHostedAgent({ apiKey: 'sk-tan-proof', owner: 'member@example.com', profile: { name: 'Braid' } })

beforeEach(() => {
  vi.resetAllMocks()
  platform.fromConnection.mockResolvedValue({ id: 'ln_proof', attachment: null })
  platform.get.mockResolvedValue({ id: 'ln_proof' })
})

describe('repeat setup preserves admission', () => {
  it.each(['guest', 'reject'] as const)('keeps a shared email attachment with %s admission', async unknownSenders => {
    const roles = { owner, guest: owner }
    platform.fromConnection.mockResolvedValue({ id: 'ln_proof', clientReference: 'hosted-agent', attachment: {
      status: 'active', mode: 'shared', unknownSenders, roles, instance: { keyPrefix: 'hosted:' },
    } })
    await emailAgent().attachLine('hubconn_proof', { transport: 'email' })
    expect(platform.attach).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shared', unknownSenders, roles, instance: expect.objectContaining({ keyPrefix: 'hosted:' }),
    }))
  })

  it('does not switch an existing personal phone line to shared guest admission', async () => {
    platform.fromConnection.mockResolvedValue({ id: 'ln_proof', attachment: {
      status: 'active', mode: 'personal', unknownSenders: 'reject', roles: { owner }, instance: { keyPrefix: 'private:' },
    } })
    await createHostedAgent({ apiKey: 'sk-tan-proof', owner: '+15550100001', profile: {} }).attachLine('hubconn_proof')
    expect(platform.attach).toHaveBeenCalledWith(expect.objectContaining({ mode: 'personal', unknownSenders: 'reject', roles: { owner } }))
  })

  it('uses the safe email default only for a new attachment', async () => {
    await emailAgent().attachLine('hubconn_proof', { transport: 'email' })
    expect(platform.attach).toHaveBeenCalledWith(expect.objectContaining({ mode: 'personal', unknownSenders: 'reject', roles: { owner } }))
  })

  it('only changes admission when the caller explicitly selects a mode', async () => {
    platform.fromConnection.mockResolvedValue({ id: 'ln_proof', attachment: {
      status: 'active', mode: 'shared', unknownSenders: 'guest', roles: { owner, guest: owner }, instance: { keyPrefix: 'hosted:' },
    } })
    await emailAgent().attachLine('hubconn_proof', { transport: 'email', mode: 'personal' })
    expect(platform.attach).toHaveBeenCalledWith(expect.objectContaining({ mode: 'personal', unknownSenders: 'reject', roles: { owner } }))
  })
})
