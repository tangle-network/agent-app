/**
 * Browser adapter for the Sandbox session gateway.
 *
 * The Sandbox SDK owns the WebSocket, reconnect, replay, cursor persistence,
 * event decoding, and raw event delivery. This module only composes that
 * client with a product-owned grant endpoint and app callbacks.
 *
 * Keep this entry separate from `web-react`: `@tangle-network/sandbox` is an
 * optional peer, and the dynamic import keeps it out of apps without a
 * sandbox-backed session.
 */

/** A short-lived, read-only grant for one session's gateway stream. */
export interface SessionStreamGrant {
  /** `wss://…/session`, resolved by the product server. */
  url: string
  /** Read-only JWT. A browser must never receive a Sandbox API key. */
  token: string
  /** Browser-facing session channel selected by the product. */
  sessionId: string
  /** Unix seconds, as expected by the SDK token refresher. */
  expiresAt: number
}

/** Common soft-miss reasons a product grant route may report. */
export type SessionGrantUnavailableReason =
  | 'sandbox-absent'
  | 'sandbox-not-running'
  | 'session-absent'
  | 'gateway-unreachable'
  | 'mint-failed'

/** The grant endpoint response accepted by {@link parseSessionStreamGrant}. */
export type SessionStreamGrantResponse =
  | ({ available: true } & SessionStreamGrant)
  | { available: false; reason?: SessionGrantUnavailableReason }

/** A decoded event delivered by the Sandbox SDK. */
export interface GatewayTurnEvent {
  type: string
  data?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Parse a grant response. Invalid or unavailable responses are soft misses. */
export function parseSessionStreamGrant(body: unknown): SessionStreamGrant | null {
  if (!isRecord(body) || body.available !== true) return null

  const { url, token, sessionId, expiresAt } = body
  if (
    typeof url !== 'string' ||
    !url.trim() ||
    !isWebSocketUrl(url) ||
    typeof token !== 'string' ||
    !token.trim() ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    expiresAt < 0
  ) {
    return null
  }

  return { url, token, sessionId, expiresAt }
}

function isWebSocketUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

/** Options for a product-owned grant fetcher. */
export interface SessionStreamGrantFetcherOptions {
  /** Endpoint URL, or a function that receives the product scope id. */
  url: string | ((scopeId: string) => string)
  scopeId: string
  /** Injectable for tests or a product-specific fetch wrapper. */
  fetchImpl?: typeof fetch
  /** For example, `{ credentials: 'include' }` on a cross-origin endpoint. */
  requestInit?: RequestInit
}

/**
 * Build a grant fetcher that never throws. A grant route is an optional live
 * lane, so auth misses, network failures, and malformed bodies fall back to
 * the product's durable lane.
 */
export function createSessionStreamGrantFetcher(
  options: SessionStreamGrantFetcherOptions,
): (signal: AbortSignal) => Promise<SessionStreamGrant | null> {
  const fetchImpl = options.fetchImpl ?? fetch

  return async (signal) => {
    try {
      const url =
        typeof options.url === 'function'
          ? options.url(options.scopeId)
          : options.url
      const response = await fetchImpl(url, {
        ...options.requestInit,
        signal,
      })
      if (!response.ok) return null
      return parseSessionStreamGrant(await response.json())
    } catch {
      return null
    }
  }
}

/** Minimal structural surface of the SDK session gateway client. */
export interface SessionGatewayClientLike {
  connect(): void
  disconnect(): void
  clearReplayState(): void
}

/** Structural replay storage accepted by the SDK client. */
export interface ReplayCursorStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Subset of the SDK client configuration used by this adapter. */
export interface SessionGatewayClientConfigLike {
  url: string
  token: string
  sessionId: string
  autoReconnect?: boolean
  enableReplayPersistence?: boolean
  replayStorage?: ReplayCursorStorage
  onTokenRefresh?: () => Promise<{ token: string; expiresAt: number }>
  handlers?: {
    onTurnEvent?: (
      event: GatewayTurnEvent,
      channel: string,
      terminal: boolean,
      sequenceId?: number,
    ) => void
    onTokenExpired?: () => void
    onError?: (message: string, code?: string) => void
  }
}

/** Injectable SDK-client constructor, used for tests and alternate transports. */
export type SessionGatewayClientFactory = (
  config: SessionGatewayClientConfigLike,
) => SessionGatewayClientLike | Promise<SessionGatewayClientLike>

/** Callbacks driven by one live gateway attachment. */
export interface SessionGatewayLiveViewHandlers {
  signal: AbortSignal
  /** Every non-duplicate, non-transport event. */
  onEvent: (event: GatewayTurnEvent) => void
  /** Called after the first real turn event, not a gateway notice. */
  onFirstTurnEvent?: () => void
  /** Called for each terminal turn event. */
  onTerminal?: () => void
  /** Called when an attached lane becomes unusable. */
  onUnusable?: (reason: string) => void
}

/** A handle that stops one gateway attachment. */
export interface SessionGatewayLiveViewAttachment {
  close(): void
  /** End the session and discard its SDK replay cursor. */
  end(): void
}

/** Structural connector returned by {@link createSessionGatewayLane}. */
export type SessionGatewayLiveViewConnector = (
  handlers: SessionGatewayLiveViewHandlers,
) => Promise<SessionGatewayLiveViewAttachment | null>

/** Options for {@link createSessionGatewayLane}. */
export interface SessionGatewayLaneOptions {
  /** Mint a grant. `null` is a soft miss with no attachable live stream. */
  fetchGrant(signal: AbortSignal): Promise<SessionStreamGrant | null>
  /** Replay cursor storage. Defaults to `window.localStorage`; `null` disables it. */
  replayStorage?: ReplayCursorStorage | null
  /** Override the SDK client constructor for tests or another compatible client. */
  createClient?: SessionGatewayClientFactory
}

async function defaultCreateClient(
  config: SessionGatewayClientConfigLike,
): Promise<SessionGatewayClientLike> {
  // Keep the optional Sandbox peer out of consumers that do not use this
  // subpath, and out of SSR evaluation.
  const module = (await import('@tangle-network/sandbox/session-gateway')) as unknown as {
    SessionGatewayClient: new (config: SessionGatewayClientConfigLike) => SessionGatewayClientLike
  }
  return new module.SessionGatewayClient(config)
}

function defaultReplayStorage(): ReplayCursorStorage | undefined {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a browser-direct Sandbox live-view connector.
 *
 * The caller supplies a product-authenticated grant fetcher and owns the
 * transcript reducer. A missing grant returns `null`, allowing a durable
 * replay lane to take over without changing the turn.
 */
export function createSessionGatewayLane(
  options: SessionGatewayLaneOptions,
): SessionGatewayLiveViewConnector {
  const createClient = options.createClient ?? defaultCreateClient

  return async (handlers) => {
    let grant: SessionStreamGrant | null
    try {
      grant = await options.fetchGrant(handlers.signal)
    } catch {
      return null
    }
    if (!grant || handlers.signal.aborted) return null

    let firstTurnEventSent = false
    let closed = false
    let ended = false
    let client: SessionGatewayClientLike

    const replayStorage =
      options.replayStorage === null
        ? undefined
        : (options.replayStorage ?? defaultReplayStorage())

    const config: SessionGatewayClientConfigLike = {
      url: grant.url,
      token: grant.token,
      sessionId: grant.sessionId,
      autoReconnect: true,
      ...(replayStorage
        ? { enableReplayPersistence: true, replayStorage }
        : {}),
      onTokenRefresh: async () => {
        const refreshed = await options.fetchGrant(handlers.signal)
        if (!refreshed) throw new Error('stream token refresh unavailable')
        return { token: refreshed.token, expiresAt: refreshed.expiresAt }
      },
      handlers: {
        onTurnEvent: (event, _channel, terminal, _sequenceId) => {
          if (closed) return

          if (!firstTurnEventSent) {
            firstTurnEventSent = true
            handlers.onFirstTurnEvent?.()
          }
          handlers.onEvent(event)
          if (terminal) handlers.onTerminal?.()
        },
        onTokenExpired: () => {
          if (!closed) handlers.onUnusable?.('token expired')
        },
        onError: (message, code) => {
          if (!closed) handlers.onUnusable?.(code ? `${code}: ${message}` : message)
        },
      },
    }

    try {
      client = await createClient(config)
    } catch {
      return null
    }
    if (handlers.signal.aborted) {
      client.disconnect()
      return null
    }

    try {
      client.connect()
    } catch {
      client.disconnect()
      return null
    }

    return {
      close: () => {
        if (closed) return
        closed = true
        client.disconnect()
      },
      end: () => {
        if (ended) return
        ended = true
        client.clearReplayState()
        if (!closed) {
          closed = true
          client.disconnect()
        }
      },
    }
  }
}
