import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The kit routes no text and keeps no box binding, conversation or counter:
 * Hub lines route each text to the sender's own box, and the kit answers
 * calls from that box and thread. The Sandbox client is replaced at its
 * package boundary; the turn engine and the kit's policy are real.
 */

const platform = vi.hoisted(() => ({
  fromConnection: vi.fn(),
  attach: vi.fn(),
  list: vi.fn(),
  members: vi.fn(),
  threads: vi.fn(),
  ensure: vi.fn(),
  waitForRunning: vi.fn(),
}))

vi.mock('@tangle-network/sandbox/core', () => {
  class InstanceRestartingError extends Error {
    constructor() { super('restarting'); this.name = 'InstanceRestartingError' }
  }
  class Sandbox {
    lines = {
      fromConnection: platform.fromConnection,
      attach: platform.attach,
      list: platform.list,
      members: () => ({ list: platform.members }),
      threads: () => ({ list: platform.threads }),
    }
    instances = { ensure: platform.ensure }
    waitForRunning = platform.waitForRunning
  }
  async function lineInstanceKey(prefix: string, address: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address))
    return `${prefix}${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
  }
  return { Sandbox, InstanceRestartingError, lineInstanceKey }
})

// The mock's error takes no arguments.
const InstanceRestartingError = (await import('@tangle-network/sandbox/core')).InstanceRestartingError as unknown as new () => Error
const { createHostedAgent, CONVERSATION_TOOLS_OFF, DEFAULT_HOSTED_MODEL } = await import('../src/hosted-agent')

const OWNER = '+15550100001'
const CALLER = '+15550100002'
const SECRET = 'voice-secret-0123456789'

async function hash(phone: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phone))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

function memoryStore() {
  const data = new Map<string, string>()
  return { data, get: async (key: string) => data.get(key) ?? null, put: async (key: string, value: string) => { data.set(key, value) } }
}

function runningBox(status = 'running') {
  const sessions = new Set<string>(['lth_caller'])
  return {
    id: 'sbx_person', status,
    session: (id: string) => ({ status: async () => (sessions.has(id) ? { backend: 'opencode' } : null) }),
    createSession: vi.fn(async ({ sessionId }: { sessionId: string }) => { sessions.add(sessionId) }),
    driveConversationTurn: vi.fn(async () => ({ state: 'completed', text: 'You told me you moved to Lisbon.', result: {}, usage: {} })),
  }
}

function agent() {
  const store = memoryStore()
  return { store, agent: createHostedAgent({ apiKey: 'sk-tan-test', profile: { name: 'Braid' }, owner: OWNER, store, voiceSecret: SECRET, freeTurnsPerDay: 30 }) }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://braid.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, ...headers }, body: JSON.stringify(body) })

async function admit(braid: ReturnType<typeof agent>['agent'], phone = CALLER): Promise<string> {
  const res = await braid.voiceHook(post('/voice/hook', { event: 'admit', phone }))
  const body = await res.json() as { admit: boolean; callToken: string }
  expect(body.admit).toBe(true)
  return body.callToken
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.list.mockResolvedValue([{ id: 'ln_braid', attachment: { instance: { keyPrefix: 'hosted:' } } }])
  platform.members.mockResolvedValue([{ id: 'lmb_caller', address: CALLER }])
  platform.threads.mockResolvedValue([{ id: 'lth_caller', memberId: 'lmb_caller', sessionId: 'lth_caller' }])
})

describe('hosted agent on Hub lines', () => {
  it('attaches the line so each texter runs in their own box under the kit keys', async () => {
    platform.fromConnection.mockResolvedValue({ id: 'ln_braid' })
    platform.attach.mockResolvedValue({ id: 'lat_1' })
    const { agent: braid } = agent()

    await braid.attachLine('hubconn_braid')

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
    // Hub runs texts with the conversation defaults: the default model, and no shell.
    const profile = attached.respond.backend.profile
    expect(attached.respond.kind).toBe('agent')
    expect(profile.model.default).toBe(DEFAULT_HOSTED_MODEL)
    expect(Object.keys(profile.tools)).toEqual([...CONVERSATION_TOOLS_OFF])
    expect(profile.permissions.bash).toBe('deny')
  })

  it('answers a call in the caller\'s box and text thread', async () => {
    const box = runningBox()
    platform.ensure.mockResolvedValue({ box })
    const { agent: braid, store } = agent()
    const token = await admit(braid)

    const res = await braid.voiceAsk(post('/voice/ask', { utterance: 'where do I live?' }, { 'x-voice-call-token': token }))

    expect(await res.json()).toEqual({ status: 'complete', answer: 'You told me you moved to Lisbon.' })
    expect(platform.ensure.mock.calls[0]![0]).toMatchObject({ key: `hosted:${await hash(CALLER)}`,
      create: { secrets: [], sshEnabled: false } })
    const [prompt, options] = box.driveConversationTurn.mock.calls[0]! as unknown as [string, { sessionId: string }]
    expect(options.sessionId).toBe('lth_caller')
    expect(prompt).toContain('where do I live?')
    expect(box.createSession).not.toHaveBeenCalled()
    // The call remembers its session, so later questions skip the lookup.
    expect(JSON.parse(store.data.get(`vcall:${token}`)!).session).toBe('lth_caller')
    await braid.voiceAsk(post('/voice/ask', { utterance: 'and my name?' }, { 'x-voice-call-token': token }))
    expect(platform.threads).toHaveBeenCalledTimes(1)
  })

  it('gives a caller who never texted their own voice session in their box', async () => {
    const box = runningBox()
    platform.ensure.mockResolvedValue({ box })
    platform.members.mockResolvedValue([])
    const { agent: braid } = agent()
    const token = await admit(braid, OWNER)

    await braid.voiceAsk(post('/voice/ask', { utterance: 'hi' }, { 'x-voice-call-token': token }))

    expect(box.createSession.mock.calls[0]![0].sessionId).toBe(`voice-${await hash(OWNER)}`)
  })

  it('returns a ticket while the platform restarts a box that cannot start', async () => {
    platform.ensure.mockRejectedValue(new InstanceRestartingError())
    const { agent: braid } = agent()
    const token = await admit(braid)

    const body = await (await braid.voiceAsk(post('/voice/ask', { utterance: 'hi' }, { 'x-voice-call-token': token }))).json() as { status: string; ticket: string }

    expect(body.status).toBe('pending')
    expect(body.ticket).toMatch(/^v-[\w-]+\.[\w-]+$/)
  })

  it('refuses a call without the secret, a hidden number, or an unknown token', async () => {
    const { agent: braid } = agent()
    expect((await braid.voiceHook(post('/voice/hook', { event: 'admit', phone: CALLER }, { authorization: 'Bearer wrong' }))).status).toBe(401)
    expect(await (await braid.voiceHook(post('/voice/hook', { event: 'admit', phone: 'anonymous' }))).json()).toMatchObject({ admit: false })
    expect((await braid.voiceAsk(post('/voice/ask', { utterance: 'hi' }, { 'x-voice-call-token': 'x'.repeat(43) }))).status).toBe(403)
  })

  it('needs the owner as an E.164 number', () => {
    expect(() => createHostedAgent({ apiKey: 'sk-tan-test', profile: {}, owner: '555-0100' })).toThrow(/E\.164/)
  })
})
