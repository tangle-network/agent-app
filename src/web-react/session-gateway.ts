/**
 * The sandbox session gateway as a `LiveLaneConnector` — the default live lane
 * for `followTurn` (`./turn-recovery`).
 *
 * This is a SEPARATE subpath (`@tangle-network/agent-app/web-react/session-gateway`)
 * on purpose. It is the only browser module that names `@tangle-network/sandbox`,
 * an OPTIONAL peer, and it reaches it through a dynamic `import()` so the SDK is
 * never in a consumer's initial bundle and never evaluated during SSR. Keeping
 * it out of the main `web-react` entry means a product with no sandbox session
 * (legal, tax) never has a specifier its bundler must resolve.
 *
 * Two facts here are regression scars, not style — see the comments below:
 *   • `onAgentEvent(channel, data, seq)` — `channel` is the pub/sub ROUTING
 *     ADDRESS, never the event type.
 *   • the applied-seq dedupe is a Set, not a high-water mark.
 *
 * What this module does NOT do is translate the gateway's vocabulary into the
 * producer's. The gateway forwards RAW sandbox frames; the durable lane carries
 * events `createSandboxChatProducer` already flattened server-side. Re-deriving
 * that mapping in the browser would fork an engine primitive (invariant 6) and
 * would land while the 2.000x inflation defect at that exact boundary is still
 * unlocated (#254). Frame ENVELOPE decoding is in scope; transcript SEMANTICS
 * are the product's.
 */

import type { LiveLaneAttachment, LiveLaneConnector } from './turn-recovery'

/** A short-lived, read-only grant for one session's gateway stream. */
export interface SessionStreamGrant {
  /** `wss://…/session` — the product resolves this server-side. */
  url: string
  /** Read-only JWT. A browser must never see a sandbox API key. */
  token: string
  sessionId: string
  /** Unix SECONDS — the shape the SDK's refresher expects. */
  expiresAt: number
}

/**
 * Why a viewer cannot attach right now. Every one is a SOFT miss served at HTTP
 * 200: the client falls back to the durable lane and the turn is unaffected.
 */
export type SessionGrantUnavailableReason =
  | 'sandbox-absent'
  | 'sandbox-not-running'
  | 'session-absent'
  | 'gateway-unreachable'
  | 'mint-failed'

/** The grant endpoint's response body. */
export type SessionStreamGrantResponse =
  | ({ available: true } & SessionStreamGrant)
  | { available: false; reason: SessionGrantUnavailableReason }

/** A decoded gateway frame. `data` is passed through verbatim. */
export interface GatewayTurnEvent {
  type: string
  data?: Record<string, unknown>
}

/** Frames that mean this turn is over. */
export const GATEWAY_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'done',
  'error',
  'result',
  'session.run.completed',
  'session.run.failed',
])

/** Frames that prove the SOCKET is alive but say nothing about the TURN. */
export const GATEWAY_TRANSPORT_NOTICE_TYPES: ReadonlySet<string> = new Set([
  'connection.established',
  'heartbeat',
  'ping',
  'pong',
])

/** Report whether a decoded gateway event type terminates the turn */
export function isTerminalGatewayEvent(type: string): boolean {
  return GATEWAY_TERMINAL_EVENT_TYPES.has(type)
}

/** Report whether a decoded gateway event type is transport noise, not turn feedback */
export function isGatewayTransportNotice(type: string): boolean {
  return GATEWAY_TRANSPORT_NOTICE_TYPES.has(type)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Decode one gateway frame into `{type, data}`, or `null` if it carries nothing.
 *
 * Three shapes reach a viewer and they are not interchangeable:
 *   1. session-MESSAGE lane — `{type, properties: {part, delta}}`; the payload
 *      is under `properties`.
 *   2. run/stream replay — `{type: 'message.part.updated', part, delta}` and
 *      `{type: 'token', value}`; the payload is inline, with no wrapper.
 *   3. the TERMINAL frame — carries NO `type` at all, because the orchestrator's
 *      `broadcast()` clobbers the channel the SSE bridge set. `outcome` is the
 *      only reliable marker, so it is re-typed as `done`.
 *
 * Getting (3) wrong leaves a turn that never terminates; getting (1)/(2) wrong
 * renders a blank transcript.
 */
export function gatewayFrameToTurnEvent(raw: unknown): GatewayTurnEvent | null {
  if (!isRecord(raw)) return null

  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (type) {
    const { type: _dropped, properties, ...rest } = raw
    return { type, data: isRecord(properties) ? properties : rest }
  }

  if (isRecord(raw.outcome) || typeof raw.outcome === 'string') {
    return { type: 'done', data: raw }
  }
  return null
}

/** Parse the grant endpoint body. Any negative or malformed shape → `null`. */
export function parseSessionStreamGrant(body: unknown): SessionStreamGrant | null {
  if (!isRecord(body)) return null
  if (body.available !== true) return null
  const { url, token, sessionId, expiresAt } = body
  if (typeof url !== 'string' || !url) return null
  if (typeof token !== 'string' || !token) return null
  if (typeof sessionId !== 'string' || !sessionId) return null
  return { url, token, sessionId, expiresAt: typeof expiresAt === 'number' ? expiresAt : 0 }
}

/** Fetch a grant from the product's mint endpoint. */
export interface SessionStreamGrantFetcherOptions {
  /** The product's endpoint. A function receives the scope id (thread/session). */
  url: string | ((scopeId: string) => string)
  scopeId: string
  fetchImpl?: typeof fetch
  /** e.g. `{ credentials: 'include' }` for a cross-origin API host. */
  requestInit?: RequestInit
}

/**
 * Build a grant fetcher that NEVER throws: network failure, a non-2xx, an
 * `available:false` body and a malformed payload all resolve `null`. A viewer
 * that cannot attach must fall back silently, not fail the turn.
 */
export function createSessionStreamGrantFetcher(
  options: SessionStreamGrantFetcherOptions,
): (signal: AbortSignal) => Promise<SessionStreamGrant | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (signal) => {
    try {
      const url =
        typeof options.url === 'function' ? options.url(options.scopeId) : options.url
      const response = await fetchImpl(url, { ...options.requestInit, signal })
      if (!response.ok) return null
      return parseSessionStreamGrant(await response.json())
    } catch {
      return null
    }
  }
}

/**
 * Structural mirror of the SDK's `SessionGatewayClient`. Declared locally so
 * this module imports NO SDK types — the fleet spans several sandbox versions
 * (0.9.x → 0.12.x) and a type import would make agent-app's build hostage to
 * whichever one a consumer installed.
 */
export interface SessionGatewayClientLike {
  connect(): void
  disconnect(): void
  replay(since: number): void
  clearReplayState(): void
  updateToken(token: string): void
}

/** The subset of the SDK client's config this lane sets. */
export interface SessionGatewayClientConfigLike {
  url: string
  token: string
  sessionId: string
  autoReconnect?: boolean
  enableReplayPersistence?: boolean
  replayStorage?: ReplayCursorStorage
  onTokenRefresh?: () => Promise<{ token: string; expiresAt: number }>
  handlers?: {
    onAgentEvent?: (channel: string, data: unknown, sequenceId?: number) => void
    onBackpressureWarning?: (dropped: number, since: number, totalDropped?: number) => void
    onTokenExpired?: () => void
    onError?: (message: string, code?: string) => void
  }
}

/** Structurally the SDK's `ReplayStateStorage`; `window.localStorage` satisfies it. */
export interface ReplayCursorStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Construct the gateway client. Injected in tests; defaults to the real SDK. */
export type SessionGatewayClientFactory = (
  config: SessionGatewayClientConfigLike,
) => SessionGatewayClientLike | Promise<SessionGatewayClientLike>

/** Memory floor on the applied-seq set — a cap, not a policy. */
export const APPLIED_SEQ_CAP = 100_000

/** Configure the session-gateway live lane. */
export interface SessionGatewayLaneOptions {
  /** Mint a grant. `null` is a soft miss — no sandbox, no session, no gateway. */
  fetchGrant(signal: AbortSignal): Promise<SessionStreamGrant | null>
  /** Replay-cursor persistence so a reload inside the buffer window refills
   *  from the gateway. Defaults to `window.localStorage`; `null` disables. */
  replayStorage?: ReplayCursorStorage | null
  /** Override the client constructor (tests, or a non-SDK transport). */
  createClient?: SessionGatewayClientFactory
  appliedSeqCap?: number
}

async function defaultCreateClient(
  config: SessionGatewayClientConfigLike,
): Promise<SessionGatewayClientLike> {
  // DYNAMIC on purpose. A static import would force every consumer's bundler to
  // resolve an OPTIONAL peer, breaking products that never install the SDK.
  const mod = (await import('@tangle-network/sandbox/session-gateway')) as unknown as {
    SessionGatewayClient: new (c: SessionGatewayClientConfigLike) => SessionGatewayClientLike
  }
  return new mod.SessionGatewayClient(config)
}

function defaultReplayStorage(): ReplayCursorStorage | undefined {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : undefined
  } catch {
    return undefined // storage can throw in a partitioned/blocked context
  }
}

/**
 * Build the session-gateway `LiveLaneConnector`.
 *
 * Pass the result as `followTurn`'s `attachLive`. It resolves `null` whenever
 * the lane is not attachable, which the follower treats as a soft miss and
 * falls through to the durable replay lane.
 */
export function createSessionGatewayLane(
  options: SessionGatewayLaneOptions,
): LiveLaneConnector {
  const cap = options.appliedSeqCap ?? APPLIED_SEQ_CAP
  const createClient = options.createClient ?? defaultCreateClient

  return async (handlers): Promise<LiveLaneAttachment | null> => {
    const grant = await options.fetchGrant(handlers.signal)
    if (!grant || handlers.signal.aborted) return null

    const appliedSeqs = new Set<number>()
    let firstTurnEventSent = false
    let client: SessionGatewayClientLike | null = null

    const replayStorage =
      options.replayStorage === null
        ? undefined
        : (options.replayStorage ?? defaultReplayStorage())

    const config: SessionGatewayClientConfigLike = {
      url: grant.url,
      token: grant.token,
      sessionId: grant.sessionId,
      autoReconnect: true,
      ...(replayStorage ? { enableReplayPersistence: true, replayStorage } : {}),
      onTokenRefresh: async () => {
        // A turn can outrun the 15-minute token ceiling. Re-mint through the
        // same product endpoint; rejecting lets the SDK surface the expiry.
        const refreshed = await options.fetchGrant(handlers.signal)
        if (!refreshed) throw new Error('stream token refresh unavailable')
        client?.updateToken(refreshed.token)
        return { token: refreshed.token, expiresAt: refreshed.expiresAt }
      },
      handlers: {
        onAgentEvent: (_channel, data, sequenceId) => {
          // `_channel` is the routing address (`session:<id>`), NEVER the event
          // type. Reading it as the type renders a blank transcript.
          if (typeof sequenceId === 'number') {
            if (appliedSeqs.has(sequenceId)) return
            if (appliedSeqs.size < cap) appliedSeqs.add(sequenceId)
          }
          const event = gatewayFrameToTurnEvent(data)
          if (!event) return
          if (isGatewayTransportNotice(event.type)) return
          // Only AFTER the notice filter — otherwise a heartbeat counts as proof
          // the lane delivers and the silence guard never trips on a turn whose
          // driver publishes nothing.
          if (!firstTurnEventSent) {
            firstTurnEventSent = true
            handlers.onFirstTurnEvent()
          }
          handlers.onEvent(event)
          if (isTerminalGatewayEvent(event.type)) handlers.onTerminal()
        },
        onBackpressureWarning: (_dropped, since) => {
          // Ask the gateway to refill the hole it just told us about.
          client?.replay(since)
        },
        onTokenExpired: () => handlers.onUnusable('token expired'),
        onError: (message, code) =>
          handlers.onUnusable(code ? `${code}: ${message}` : message),
      },
    }

    client = await createClient(config)
    if (handlers.signal.aborted) {
      client.disconnect()
      return null
    }
    client.connect()

    return {
      close: () => {
        appliedSeqs.clear()
        // The dedupe set is rebuilt from scratch on the next attach, so a stale
        // persisted cursor would replay against an empty set.
        client?.clearReplayState()
        client?.disconnect()
      },
    }
  }
}
