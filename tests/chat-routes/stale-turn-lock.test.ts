/**
 * The stale-turn-lock recovery policy. Both halves of the contract matter: the
 * session authority's verdict wins whenever it can be obtained, and when the
 * box cannot be reached at all the lock is force-released past a grace period
 * rather than left to expire on its TTL.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_STALE_TURN_LOCK_GRACE_MS,
  reconcileStaleTurnLock,
  type ReconcileStaleTurnLockOptions,
  type StaleTurnLockSandboxProbeResult,
  type StaleTurnLockSessionProbeResult,
} from '../../src/chat-routes/index'

const NOW = 1_800_000_000_000

function reconcile(
  over: Partial<ReconcileStaleTurnLockOptions> & { lockAgeMs?: number } = {},
): {
  run: Promise<Awaited<ReturnType<typeof reconcileStaleTurnLock>>>
  release: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} {
  const { lockAgeMs = 90_000, ...rest } = over
  const release = vi.fn().mockResolvedValue(true)
  const log = vi.fn()
  const run = reconcileStaleTurnLock({
    lockStartedAt: NOW - lockAgeMs,
    now: () => NOW,
    probeSandbox: async (): Promise<StaleTurnLockSandboxProbeResult> => ({ status: 'running' }),
    probeSession: async (): Promise<StaleTurnLockSessionProbeResult> => ({ reachable: true, terminal: true }),
    release,
    log,
    context: { workspaceId: 'ws-1', threadId: 'thread-1', executionId: 'exec-1' },
    ...rest,
  })
  return { run, release, log }
}

describe('reconcileStaleTurnLock: the session authority answers', () => {
  it('releases when the execution is terminal', async () => {
    const { run, release } = reconcile({
      probeSession: async () => ({ reachable: true, terminal: true, diagnostics: { state: 'completed' } }),
    })

    const result = await run
    expect(result.released).toBe(true)
    expect(result.diagnostics).toMatchObject({ sandboxReachable: true, sessionTerminal: true, state: 'completed' })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('holds unconditionally when the execution is live — the unreachable fallback cannot override it', async () => {
    const { run, release, log } = reconcile({
      // Far past the grace period: if the fallback could win here, it would.
      lockAgeMs: DEFAULT_STALE_TURN_LOCK_GRACE_MS * 10,
      probeSession: async () => ({
        reachable: true,
        terminal: false,
        diagnostics: { activeExecutionId: 'exec-1' },
      }),
    })

    const result = await run
    expect(result.released).toBe(false)
    expect(result.diagnostics).toMatchObject({ sessionTerminal: false, activeExecutionId: 'exec-1' })
    expect(release).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('reports released:false when the lock was already gone', async () => {
    const release = vi.fn().mockResolvedValue(false)
    const result = await reconcileStaleTurnLock({
      lockStartedAt: NOW - 90_000,
      now: () => NOW,
      probeSandbox: async () => ({ status: 'running' }),
      probeSession: async () => ({ reachable: true, terminal: true }),
      release,
    })
    expect(result.released).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('never probes the session when the box is not running', async () => {
    const probeSession = vi.fn()
    const { run } = reconcile({ probeSandbox: async () => ({ status: 'absent' }), probeSession })
    await run
    expect(probeSession).not.toHaveBeenCalled()
  })
})

describe('reconcileStaleTurnLock: the authority cannot be reached', () => {
  const unreachable: Array<[string, Partial<ReconcileStaleTurnLockOptions>, string]> = [
    [
      'the sandbox probe throws',
      { probeSandbox: async () => { throw new Error('listing failed') } },
      'SANDBOX_PROBE_FAILED',
    ],
    ['the box is gone', { probeSandbox: async () => ({ status: 'absent' }) }, 'SANDBOX_ABSENT'],
    [
      'the box is stopped',
      { probeSandbox: async () => ({ status: 'not-running', state: 'stopped' }) },
      'SANDBOX_NOT_RUNNING',
    ],
    [
      'the session probe throws',
      { probeSession: async () => { throw new Error('socket hang up') } },
      'SESSION_PROBE_FAILED',
    ],
    [
      'the session probe reports unreachable',
      { probeSession: async () => ({ reachable: false, reason: 'SIDECAR_TIMEOUT' }) },
      'SESSION_UNREACHABLE',
    ],
  ]

  it.each(unreachable)('force-releases past the grace period when %s', async (_label, over, reason) => {
    const lockAgeMs = DEFAULT_STALE_TURN_LOCK_GRACE_MS + 60_000
    const { run, release, log } = reconcile({ ...over, lockAgeMs })

    const result = await run
    expect(result.released).toBe(true)
    expect(result.diagnostics).toMatchObject({
      unreachableReason: reason,
      sandboxReachable: false,
      lockAgeMs,
      forceReleaseGraceMs: DEFAULT_STALE_TURN_LOCK_GRACE_MS,
      forceReleased: true,
    })
    expect(release).toHaveBeenCalledTimes(1)

    // A force-release is never silent: an operator can find why chat unblocked.
    const [message, meta] = log.mock.calls.at(-1)!
    expect(String(message)).toContain('force-released stale turn lock')
    expect(meta).toMatchObject({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      executionId: 'exec-1',
      unreachableReason: reason,
      lockAgeMs,
      forceReleaseGraceMs: DEFAULT_STALE_TURN_LOCK_GRACE_MS,
      released: true,
    })
  })

  it.each(unreachable)('holds and logs inside the grace period when %s', async (_label, over) => {
    const { run, release, log } = reconcile({ ...over, lockAgeMs: 5_000 })

    const result = await run
    expect(result.released).toBe(false)
    expect(result.diagnostics).toMatchObject({ forceReleaseWithheld: 'LOCK_WITHIN_GRACE_PERIOD', lockAgeMs: 5_000 })
    expect(release).not.toHaveBeenCalled()
    expect(String(log.mock.calls.at(-1)![0])).toContain('inside the grace period')
  })

  it('carries the sandbox state and the probe detail into the diagnostics', async () => {
    const stopped = await reconcile({
      probeSandbox: async () => ({ status: 'not-running', state: 'failed' }),
      lockAgeMs: DEFAULT_STALE_TURN_LOCK_GRACE_MS + 1,
    }).run
    expect(stopped.diagnostics).toMatchObject({ sandboxState: 'failed' })

    const threw = await reconcile({
      probeSandbox: async () => { throw new Error('bootstrap failed on reused box') },
      lockAgeMs: DEFAULT_STALE_TURN_LOCK_GRACE_MS + 1,
    }).run
    expect(threw.diagnostics).toMatchObject({ unreachableDetail: 'bootstrap failed on reused box' })
  })

  it('honours a caller-supplied grace period', async () => {
    const held = await reconcile({
      probeSandbox: async () => ({ status: 'absent' }),
      lockAgeMs: 30_000,
      graceMs: 60_000,
    }).run
    expect(held.released).toBe(false)

    const released = await reconcile({
      probeSandbox: async () => ({ status: 'absent' }),
      lockAgeMs: 30_000,
      graceMs: 10_000,
    }).run
    expect(released.released).toBe(true)
  })

  it('defaults its log sink to console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await reconcileStaleTurnLock({
        lockStartedAt: NOW - (DEFAULT_STALE_TURN_LOCK_GRACE_MS + 1),
        now: () => NOW,
        probeSandbox: async () => ({ status: 'absent' }),
        probeSession: async () => ({ reachable: true, terminal: true }),
        release: () => true,
      })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
