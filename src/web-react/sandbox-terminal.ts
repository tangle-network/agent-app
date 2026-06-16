import { useCallback, useEffect, useState } from 'react'

export interface SandboxTerminalConnection {
  runtimeUrl: string | null
  sidecarUrl: string | null
  token: string | null
  expiresAt: string | null
  status: string
  error: string | null
  loading: boolean
  sandboxId?: string
}

export interface SandboxTerminalConnectionResponse {
  runtimeUrl?: string
  sidecarUrl?: string
  token?: string
  expiresAt?: string
  status?: string
  error?: string
  sandboxId?: string
}

export interface UseSandboxTerminalConnectionOptions {
  workspaceId: string
  connectionUrl?: string | ((workspaceId: string) => string)
  fetcher?: typeof fetch
  provisionPollIntervalMs?: number
  provisionPollTimeoutMs?: number
  tokenRefreshSkewMs?: number
}

export interface UseSandboxTerminalConnectionResult extends SandboxTerminalConnection {
  connect: () => Promise<void>
}

const DEFAULT_PROVISION_POLL_INTERVAL_MS = 2_000
const DEFAULT_PROVISION_POLL_TIMEOUT_MS = 90_000
const DEFAULT_TOKEN_REFRESH_SKEW_MS = 120_000

const EMPTY_CONNECTION: SandboxTerminalConnection = {
  runtimeUrl: null,
  sidecarUrl: null,
  token: null,
  expiresAt: null,
  status: 'idle',
  error: null,
  loading: false,
}

export function useSandboxTerminalConnection(opts: UseSandboxTerminalConnectionOptions): UseSandboxTerminalConnectionResult {
  const [conn, setConn] = useState<SandboxTerminalConnection>(EMPTY_CONNECTION)
  const fetcher = opts.fetcher ?? fetch
  const pollIntervalMs = opts.provisionPollIntervalMs ?? DEFAULT_PROVISION_POLL_INTERVAL_MS
  const pollTimeoutMs = opts.provisionPollTimeoutMs ?? DEFAULT_PROVISION_POLL_TIMEOUT_MS
  const refreshSkewMs = opts.tokenRefreshSkewMs ?? DEFAULT_TOKEN_REFRESH_SKEW_MS

  const connectionUrl = useCallback(() => {
    if (typeof opts.connectionUrl === 'function') return opts.connectionUrl(opts.workspaceId)
    return opts.connectionUrl ?? `/api/workspaces/${encodeURIComponent(opts.workspaceId)}/sandbox/connection`
  }, [opts.connectionUrl, opts.workspaceId])

  const connect = useCallback(async () => {
    setConn((current) => ({ ...current, loading: true, error: null }))
    const deadline = Date.now() + pollTimeoutMs
    while (true) {
      try {
        const res = await fetcher(connectionUrl())
        const data = (await res.json()) as SandboxTerminalConnectionResponse
        const runtimeUrl = data.runtimeUrl ?? data.sidecarUrl
        if (res.ok && runtimeUrl && data.token && data.expiresAt) {
          setConn({
            runtimeUrl,
            sidecarUrl: runtimeUrl,
            token: data.token,
            expiresAt: data.expiresAt,
            status: data.status ?? 'running',
            error: null,
            loading: false,
            ...(data.sandboxId ? { sandboxId: data.sandboxId } : {}),
          })
          return
        }
        if (res.ok) {
          setConn({
            runtimeUrl: null,
            sidecarUrl: null,
            token: null,
            expiresAt: null,
            loading: false,
            error: 'Sandbox connection response is missing required fields',
            status: data.status ?? 'error',
            ...(data.sandboxId ? { sandboxId: data.sandboxId } : {}),
          })
          return
        }
        if (res.status === 503 && Date.now() < deadline) {
          setConn((current) => ({
            ...current,
            loading: true,
            status: data.status ?? 'provisioning',
            error: null,
          }))
          await sleep(pollIntervalMs)
          continue
        }
        setConn((current) => ({
          ...current,
          runtimeUrl: null,
          sidecarUrl: null,
          token: null,
          expiresAt: null,
          loading: false,
          error: data.error ?? 'Sandbox not available',
          status: data.status ?? 'error',
        }))
        return
      } catch (err) {
        if (Date.now() < deadline) {
          await sleep(pollIntervalMs)
          continue
        }
        setConn((current) => ({
          ...current,
          runtimeUrl: null,
          sidecarUrl: null,
          token: null,
          expiresAt: null,
          loading: false,
          error: err instanceof Error ? err.message : 'Connection failed',
        }))
        return
      }
    }
  }, [connectionUrl, fetcher, pollIntervalMs, pollTimeoutMs])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    if (!conn.runtimeUrl || !conn.token || !conn.expiresAt) return
    const refreshAt = Date.parse(conn.expiresAt) - Date.now() - refreshSkewMs
    if (!Number.isFinite(refreshAt)) {
      setConn((current) => ({
        ...current,
        runtimeUrl: null,
        sidecarUrl: null,
        token: null,
        expiresAt: null,
        status: 'error',
        error: 'Sandbox token expiry is invalid',
      }))
      return
    }
    const timer = window.setTimeout(() => {
      void connect()
    }, Math.max(1_000, refreshAt))
    return () => window.clearTimeout(timer)
  }, [conn.runtimeUrl, conn.token, conn.expiresAt, connect, refreshSkewMs])

  return { ...conn, connect }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
