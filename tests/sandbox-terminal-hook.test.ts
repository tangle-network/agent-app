/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSandboxTerminalConnection } from '../src/web-react/sandbox-terminal'

describe('useSandboxTerminalConnection', () => {
  it('polls through provisioning responses and stores the ready terminal connection', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'provisioning' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        runtimeUrl: '/api/workspaces/workspace-1/sandbox/runtime/box-1',
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
    expect(result.current.sidecarUrl).toBe('/api/workspaces/workspace-1/sandbox/runtime/box-1')
    expect(result.current.loading).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/workspace-1/sandbox/connection')
  })

  it('refreshes the connection before token expiry', async () => {
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

    const { result } = renderHook(() => useSandboxTerminalConnection({
      workspaceId: 'workspace-1',
      fetcher,
      tokenRefreshSkewMs: 100,
    }))

    await waitFor(() => expect(result.current.token).toBe('token-1'))
    await waitFor(() => expect(result.current.token).toBe('token-2'))

    expect(result.current.runtimeUrl).toBe('/runtime/two')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
