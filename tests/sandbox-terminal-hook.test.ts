/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSandboxTerminalConnectionRoute, type TerminalConnectionBoxLike } from '../src/sandbox/index'
import { tabTerminalConnectionId, useSandboxTerminalConnection } from '../src/web-react/sandbox-terminal'

describe('useSandboxTerminalConnection', () => {
  it('polls through provisioning responses and stores the ready terminal connection', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'provisioning' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        runtimeUrl: '/api/workspaces/workspace-1/sandbox/runtime/box-1',
        sidecarUrl: '/api/workspaces/workspace-1/sandbox/sidecar/box-1',
        token: 'token-1',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        status: 'running',
        sandboxId: 'box-1',
      }))

    const { result } = renderHook(() => useSandboxTerminalConnection({
      workspaceId: 'workspace-1',
      fetcher,
      provisionPollIntervalMs: 1,
      provisionPollTimeoutMs: 1_000,
    }))

    await waitFor(() => expect(result.current.token).toBe('token-1'))

    expect(result.current.status).toBe('running')
    expect(result.current.runtimeUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(result.current.sidecarUrl).toBe('/api/workspaces/workspace-1/sandbox/sidecar/box-1')
    expect(result.current.sandboxId).toBe('box-1')
    expect(result.current.loading).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/workspace-1/sandbox/connection')
  })

  it('refreshes the connection before token expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        runtimeUrl: '/runtime/one',
        token: 'token-1',
        expiresAt: new Date(Date.now() + 120).toISOString(),
        status: 'running',
      }))
      .mockResolvedValueOnce(Response.json({
        runtimeUrl: '/runtime/two',
        token: 'token-2',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'running',
      }))

    try {
      const { result } = renderHook(() => useSandboxTerminalConnection({
        workspaceId: 'workspace-1',
        fetcher,
        tokenRefreshSkewMs: 100,
      }))

      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.token).toBe('token-1')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(result.current.token).toBe('token-2')

      expect(result.current.runtimeUrl).toBe('/runtime/two')
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling after unmount', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => Response.json({ status: 'provisioning' }, { status: 503 }))

    try {
      const { unmount } = renderHook(() => useSandboxTerminalConnection({
        workspaceId: 'workspace-1',
        fetcher,
        provisionPollIntervalMs: 10,
        provisionPollTimeoutMs: 100,
      }))

      await act(async () => {
        await Promise.resolve()
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })

      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// #341/#349 — the unmodified hook driven by the REAL browser-direct factory
// as its `fetcher`, proving the transport-agnostic contract end to end rather
// than against a hand-written response fixture.
describe('useSandboxTerminalConnection over createSandboxTerminalConnectionRoute', () => {
  it('polls through a 503 provisioning response to the direct sidecar URL', async () => {
    vi.useFakeTimers()
    let calls = 0
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => {
        calls += 1
        if (calls < 3) {
          return { id: 'box-1', status: 'provisioning', connection: undefined, mintScopedToken: vi.fn() }
        }
        return {
          id: 'box-1',
          status: 'running',
          connection: { runtimeUrl: 'https://sidecar.example/direct' },
          mintScopedToken: vi.fn(async () => ({
            token: 'tok-1',
            expiresAt: new Date(Date.now() + 10 * 60_000),
          })),
        }
      },
    })

    // Bound to a stable `const` OUTSIDE the renderHook callback: an inline
    // arrow created fresh on every render would give the hook's memoized
    // `connect` a new dependency identity each render, re-triggering its
    // mount effect and spinning forever.
    const fetcher = (input: RequestInfo | URL) => handler(new Request(new URL(String(input), 'https://app.test')))

    try {
      const { result } = renderHook(() => useSandboxTerminalConnection({
        workspaceId: 'workspace-1',
        fetcher,
        provisionPollIntervalMs: 10,
        provisionPollTimeoutMs: 1_000,
      }))

      // First mount fetch (calls=1) resolves to a 503 — deterministic under
      // fake timers, unlike polling this with real timers + `waitFor`.
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.status).toBe('provisioning')
      expect(calls).toBe(1)

      // Second poll (calls=2) — still provisioning.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(result.current.status).toBe('provisioning')
      expect(calls).toBe(2)

      // Third poll (calls=3) — the box is ready.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(calls).toBe(3)
      expect(result.current.token).toBe('tok-1')
      expect(result.current.runtimeUrl).toBe('https://sidecar.example/direct')
      expect(result.current.sidecarUrl).toBe('https://sidecar.example/direct')
      expect(result.current.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-invokes the factory and rotates the token before expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    const box: TerminalConnectionBoxLike = {
      id: 'box-1',
      status: 'running',
      connection: { runtimeUrl: 'https://sidecar.example/direct' },
      mintScopedToken: vi.fn(),
    }
    let mintCalls = 0
    box.mintScopedToken = vi.fn(async () => {
      mintCalls += 1
      return { token: `tok-${mintCalls}`, expiresAt: new Date(Date.now() + 120) }
    })
    const handler = createSandboxTerminalConnectionRoute<TerminalConnectionBoxLike, { id: string }>({
      requireUser: async () => ({ id: 'user-1' }),
      ensureSandbox: async () => box,
    })

    // Same stable-reference requirement as the test above.
    const fetcher = (input: RequestInfo | URL) => handler(new Request(new URL(String(input), 'https://app.test')))

    try {
      const { result } = renderHook(() => useSandboxTerminalConnection({
        workspaceId: 'workspace-1',
        fetcher,
        tokenRefreshSkewMs: 100,
      }))

      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.token).toBe('tok-1')
      expect(result.current.runtimeUrl).toBe('https://sidecar.example/direct')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(mintCalls).toBe(2)
      expect(result.current.token).toBe('tok-2')
      expect(result.current.runtimeUrl).toBe('https://sidecar.example/direct')
    } finally {
      vi.useRealTimers()
    }
  })
})

// Moved from the now-deleted `workspace-terminal-panel.test.tsx` (#340, the
// shared terminal panel component removal) — these guard `tabTerminalConnectionId`
// in `sandbox-terminal.ts`, which stays.
describe('tabTerminalConnectionId', () => {
  beforeEach(() => sessionStorage.clear())

  it('is stable across calls in the same tab and persists in sessionStorage', () => {
    const a = tabTerminalConnectionId()
    const b = tabTerminalConnectionId()
    expect(a).toBe(b)
    expect(sessionStorage.getItem('agent-app:terminal-connection-id')).toBe(a)
  })

  it('honors a custom storage key', () => {
    const id = tabTerminalConnectionId('custom:key')
    expect(sessionStorage.getItem('custom:key')).toBe(id)
  })

  it('keeps ids UNIQUE when sessionStorage is unavailable, instead of collapsing to one', () => {
    // SSR / privacy mode. The sidecar keys one live connection per id, so a
    // fallback that derives a deterministic id (e.g. from the sandbox id) hands
    // every client the SAME id and their reconnects evict each other — the
    // terminal sticks on "reconnecting" forever. The fallback must stay unique
    // per call even though it can no longer be reload-stable.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sessionStorage is not available')
      },
    })
    try {
      const ids = new Set([
        tabTerminalConnectionId('same:key'),
        tabTerminalConnectionId('same:key'),
        tabTerminalConnectionId('same:key'),
      ])
      expect(ids.size).toBe(3)
      for (const id of ids) expect(id).toBeTruthy()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'sessionStorage')
    }
  })
})
