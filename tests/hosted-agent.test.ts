import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The kit keeps no box binding and no turn counter of its own: each person's
 * box comes from the platform's named instances, and each turn is admitted on
 * the Hub allowance meter. The Sandbox and Hub clients are replaced at their
 * package boundary; the turn engine, the store and the kit's policy are real.
 */

const platform = vi.hoisted(() => ({
  ensure: vi.fn(),
  waitForRunning: vi.fn(),
  admit: vi.fn(),
  plan: vi.fn(),
  setPlan: vi.fn(),
}))

vi.mock('@tangle-network/sandbox/core', () => {
  class InstanceRestartingError extends Error {
    readonly code = 'INSTANCE_RESTARTING'
    constructor() { super('restarting'); this.name = 'InstanceRestartingError' }
  }
  class Sandbox {
    instances = { ensure: platform.ensure }
    waitForRunning = platform.waitForRunning
  }
  return { Sandbox, InstanceRestartingError }
})

vi.mock('@tangle-network/hub-sdk', () => ({
  HubClient: class {
    allowances = { admit: platform.admit, plan: platform.plan, setPlan: platform.setPlan }
  },
  authenticateHubEventRequest: vi.fn(),
}))

const { InstanceRestartingError } = await import('@tangle-network/sandbox/core')
const { createHostedAgent, NOTICE } = await import('../src/hosted-agent')

const PHONE = '+15550100001'

async function member(phone: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phone))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

function memoryStore() {
  const data = new Map<string, string>()
  return { data, get: async (key: string) => data.get(key) ?? null, put: async (key: string, value: string) => { data.set(key, value) } }
}

function runningBox(status = 'running') {
  const sessions = new Set<string>()
  return {
    id: 'sbx_person', status,
    session: (id: string) => ({ status: async () => (sessions.has(id) ? { backend: 'opencode' } : null) }),
    createSession: vi.fn(async ({ sessionId }: { sessionId: string }) => { sessions.add(sessionId) }),
    driveConversationTurn: vi.fn(async () => ({ state: 'completed', text: 'Hi, I am Braid.', result: {}, usage: {} })),
  }
}

const admitted = { decision: 'admit', tier: 'free', paywall: false, turns: { used: 1, limit: 30 }, usd: null, day: '2026-09-24', resetsAt: '' }

function agent(overrides: Partial<Parameters<typeof createHostedAgent>[0]> = {}) {
  const store = memoryStore()
  return { store, agent: createHostedAgent({ apiKey: 'sk-tan-test', profile: { name: 'Braid' }, store, freeTurnsPerDay: 30, ...overrides }) }
}

const message = (turnId = 't-1') => ({ userId: PHONE, channel: 'imessage' as const, text: 'hello', turnId })
const soon = () => ({ deadline: Date.now() + 60_000 })

beforeEach(() => {
  vi.clearAllMocks()
  platform.plan.mockResolvedValue({ configured: false })
  platform.setPlan.mockResolvedValue({})
  platform.admit.mockResolvedValue(admitted)
})

describe('hosted agent on the platform', () => {
  it('runs the turn in the box the platform keeps for the person, admitted once on the meter', async () => {
    const box = runningBox()
    platform.ensure.mockResolvedValue({ box })
    const { agent: braid, store } = agent()

    expect(await braid.ask(message(), soon())).toEqual({ state: 'answered', text: 'Hi, I am Braid.' })

    const person = await member(PHONE)
    const ensured = platform.ensure.mock.calls[0]![0]
    expect(ensured).toMatchObject({
      key: `hosted:${person}`,
      create: { secrets: [], sshEnabled: false, metadata: { hostedUser: person },
        egressPolicy: { mode: 'strict', allowDomains: ['router.tangle.tools'], includeImplicitDomains: false } },
    })
    expect(ensured.adopt).toBeUndefined()
    expect(ensured.profile.version).toMatch(/^[0-9a-f]{8}$/)
    // The session binds the same profile version the platform records.
    expect(box.createSession.mock.calls[0]![0].sessionId).toBe(`hosted-${person}-${ensured.profile.version}`)
    expect(platform.admit).toHaveBeenCalledWith('hosted-agent', { member: person, role: 'member', turnId: 't-1', channel: 'imessage' })
    expect(platform.setPlan).toHaveBeenCalledWith('hosted-agent', expect.objectContaining({ free: { turnsPerDay: 30, usdPerDay: null } }))
    // The store keeps the conversation only: no box binding, no counters, no admission marks.
    expect([...store.data.keys()]).toEqual([`convo:${person}`])
  })

  it('adopts the box this kit made before the platform kept instances', async () => {
    platform.ensure.mockResolvedValue({ box: runningBox() })
    const { agent: braid, store } = agent()
    store.data.set(`box:${await member(PHONE)}`, 'sbx_before')

    await braid.ask(message(), soon())

    expect(platform.ensure.mock.calls[0]![0].adopt).toBe('sbx_before')
  })

  it('leaves a plan already set on the meter alone and admits the owner as owner', async () => {
    platform.plan.mockResolvedValue({ configured: true })
    platform.ensure.mockResolvedValue({ box: runningBox() })
    const { agent: braid } = agent({ owner: '(555) 010-0001', meter: 'braid' })

    await braid.ask(message(), soon())

    expect(platform.setPlan).not.toHaveBeenCalled()
    expect(platform.admit).toHaveBeenCalledWith('braid', expect.objectContaining({ role: 'owner' }))
  })

  it('asks allow only when paying would lift the limit, and runs no box for a refused turn', async () => {
    const allow = vi.fn(async () => ({ reply: 'Subscribe: https://pay.example/braid' }))
    const { agent: braid } = agent({ allow })

    platform.admit.mockResolvedValueOnce({ ...admitted, decision: 'paywall', paywall: true, turns: { used: 30, limit: 30 } })
    expect(await braid.ask(message('t-2'), soon())).toEqual({ state: 'declined', reply: 'Subscribe: https://pay.example/braid' })
    expect(allow).toHaveBeenCalledWith(message('t-2'), 30)

    platform.admit.mockResolvedValueOnce({ ...admitted, decision: 'allowance_reached', tier: 'paid', turns: { used: 200, limit: 200 } })
    expect(await braid.ask(message('t-3'), soon())).toEqual({ state: 'declined', reply: NOTICE.limit })
    expect(allow).toHaveBeenCalledTimes(1)
    expect(platform.ensure).not.toHaveBeenCalled()
  })

  it('keeps the turn pending while the platform restarts a box that cannot start', async () => {
    platform.ensure.mockRejectedValue(new InstanceRestartingError())
    const { agent: braid } = agent()

    expect(await braid.ask(message(), soon())).toEqual({ state: 'pending' })
  })

  it('keeps the turn pending when the box is still starting at the deadline', async () => {
    platform.ensure.mockResolvedValue({ box: runningBox('starting') })
    const { agent: braid } = agent()

    expect(await braid.ask(message(), { deadline: Date.now() + 500 })).toEqual({ state: 'pending' })
    expect(platform.waitForRunning).not.toHaveBeenCalled()
  })

  it('waits for a starting box until the deadline', async () => {
    const box = runningBox('starting')
    platform.ensure.mockResolvedValue({ box })
    platform.waitForRunning.mockResolvedValue(runningBox())
    const { agent: braid } = agent()

    expect(await braid.ask(message(), soon())).toEqual({ state: 'answered', text: 'Hi, I am Braid.' })
    expect(platform.waitForRunning).toHaveBeenCalledWith('sbx_person', { timeoutMs: expect.any(Number) })
  })
})
