import { describe, expect, it, vi, beforeEach } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())

vi.mock('@tangle-network/sandbox', () => ({
  Sandbox: class {
    list = listMock
    create = createMock
    get = getMock
    secrets = { create: vi.fn(), update: vi.fn(), get: vi.fn(), delete: vi.fn() }
  },
  mergeAgentProfiles: (base: unknown, overlay: unknown) => ({
    ...(base as Record<string, unknown>),
    ...(overlay as Record<string, unknown>),
  }),
}))

import { createSandboxPrewarmer, type PrewarmClaimStore } from './prewarm'
import type { SandboxRuntimeConfig } from './index'
import type { AgentProfile } from '@tangle-network/agent-interface'

const PROFILE: AgentProfile = { name: 'test' } as AgentProfile

function box(over: Record<string, unknown> = {}) {
  return {
    id: 'sandbox-abc',
    name: 'box-w1',
    status: 'running',
    metadata: { harness: 'opencode' },
    connection: {
      runtimeUrl: 'https://rt.example',
      authToken: 't',
      authTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    },
    waitFor: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    ...over,
  }
}

function shell(): SandboxRuntimeConfig {
  return {
    credentials: () => ({ apiKey: 'k', baseUrl: 'https://sandbox.example' }),
    name: (id: string) => `box-${id.slice(0, 16)}`,
    metadata: (harness: string) => ({ harness }),
    connectedIntegrationIds: async () => [],
    env: async () => ({ WORKSPACE_ID: 'w1' }),
    files: async () => [],
    secrets: async () => [],
    profile: () => PROFILE,
    permissionRole: () => 'developer',
  } as unknown as SandboxRuntimeConfig
}

const scope = { workspaceId: 'w1', harness: 'opencode' as const }

/** Claim store backed by a real map, so `acquire` is genuinely exclusive. */
function memoryClaim(): PrewarmClaimStore & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    async acquire(key) {
      if (held.has(key)) return false
      held.add(key)
      return true
    },
    async release(key) {
      held.delete(key)
    },
    async isHeld(key) {
      return held.has(key)
    },
  }
}

beforeEach(() => {
  listMock.mockReset()
  createMock.mockReset()
  getMock.mockReset()
})

describe('createSandboxPrewarmer — cost posture', () => {
  it('spends nothing when the box is already running', async () => {
    listMock.mockResolvedValue([box()])
    const p = createSandboxPrewarmer(shell(), { claim: 'single-isolate-only' })
    const d = await p.prewarm(scope)
    expect(d.outcome).toBe('already-running')
    expect(d.completion).toBeUndefined()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('resume-only (the DEFAULT) never creates a box that does not exist', async () => {
    listMock.mockResolvedValue([])
    const p = createSandboxPrewarmer(shell(), { claim: 'single-isolate-only' })
    const d = await p.prewarm(scope)
    expect(d.outcome).toBe('absent-and-resume-only')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('create-or-resume warms from nothing when the product opts in', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })
    const d = await p.prewarm(scope)
    expect(d.outcome).toBe('started')
    await expect(d.completion).resolves.toMatchObject({ ok: true, boxId: 'sandbox-abc' })
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('a policy refusal costs no create', async () => {
    listMock.mockResolvedValue([])
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      shouldPrewarm: () => false,
    })
    expect((await p.prewarm(scope)).outcome).toBe('declined-by-policy')
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('createSandboxPrewarmer — single flight', () => {
  /**
   * THE guard. The platform does not dedupe by box name (measured: two
   * concurrent same-name creates both returned 201), so a race here leaks a
   * paid box.
   */
  it('two concurrent opens in one isolate create exactly ONE box', async () => {
    listMock.mockResolvedValue([])
    let creates = 0
    createMock.mockImplementation(async () => {
      creates += 1
      await new Promise((r) => setTimeout(r, 20))
      return box()
    })
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })

    const [a, b] = await Promise.all([p.prewarm(scope), p.prewarm(scope)])
    await Promise.all([a.completion, b.completion])

    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['already-warming', 'started'])
    expect(creates).toBe(1)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('two SEPARATE isolates sharing a claim store create exactly ONE box', async () => {
    listMock.mockResolvedValue([])
    let creates = 0
    createMock.mockImplementation(async () => {
      creates += 1
      await new Promise((r) => setTimeout(r, 20))
      return box()
    })
    const claim = memoryClaim()
    // Two prewarmers = two isolates. The in-process map cannot help here; only
    // the shared claim can.
    const iso1 = createSandboxPrewarmer(shell(), { claim, mode: 'create-or-resume' })
    const iso2 = createSandboxPrewarmer(shell(), { claim, mode: 'create-or-resume' })

    const [a, b] = await Promise.all([iso1.prewarm(scope), iso2.prewarm(scope)])
    await Promise.all([a.completion, b.completion])

    expect([a.outcome, b.outcome].sort()).toEqual(['started', 'warming-elsewhere'])
    expect(creates).toBe(1)
  })

  it('releases the claim after a warm so the next one can proceed', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())
    const claim = memoryClaim()
    const p = createSandboxPrewarmer(shell(), { claim, mode: 'create-or-resume' })
    const d = await p.prewarm(scope)
    await d.completion
    expect(claim.held.size).toBe(0)
  })

  it('releases the claim even when the warm FAILS', async () => {
    listMock.mockResolvedValue([])
    createMock.mockRejectedValue(new Error('platform down'))
    const claim = memoryClaim()
    const p = createSandboxPrewarmer(shell(), { claim, mode: 'create-or-resume' })
    const d = await p.prewarm(scope)
    await d.completion
    expect(claim.held.size).toBe(0)
  })

  it('keys on harness, so a different harness is not deduped into one warm', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })
    const a = await p.prewarm({ workspaceId: 'w1', harness: 'opencode' })
    const b = await p.prewarm({ workspaceId: 'w1', harness: 'claude-code' })
    expect(a.outcome).toBe('started')
    expect(b.outcome).toBe('started')
  })
})

describe('createSandboxPrewarmer — failure is loud, never fatal', () => {
  it('resolves (never rejects) when provisioning throws, and reports it', async () => {
    listMock.mockResolvedValue([])
    createMock.mockRejectedValue(new Error('platform down'))
    const events: string[] = []
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      onEvent: (e) => events.push(e.type),
    })
    const d = await p.prewarm(scope)
    await expect(d.completion).resolves.toMatchObject({ ok: false, error: 'platform down' })
    expect(events).toContain('failed')
  })

  it('a peek failure does not throw into the caller', async () => {
    listMock.mockRejectedValue(new Error('list down'))
    const events: unknown[] = []
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      onEvent: (e) => events.push(e),
    })
    await expect(p.prewarm(scope)).resolves.toMatchObject({ outcome: 'cooling-down' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'failed', error: 'list down' }))
  })

  it('suppresses a retry storm after a failure, then retries once cooled', async () => {
    listMock.mockResolvedValue([])
    createMock.mockRejectedValue(new Error('boom'))
    let clock = 1_000
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      failureCooldownMs: 5_000,
      now: () => clock,
    })
    await (await p.prewarm(scope)).completion
    expect(createMock).toHaveBeenCalledTimes(1)

    expect((await p.prewarm(scope)).outcome).toBe('cooling-down')
    expect(createMock).toHaveBeenCalledTimes(1)

    clock += 6_000
    const retry = await p.prewarm(scope)
    expect(retry.outcome).toBe('started')
    await retry.completion
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it('an onEvent that throws cannot break the warm', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      onEvent: () => {
        throw new Error('logger exploded')
      },
    })
    const d = await p.prewarm(scope)
    await expect(d.completion).resolves.toMatchObject({ ok: true })
  })
})

describe('createSandboxPrewarmer — readiness for the UI', () => {
  it('reports ready with the box id, without provisioning', async () => {
    listMock.mockResolvedValue([box()])
    const p = createSandboxPrewarmer(shell(), { claim: 'single-isolate-only' })
    expect(await p.readiness(scope)).toEqual({ status: 'ready', boxId: 'sandbox-abc' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('reports absent when there is no box — the state that must not render as a spinner', async () => {
    listMock.mockResolvedValue([])
    const p = createSandboxPrewarmer(shell(), { claim: 'single-isolate-only' })
    expect(await p.readiness(scope)).toEqual({ status: 'absent' })
  })

  it('reports warming while a warm this isolate started is in flight', async () => {
    listMock.mockResolvedValue([])
    // Hold the create open so the warm is genuinely in flight while we read
    // readiness, then unwind it — the assertion is about the in-flight window,
    // not about how the warm ends.
    let unwind: (err: unknown) => void = () => {}
    let createCalled = false
    createMock.mockImplementation(() => {
      createCalled = true
      return new Promise((_resolve, reject) => { unwind = reject })
    })
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })
    const d = await p.prewarm(scope)
    expect(d.outcome).toBe('started')
    expect(await p.readiness(scope)).toEqual({ status: 'warming' })
    // `unwind` only exists once create has actually been entered; unwinding
    // before that would leave the warm pending forever.
    while (!createCalled) await new Promise((r) => setTimeout(r, 5))
    unwind(new Error('unwound'))
    await expect(d.completion).resolves.toMatchObject({ ok: false })
  })

  it('frees the key by the time `completion` resolves', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })
    const first = await p.prewarm(scope)
    await first.completion
    // Awaiting completion must leave the key free: a caller that re-warms
    // immediately deserves a real decision, not a stale 'already-warming'.
    listMock.mockResolvedValue([box()])
    expect((await p.prewarm(scope)).outcome).toBe('already-running')
  })

  it('reports warming for a warm running in ANOTHER isolate, via the claim store', async () => {
    listMock.mockResolvedValue([])
    const claim = memoryClaim()
    claim.held.add('w1::opencode') // another isolate owns it
    const p = createSandboxPrewarmer(shell(), { claim, mode: 'create-or-resume' })
    expect(await p.readiness(scope)).toEqual({ status: 'warming' })
  })

  it('surfaces a failed warm instead of leaving the UI to spin', async () => {
    listMock.mockResolvedValue([])
    createMock.mockRejectedValue(new Error('no capacity'))
    let clock = 1_000
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
      failureCooldownMs: 5_000,
      now: () => clock,
    })
    await (await p.prewarm(scope)).completion
    expect(await p.readiness(scope)).toEqual({
      status: 'failed',
      error: 'no capacity',
      retryAfterMs: 5_000,
    })
  })

  it('a running box outranks a stale recorded failure', async () => {
    listMock.mockResolvedValueOnce([]).mockResolvedValue([box()])
    createMock.mockRejectedValue(new Error('transient'))
    const p = createSandboxPrewarmer(shell(), {
      claim: 'single-isolate-only',
      mode: 'create-or-resume',
    })
    await (await p.prewarm(scope)).completion
    expect(await p.readiness(scope)).toEqual({ status: 'ready', boxId: 'sandbox-abc' })
  })

  it('a stopped box reads as absent — neither can serve a terminal', async () => {
    listMock.mockResolvedValue([box({ status: 'stopped' })])
    const p = createSandboxPrewarmer(shell(), { claim: 'single-isolate-only' })
    expect(await p.readiness(scope)).toEqual({ status: 'absent' })
  })

  it('an unreadable claim store does not break a status read', async () => {
    listMock.mockResolvedValue([])
    const claim: PrewarmClaimStore = {
      acquire: async () => true,
      release: async () => {},
      isHeld: async () => {
        throw new Error('kv down')
      },
    }
    const p = createSandboxPrewarmer(shell(), { claim })
    expect(await p.readiness(scope)).toEqual({ status: 'absent' })
  })
})
