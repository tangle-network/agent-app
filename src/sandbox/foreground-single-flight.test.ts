import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { SandboxInstance } from '@tangle-network/sandbox/core'
import type { Harness } from '../harness/index'
import {
  createD1PrewarmClaimStore,
  PREWARM_CLAIM_TABLE_DDL,
  type PrewarmClaimD1Like,
} from './prewarm-claim-d1'
import {
  runForegroundSandboxSingleFlight,
  type ReadyRunningSandboxOutcome,
  SandboxFilesystemNotReadyError,
  SandboxProvisioningFailedElsewhereError,
} from './foreground-single-flight'

function d1(db: DatabaseSync): PrewarmClaimD1Like {
  return {
    prepare(query: string) {
      const statement = db.prepare(query)
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (statement.get(...(values as never[])) as T | undefined) ?? null
            },
            async run() {
              return statement.run(...(values as never[]))
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function box(
  id: string,
  readiness: 'ready' | 'transitioning' | undefined = 'ready',
): SandboxInstance {
  return { id, filesystemIncarnationReadiness: readiness } as SandboxInstance
}

const harness = 'opencode' as Harness

describe('runForegroundSandboxSingleFlight', () => {
  it('does not let an expired owner release a successor while it provisions', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })
    const finishA = deferred<void>()
    const finishB = deferred<void>()
    const finishC = deferred<void>()
    let readyB = false
    const provision = vi.fn(async (id: string) => {
      if (id === 'a') await finishA.promise
      if (id === 'b') {
        await finishB.promise
        readyB = true
      }
      if (id === 'c') await finishC.promise
      return box(`box-${id}`)
    })
    const options = (id: string) => ({
      claim: store,
      workspaceId: 'workspace-1',
      harness,
      provision: () => provision(id),
      peek: async () => readyB
        ? ({ status: 'running', box: box('box-b') } as const)
        : ({ status: 'absent' } as const),
      adopt: (outcome: ReadyRunningSandboxOutcome) => outcome.box,
      claimTtlSeconds: 1,
      pollIntervalMs: 1,
    })

    const ownerA = runForegroundSandboxSingleFlight(options('a'))
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith('a'))

    clock = 2_001
    const ownerB = runForegroundSandboxSingleFlight(options('b'))
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith('b'))

    finishA.resolve()
    await ownerA

    const ownerC = runForegroundSandboxSingleFlight(options('c'))
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(provision).toHaveBeenCalledTimes(2)

      finishB.resolve()
      await ownerB
      await expect(ownerC).resolves.toMatchObject({ id: 'box-b' })
    } finally {
      finishB.resolve()
      finishC.resolve()
      await Promise.allSettled([ownerB, ownerC])
    }
  })

  it('lets one request provision and makes the loser adopt that ready box', async () => {
    const db = freshDb()
    const ownerStarted = deferred<void>()
    const finishOwner = deferred<void>()
    let ready = false
    const provision = vi.fn(async () => {
      ownerStarted.resolve()
      await finishOwner.promise
      ready = true
      return box('box-1')
    })
    const peek = vi.fn(async () =>
      ready
        ? ({ status: 'running', box: box('box-1') } as const)
        : ({ status: 'absent' } as const),
    )
    const adopt = vi.fn((outcome) => outcome.box)

    const options = () => ({
      claim: createD1PrewarmClaimStore(d1(db)),
      workspaceId: 'workspace-1',
      harness,
      provision,
      peek,
      adopt,
    })
    const owner = runForegroundSandboxSingleFlight(options())
    await ownerStarted.promise
    const loser = runForegroundSandboxSingleFlight({
      ...options(),
      wait: async () => {
        finishOwner.resolve()
        await owner
      },
    })

    await expect(loser).resolves.toMatchObject({ id: 'box-1' })
    expect(provision).toHaveBeenCalledOnce()
    expect(adopt).toHaveBeenCalledOnce()
  })

  it('does not adopt a ready box while the owner claim remains active', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db))
    await store.acquire('workspace-1::opencode', 180)
    let polls = 0
    const adopt = vi.fn((outcome) => outcome.box)

    const result = runForegroundSandboxSingleFlight({
      claim: store,
      workspaceId: 'workspace-1',
      harness,
      provision: vi.fn(async () => box('never')),
      peek: async () => ({ status: 'running', box: box('box-1') }),
      adopt,
      wait: async () => {
        polls += 1
        if (polls === 2) await store.release('workspace-1::opencode')
      },
    })

    await expect(result).resolves.toMatchObject({ id: 'box-1' })
    expect(polls).toBe(2)
    expect(adopt).toHaveBeenCalledOnce()
  })

  it('reports a released owner that left no usable box', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db))
    await store.acquire('workspace-1::opencode', 180)

    const result = runForegroundSandboxSingleFlight({
      claim: store,
      workspaceId: 'workspace-1',
      harness,
      provision: vi.fn(async () => box('never')),
      peek: async () => ({ status: 'not-running', state: 'failed', box: box('failed') }),
      adopt: (outcome) => outcome.box,
      wait: async () => store.release('workspace-1::opencode'),
    })

    await expect(result).rejects.toMatchObject({
      name: 'SandboxProvisioningFailedElsewhereError',
      code: 'sandbox.provisioning_failed_elsewhere',
      workspaceId: 'workspace-1',
      state: 'failed',
    } satisfies Partial<SandboxProvisioningFailedElsewhereError>)
  })

  it('reports a box whose owner stopped before filesystem readiness', async () => {
    const db = freshDb()
    const store = createD1PrewarmClaimStore(d1(db))
    await store.acquire('workspace-1::opencode', 180)

    const result = runForegroundSandboxSingleFlight({
      claim: store,
      workspaceId: 'workspace-1',
      harness,
      provision: vi.fn(async () => box('never')),
      peek: async () => ({ status: 'warming', readiness: 'transitioning', box: box('warming', 'transitioning') }),
      adopt: (outcome) => outcome.box,
      wait: async () => store.release('workspace-1::opencode'),
    })

    await expect(result).rejects.toMatchObject({
      name: 'SandboxFilesystemNotReadyError',
      code: 'sandbox.filesystem_not_ready',
      workspaceId: 'workspace-1',
      readiness: 'transitioning',
      retryable: true,
    } satisfies Partial<SandboxFilesystemNotReadyError>)
  })

  it('takes over a retained claim after it expires', async () => {
    const db = freshDb()
    let clock = 1_000
    const store = createD1PrewarmClaimStore(d1(db), { now: () => clock })
    await store.acquire('workspace-1::opencode', 60)
    const provision = vi.fn(async () => box('box-2'))

    const result = runForegroundSandboxSingleFlight({
      claim: store,
      workspaceId: 'workspace-1',
      harness,
      provision,
      peek: async () => ({ status: 'absent' }),
      adopt: (outcome) => outcome.box,
      wait: async () => {
        clock = 61_001
      },
    })

    await expect(result).resolves.toMatchObject({ id: 'box-2' })
    expect(provision).toHaveBeenCalledOnce()
  })

  it('surfaces a release failure as telemetry without replacing the result', async () => {
    const events: unknown[] = []
    const hostile = Object.create(null)
    const result = await runForegroundSandboxSingleFlight({
      claim: {
        acquire: async () => true,
        release: async () => undefined,
        acquireLease: async (key) => ({ key, expiresAt: 1 }),
        releaseLease: async () => {
          throw hostile
        },
        isHeld: async () => false,
        inspect: async () => ({ status: 'absent' }),
      },
      workspaceId: 'workspace-1',
      harness,
      provision: async () => box('box-1'),
      peek: async () => ({ status: 'absent' }),
      adopt: (outcome) => outcome.box,
      onEvent: (event) => events.push(event),
    })

    expect(result).toMatchObject({ id: 'box-1' })
    expect(events).toEqual([
      expect.objectContaining({ type: 'release-failed', error: 'unknown error' }),
    ])
  })
})
