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
 *   3. {@link createBrokerTokenProvider} — the runtime path: each request mints
 *      a fresh single-use broker token from the durable grant using only app
 *      credentials (no user session). Neither tokens nor in-flight mint
 *      promises may be shared between execution attempts.
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
  /** @deprecated Retained for source compatibility. Single-use tokens are
   *  never cached, so refresh skew is ignored. */
  refreshSkewMs?: number
  /** @deprecated Retained for source compatibility; no local expiry cache. */
  now?: () => number
}

/** Mint a separate single-use bearer for each execution attempt. */
export interface BrokerTokenProvider {
  /** Mint a fresh bearer for exactly one Hub execution; never cache or share it. */
  getToken(): Promise<string>
  /** Compatibility no-op: no bearer is cached. Does not revoke Hub grants or
   *  already-issued tokens; revocation belongs to the authoritative Hub. */
  invalidate(): void
}

/**
 * Mint a fresh broker token for every call, including concurrent calls.
 * A broker bearer is consumed by one Hub execution even when its TTL has not
 * expired. Cache the durable grant, never the bearer or an in-flight mint.
 * Mint failures propagate; this helper never retries an external action.
 */
export function createBrokerTokenProvider(opts: BrokerTokenProviderOptions): BrokerTokenProvider {
  return {
    async getToken() {
      const token = await opts.client.mintBrokerToken({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        grantId: opts.grantId,
        ttlSeconds: opts.ttlSeconds,
      })
      return token.accessToken
    },
    invalidate() {
      // No cached bearer to clear. Keep this method for existing callers.
    },
  }
}
