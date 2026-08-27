import { useCallback, useEffect, useRef, useState } from 'react'

/** Define the connection details and status for a sandbox terminal session */
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

/** Define the response structure for a sandbox terminal connection including URLs, token, status, and errors */
export interface SandboxTerminalConnectionResponse {
  runtimeUrl?: string
  sidecarUrl?: string
  token?: string
  expiresAt?: string
  status?: string
  error?: string
  sandboxId?: string
}

/** Define options for configuring a sandbox terminal connection including workspace ID and connection parameters */
export interface UseSandboxTerminalConnectionOptions {
  workspaceId: string
  connectionUrl?: string | ((workspaceId: string) => string)
  fetcher?: typeof fetch
  provisionPollIntervalMs?: number
  provisionPollTimeoutMs?: number
  tokenRefreshSkewMs?: number
}

/** Resolve sandbox terminal connection status and provide a method to initiate the connection */
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

/** Manage and maintain a sandbox terminal connection with automatic polling and token refresh handling */
export function useSandboxTerminalConnection(opts: UseSandboxTerminalConnectionOptions): UseSandboxTerminalConnectionResult {
  const [conn, setConn] = useState<SandboxTerminalConnection>(EMPTY_CONNECTION)
  const mountedRef = useRef(false)
  const generationRef = useRef(0)
  const fetcher = opts.fetcher ?? fetch
  const pollIntervalMs = opts.provisionPollIntervalMs ?? DEFAULT_PROVISION_POLL_INTERVAL_MS
  const pollTimeoutMs = opts.provisionPollTimeoutMs ?? DEFAULT_PROVISION_POLL_TIMEOUT_MS
  const refreshSkewMs = opts.tokenRefreshSkewMs ?? DEFAULT_TOKEN_REFRESH_SKEW_MS

  const connectionUrl = useCallback(() => {
    if (typeof opts.connectionUrl === 'function') return opts.connectionUrl(opts.workspaceId)
    return opts.connectionUrl ?? `/api/workspaces/${encodeURIComponent(opts.workspaceId)}/sandbox/connection`
  }, [opts.connectionUrl, opts.workspaceId])

  const connect = useCallback(async () => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const isCurrent = () => mountedRef.current && generationRef.current === generation
    const setCurrentConn: typeof setConn = (value) => {
      if (!isCurrent()) return
      setConn(value)
    }

    setCurrentConn((current) => ({ ...current, loading: true, error: null }))
    const deadline = Date.now() + pollTimeoutMs
    while (isCurrent()) {
      try {
        const res = await fetcher(connectionUrl())
        const data = (await res.json()) as SandboxTerminalConnectionResponse
        if (!isCurrent()) return
        const runtimeUrl = data.runtimeUrl ?? data.sidecarUrl
        if (res.ok && runtimeUrl && data.token && data.expiresAt) {
          setCurrentConn({
            runtimeUrl,
            sidecarUrl: data.sidecarUrl ?? runtimeUrl,
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
          setCurrentConn({
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
          setCurrentConn((current) => ({
            ...current,
            loading: true,
            status: data.status ?? 'provisioning',
            error: null,
          }))
          await sleep(pollIntervalMs)
          continue
        }
        setCurrentConn((current) => ({
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
        if (!isCurrent()) return
        if (Date.now() < deadline) {
          await sleep(pollIntervalMs)
          continue
        }
        setCurrentConn((current) => ({
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
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

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

const DEFAULT_TERMINAL_CID_KEY = 'agent-app:terminal-connection-id'

function newConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `cid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/**
 * Stable-per-tab, unique-per-client terminal connection id.
 *
 * Persists in `sessionStorage` so a reload in the same tab reuses the id (the
 * sidecar restores the same PTY session via `TerminalView.connectionId`), while
 * separate tabs/windows each get a distinct id. Pass the result as
 * `TerminalView`'s `connectionId`. Without it (e.g. gtm-agent today) every tab
 * shares one connection id and their reconnects evict each other.
 *
 * Falls back to an ephemeral id when `sessionStorage` is unavailable (SSR,
 * privacy mode) — still unique per call, just not reload-stable.
 */
export function tabTerminalConnectionId(storageKey: string = DEFAULT_TERMINAL_CID_KEY): string {
  try {
    const store = globalThis.sessionStorage
    const existing = store?.getItem(storageKey)
    if (existing) return existing
    const id = newConnectionId()
    store?.setItem(storageKey, id)
    return id
  } catch {
    return newConnectionId()
  }
}
