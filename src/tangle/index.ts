/**
 * Tangle login + the developer self-service app-registration → broker-token
 * flow, for apps built on agent-app.
 *
 * The platform (agent-dev-container integration hub) lets a developer register
 * their client app and obtain a `sk-tan-broker-` bearer to call `/v1/hub/exec`
 * on a user's connected integrations — WITHOUT being a hard-coded "trusted app".
 * The wire client (`TangleAppsClient` — registerApp / exchangeAuthCode /
 * mintBrokerToken) lives in `@tangle-network/agent-integrations`; this module is
 * the app-shell layer on top, and is intentionally **structural**: it depends on
 * the minter CONTRACT, not the concrete client, so it installs without the
 * agent-integrations publish and is trivially testable. A consumer constructs
 * the real client and passes it in.
 *
 *   1. {@link buildConsentUrl} — send the user through the ONE-TIME consent
 *      (their Tangle session authorizes the app for a connection + scopes).
 *   2. On the callback, the consumer's client `exchangeAuthCode`s the `agc_`
 *      code into the first broker token + a durable grant.
 *   3. {@link createBrokerTokenProvider} — the runtime path: a cached provider
 *      that re-mints a fresh single-use broker token per `/v1/hub/exec` from the
 *      durable grant using only the app credentials (no user session). Caches
 *      until just before expiry so a burst of hub calls shares one mint.
 */

/** A single-use hub bearer minted from a durable grant — mirrors
 *  `@tangle-network/agent-integrations`'s `BrokerToken`. */
export interface BrokerToken {
  /** The `sk-tan-broker-…` bearer for a single `/v1/hub/exec` call. */
  accessToken: string
  /** Seconds until expiry. */
  expiresIn: number
  scope: string
  connectionId?: string
}

/** The one method the provider needs — `TangleAppsClient` satisfies it
 *  structurally, so `createBrokerTokenProvider({ client: tangleAppsClient, … })`
 *  type-checks without importing the concrete class. */
export interface BrokerTokenMinter {
  mintBrokerToken(input: { clientId: string; clientSecret: string; grantId: string; ttlSeconds?: number }): Promise<BrokerToken>
}

/** Define input parameters required to generate a consent URL for OAuth authorization */
export interface ConsentUrlInput {
  /** Platform base URL (e.g. https://id.tangle.tools). */
  endpoint: string
  clientId: string
  /** Must match one of the app's registered redirect URIs. */
  redirectUri: string
  /** Scopes the app is requesting for this connection (e.g. ['gmail.read']). */
  scopes: string[]
  /** Opaque CSRF/state value the callback echoes back — verify it on return. */
  state: string
  /** Optionally pre-select a specific connection to authorize. */
  connectionId?: string
}

/**
 * Build the URL to send the user to for the one-time app-consent. The user's
 * Tangle session (not the app's credentials) authorizes it; on approval the
 * platform redirects to `redirectUri?code=agc_…&state=…`.
 */
export function buildConsentUrl(input: ConsentUrlInput): string {
  const base = input.endpoint.replace(/\/+$/, '')
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
    response_type: 'code',
  })
  if (input.connectionId) params.set('connection_id', input.connectionId)
  return `${base}/cross-site/app-consent?${params.toString()}`
}

/** Define options for configuring a broker token provider including client credentials and token management settings */
export interface BrokerTokenProviderOptions {
  client: BrokerTokenMinter
  clientId: string
  clientSecret: string
  /** The durable grant id from the consent exchange. */
  grantId: string
  /** Requested token TTL (seconds). */
  ttlSeconds?: number
  /** Re-mint this many ms BEFORE expiry so an in-flight call never uses a
   *  just-expired token. Default 30s. */
  refreshSkewMs?: number
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number
}

/** Provide and refresh broker bearer tokens, allowing forced token invalidation */
export interface BrokerTokenProvider {
  /** A valid `sk-tan-broker-` bearer, minting/refreshing as needed. */
  getToken(): Promise<string>
  /** Force the next `getToken` to re-mint (e.g. after a 401 from the hub). */
  invalidate(): void
}

/**
 * Cache + auto-refresh a broker token for one grant. A burst of hub calls
 * shares a single mint; the token is re-minted once it's within `refreshSkewMs`
 * of expiry, or on demand via {@link BrokerTokenProvider.invalidate}.
 * Concurrent `getToken` calls during a mint share the same in-flight promise
 * (no thundering herd).
 */
export function createBrokerTokenProvider(opts: BrokerTokenProviderOptions): BrokerTokenProvider {
  const now = opts.now ?? (() => Date.now())
  const skew = opts.refreshSkewMs ?? 30_000
  let cached: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string> | null = null

  async function mint(): Promise<string> {
    const t = await opts.client.mintBrokerToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      grantId: opts.grantId,
      ttlSeconds: opts.ttlSeconds,
    })
    cached = { token: t.accessToken, expiresAt: now() + t.expiresIn * 1000 }
    return t.accessToken
  }

  return {
    async getToken() {
      if (cached && now() < cached.expiresAt - skew) return cached.token
      if (inflight) return inflight
      inflight = mint().finally(() => {
        inflight = null
      })
      return inflight
    },
    invalidate() {
      cached = null
    },
  }
}
