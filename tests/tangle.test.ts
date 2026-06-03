import { describe, it, expect } from 'vitest'
import { buildConsentUrl, createBrokerTokenProvider, type BrokerToken, type BrokerTokenMinter } from '../src/tangle/index'

describe('buildConsentUrl', () => {
  it('builds the app-consent URL with scopes joined + state echoed', () => {
    const url = new URL(buildConsentUrl({
      endpoint: 'https://id.tangle.tools/',
      clientId: 'app_123',
      redirectUri: 'https://my.app/callback',
      scopes: ['gmail.read', 'calendar.write'],
      state: 'xyz',
    }))
    expect(url.origin + url.pathname).toBe('https://id.tangle.tools/cross-site/app-consent')
    expect(url.searchParams.get('client_id')).toBe('app_123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://my.app/callback')
    expect(url.searchParams.get('scope')).toBe('gmail.read calendar.write')
    expect(url.searchParams.get('state')).toBe('xyz')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('connection_id')).toBeNull()
  })

  it('includes connection_id when pre-selecting a connection', () => {
    const url = new URL(buildConsentUrl({ endpoint: 'https://id.tangle.tools', clientId: 'a', redirectUri: 'https://x', scopes: [], state: 's', connectionId: 'conn_1' }))
    expect(url.searchParams.get('connection_id')).toBe('conn_1')
  })
})

/** A fake minter recording calls + a controllable token, so the provider's
 *  caching/refresh is tested without the network. */
function fakeMinter(token: Partial<BrokerToken> = {}): { minter: BrokerTokenMinter; mints: number } {
  let mints = 0
  const minter: BrokerTokenMinter = {
    async mintBrokerToken() {
      mints++
      return { accessToken: `sk-tan-broker-${mints}`, expiresIn: 3600, scope: 'gmail.read', ...token }
    },
  }
  return {
    minter,
    get mints() {
      return mints
    },
  }
}

describe('createBrokerTokenProvider', () => {
  it('mints once and caches across calls within the TTL', async () => {
    let t = 1_000_000
    const f = fakeMinter()
    const p = createBrokerTokenProvider({ client: f.minter, clientId: 'c', clientSecret: 's', grantId: 'g', now: () => t })
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    expect(f.mints).toBe(1)
  })

  it('re-mints once inside the refresh-skew window before expiry', async () => {
    let t = 1_000_000
    const f = fakeMinter({ expiresIn: 100 }) // expires at +100s
    const p = createBrokerTokenProvider({ client: f.minter, clientId: 'c', clientSecret: 's', grantId: 'g', refreshSkewMs: 30_000, now: () => t })
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    t += 60_000 // 60s in: still >30s skew before the 100s expiry → cached
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    expect(f.mints).toBe(1)
    t += 20_000 // 80s in: within 30s of expiry → re-mint
    expect(await p.getToken()).toBe('sk-tan-broker-2')
    expect(f.mints).toBe(2)
  })

  it('shares one in-flight mint across concurrent getToken calls (no thundering herd)', async () => {
    let resolveMint!: (v: BrokerToken) => void
    let mints = 0
    const minter: BrokerTokenMinter = {
      mintBrokerToken() {
        mints++
        return new Promise<BrokerToken>((res) => { resolveMint = res })
      },
    }
    const p = createBrokerTokenProvider({ client: minter, clientId: 'c', clientSecret: 's', grantId: 'g' })
    const a = p.getToken()
    const b = p.getToken()
    resolveMint({ accessToken: 'sk-tan-broker-x', expiresIn: 3600, scope: '' })
    expect(await a).toBe('sk-tan-broker-x')
    expect(await b).toBe('sk-tan-broker-x')
    expect(mints).toBe(1)
  })

  it('invalidate() forces a fresh mint on the next call', async () => {
    let t = 1_000_000
    const f = fakeMinter()
    const p = createBrokerTokenProvider({ client: f.minter, clientId: 'c', clientSecret: 's', grantId: 'g', now: () => t })
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    p.invalidate()
    expect(await p.getToken()).toBe('sk-tan-broker-2')
    expect(f.mints).toBe(2)
  })
})
