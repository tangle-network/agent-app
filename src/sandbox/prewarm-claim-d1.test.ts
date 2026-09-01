import { describe, expect, expectTypeOf, it, vi, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const listMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())

vi.mock('@tangle-network/sandbox/core', () => ({
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

import {
  createD1PrewarmClaimStore,
  PREWARM_CLAIM_TABLE_DDL,
  type PrewarmClaimD1Like,
} from './prewarm-claim-d1'
import {
  createSandboxPrewarmer,
  type FencedPrewarmClaimStore,
  type InspectablePrewarmClaimStore,
  type PrewarmClaimStore,
} from './prewarm'
import type { SandboxRuntimeConfig } from './index'
import type { AgentProfile } from '@tangle-network/agent-interface'

/**
 * A REAL SQLite behind the narrow D1 shape.
 *
 * The whole claim is about what one `INSERT … ON CONFLICT DO UPDATE … WHERE …
 * RETURNING` statement does when two callers race, and a hand-written fake
 * would just encode my own belief about that. `node:sqlite` runs the actual
 * statement against the actual engine D1 is built on, so the assertion is
 * against the database rather than against my model of it.
 */
function d1(db: DatabaseSync): PrewarmClaimD1Like {
  return {
    prepare(query: string) {
      const stmt = db.prepare(query)
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (stmt.get(...(values as never[])) as T | undefined) ?? null
            },
            async run() {
              return stmt.run(...(values as never[]))
            },
          }
        },
      }
    },
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(PREWARM_CLAIM_TABLE_DDL)
  return db
}

describe('createD1PrewarmClaimStore', () => {
  it('keeps the published claim methods source-compatible while adding fencing', () => {
    const legacyStore = {
      acquire: async (_key: string, _ttlSeconds: number) => true,
      release: async (_key: string) => undefined,
    }

    expectTypeOf(legacyStore).toMatchTypeOf<PrewarmClaimStore>()
    expectTypeOf<FencedPrewarmClaimStore>().toMatchTypeOf<InspectablePrewarmClaimStore>()
    expectTypeOf(createD1PrewarmClaimStore(d1(freshDb()))).toMatchTypeOf<FencedPrewarmClaimStore>()
  })

  it('gives the claim to exactly one of two racing callers', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db), { now: () => 1_000 })

    const results = await Promise.all([
      store.acquire('w1:opencode', 180),
      store.acquire('w1:opencode', 180),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('refuses a claim another caller still holds, and grants it once expired', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })

    expect(await store.acquire('k', 60)).toBe(true)
    clock = 30_000
    expect(await store.acquire('k', 60)).toBe(false)

    // The TTL is the backstop for an isolate that died mid-warm: without this
    // takeover a single crash would wedge the workspace forever.
    clock = 61_001
    expect(await store.acquire('k', 60)).toBe(true)
  })

  it('frees the key on release so the next open warms immediately', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db), { now: () => 1_000 })

    expect(await store.acquire('k', 180)).toBe(true)
    expect(await store.acquire('k', 180)).toBe(false)
    await store.release('k')
    expect(await store.acquire('k', 180)).toBe(true)
  })

  it('reports isHeld only while the claim is live, so readiness can say "warming"', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })

    expect(await store.isHeld('k')).toBe(false)
    await store.acquire('k', 60)
    expect(await store.isHeld('k')).toBe(true)
    clock = 61_001
    expect(await store.isHeld('k')).toBe(false)
  })

  it('distinguishes a released claim from one retained past expiry', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })

    expect(await store.inspect('k')).toEqual({ status: 'absent' })
    await store.acquire('k', 60)
    expect(await store.inspect('k')).toEqual({ status: 'held', expiresAt: 61_000 })
    clock = 61_001
    expect(await store.inspect('k')).toEqual({ status: 'expired', expiresAt: 61_000 })
    await store.release('k')
    expect(await store.inspect('k')).toEqual({ status: 'absent' })
  })

  it('fences a stale release after a takeover', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })

    const leaseA = await store.acquireLease('k', 1)
    expect(leaseA).not.toBeNull()
    clock = 2_001
    const leaseB = await store.acquireLease('k', 1)
    expect(leaseB).not.toBeNull()
    expect(leaseB?.expiresAt).toBeGreaterThan(leaseA?.expiresAt ?? 0)

    await store.releaseLease(leaseA!)
    expect(await store.inspect('k')).toEqual({ status: 'held', expiresAt: leaseB!.expiresAt })
    expect(await store.acquireLease('k', 1)).toBeNull()

    await store.releaseLease(leaseB!)
    expect(await store.inspect('k')).toEqual({ status: 'absent' })
  })

  it('retains the fence across a release and same-clock reacquire', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db), { now: () => 1_000 })

    const leaseA = await store.acquireLease('k', 1)
    await store.releaseLease(leaseA!)
    const leaseB = await store.acquireLease('k', 1)

    expect(leaseB?.expiresAt).toBeGreaterThan(leaseA?.expiresAt ?? 0)
    await store.releaseLease(leaseA!)
    expect(await store.inspect('k')).toEqual({ status: 'held', expiresAt: leaseB!.expiresAt })

    await store.releaseLease(leaseB!)
    expect(await store.inspect('k')).toEqual({ status: 'absent' })
  })

  it('rejects a table name that is not a bare identifier', () => {
    const db = freshDb()
    expect(() => createD1PrewarmClaimStore(d1(db), { table: 'claims; DROP TABLE users' }))
      .toThrow(/Invalid prewarm claim table name/)
  })

  it('throws when the table is missing rather than silently allowing a double warm', async () => {
    const bare = new DatabaseSync(':memory:')
    const store = createD1PrewarmClaimStore(d1(bare))
    await expect(store.acquire('k', 60)).rejects.toThrow()
  })
})

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

describe('the store as the prewarmer uses it', () => {
  beforeEach(() => {
    listMock.mockReset()
    createMock.mockReset()
    getMock.mockReset()
  })

  /**
   * The one that matters. Two prewarmers = two isolates: separate in-process
   * maps, so the free same-isolate guard cannot help. Only the shared D1 lease
   * stands between "one box" and the two running boxes the platform was
   * measured to hand out for identical concurrent creates.
   */
  it('stops two isolates from each creating a box for the same workspace', async () => {
    const db = freshDb()
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())

    const make = () =>
      createSandboxPrewarmer(shell(), {
        claim: createD1PrewarmClaimStore(d1(db)),
        mode: 'create-or-resume',
      })

    const [a, b] = await Promise.all([make().prewarm(scope), make().prewarm(scope)])
    await Promise.all([a.completion, b.completion])

    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['started', 'warming-elsewhere'])
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('lets the next isolate warm after the first one released', async () => {
    const db = freshDb()
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(box())

    const first = createSandboxPrewarmer(shell(), {
      claim: createD1PrewarmClaimStore(d1(db)),
      mode: 'create-or-resume',
    })
    const decision = await first.prewarm(scope)
    await decision.completion

    // A second isolate, still finding no running box, must not be blocked by a
    // lease the finished warm already gave back.
    const second = createSandboxPrewarmer(shell(), {
      claim: createD1PrewarmClaimStore(d1(db)),
      mode: 'create-or-resume',
    })
    expect((await second.prewarm(scope)).outcome).toBe('started')
  })
})
