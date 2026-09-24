import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The kit routes no text or call and keeps no box binding, conversation or
 * counter: it attaches the line to Hub, and Hub routes each text and call to
 * the sender's own box. The Sandbox client is replaced at its package
 * boundary; the kit's policy is real.
 */

const platform = vi.hoisted(() => ({
  fromConnection: vi.fn(),
  attach: vi.fn(),
  enableVoice: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@tangle-network/sandbox/core', () => {
  class Sandbox {
    lines = {
      fromConnection: platform.fromConnection,
      attach: platform.attach,
      enableVoice: platform.enableVoice,
      get: platform.get,
    }
  }
  return { Sandbox }
})

const { createHostedAgent, CONVERSATION_TOOLS_OFF, DEFAULT_HOSTED_MODEL } = await import('../src/hosted-agent')

const OWNER = '+15550100001'
const braid = () => createHostedAgent({ apiKey: 'sk-tan-test', profile: { name: 'Braid' }, owner: OWNER, freeTurnsPerDay: 30 })

beforeEach(() => {
  vi.clearAllMocks()
  platform.fromConnection.mockResolvedValue({ id: 'ln_braid' })
  platform.attach.mockResolvedValue({ id: 'lat_1' })
  platform.get.mockResolvedValue({ id: 'ln_braid', attachment: { id: 'lat_1' }, voice: null })
})

describe('hosted agent on Hub lines', () => {
  it('attaches the line so each texter runs in their own box under the kit keys', async () => {
    const line = await braid().attachLine('hubconn_braid')

    expect(line.id).toBe('ln_braid')
    expect(platform.fromConnection).toHaveBeenCalledWith({ connectionId: 'hubconn_braid', transport: 'imessage', clientReference: 'hosted-agent' })
    const attached = platform.attach.mock.calls[0]![0]
    expect(attached).toMatchObject({
      number: 'ln_braid', mode: 'shared', unknownSenders: 'guest',
      members: [{ address: OWNER, role: 'owner' }],
      roles: { owner: { context: 'own', tools: 'act' }, guest: { context: 'own', tools: 'act' } },
      limits: { turnsPerMemberPerDay: 30 },
      instance: { keyPrefix: 'hosted:', create: {
        resources: { cpuCores: 1, memoryMB: 2048, diskGB: 10 },
        egressPolicy: { mode: 'strict', allowDomains: ['router.tangle.tools'], includeImplicitDomains: false },
        idleTimeoutSeconds: 600 } },
    })
    // Hub runs turns with the conversation defaults: the default model, and no shell.
    const profile = attached.respond.backend.profile
    expect(attached.respond.kind).toBe('agent')
    expect(profile.model.default).toBe(DEFAULT_HOSTED_MODEL)
    expect(Object.keys(profile.tools)).toEqual([...CONVERSATION_TOOLS_OFF])
    expect(profile.permissions.bash).toBe('deny')
    expect(platform.enableVoice).not.toHaveBeenCalled()
  })

  it('turns on voice after the attachment, so a call reaches the same box and thread', async () => {
    const voice = { ph0nyConnectionId: 'hubconn_phony_1', ph0nyAgentId: 'agent_1' }
    await braid().attachLine('hubconn_braid', { voice })

    expect(platform.enableVoice).toHaveBeenCalledWith('ln_braid', voice)
    expect(platform.attach.mock.invocationCallOrder[0]!).toBeLessThan(platform.enableVoice.mock.invocationCallOrder[0]!)
  })

  it('keeps a profile that chooses its own model and tools', async () => {
    await createHostedAgent({ apiKey: 'sk-tan-test', owner: OWNER, harness: 'opencode',
      profile: { model: { default: 'anthropic/claude-sonnet-5' }, tools: { bash: true } } }).attachLine('hubconn_braid')

    const { backend } = platform.attach.mock.calls[0]![0].respond
    expect(backend.type).toBe('opencode')
    expect(backend.profile).toMatchObject({ model: { default: 'anthropic/claude-sonnet-5' }, tools: { bash: true } })
    expect(backend.profile.permissions).toBeUndefined()
  })

  it('needs the owner as an E.164 number', () => {
    expect(() => createHostedAgent({ apiKey: 'sk-tan-test', profile: {}, owner: '555-0100' })).toThrow(/E\.164/)
  })
})
