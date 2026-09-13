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

/** Each mint creates a distinct bearer, as the Hub issuer does. */
function fakeMinter(): { minter: BrokerTokenMinter; mints: number } {
  let mints = 0
  return {
    minter: {
      async mintBrokerToken() {
        mints++
        return { accessToken: `sk-tan-broker-${mints}`, expiresIn: 3600, scope: 'gmail.read' }
      },
    },
    get mints() { return mints },
  }
}

function provider(client: BrokerTokenMinter) {
  return createBrokerTokenProvider({ client, clientId: 'c', clientSecret: 's', grantId: 'g' })
}

describe('createBrokerTokenProvider', () => {
  it('mints a new bearer for successive calls even within the TTL', async () => {
    const f = fakeMinter()
    const p = provider(f.minter)
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    expect(await p.getToken()).toBe('sk-tan-broker-2')
    expect(f.mints).toBe(2)
  })

  it('does not share an in-flight mint between concurrent callers', async () => {
    const pending: Array<(token: BrokerToken) => void> = []
    const p = provider({
      mintBrokerToken: () => new Promise<BrokerToken>((resolve) => { pending.push(resolve) }),
    })
    const a = p.getToken()
    const b = p.getToken()
    expect(pending).toHaveLength(2)
    // Independent operations may resolve in either order.
    pending[1]!({ accessToken: 'token-b', expiresIn: 3600, scope: '' })
    pending[0]!({ accessToken: 'token-a', expiresIn: 3600, scope: '' })
    expect(await a).toBe('token-a')
    expect(await b).toBe('token-b')
  })

  it('supports a burst without reusing a consumed bearer', async () => {
    const f = fakeMinter()
    const p = provider(f.minter)
    const tokens = await Promise.all(Array.from({ length: 8 }, () => p.getToken()))
    const consumed = new Set<string>()
    for (const token of tokens) {
      // A second execution with the same token is a replay, not a cache hit.
      expect(consumed.has(token)).toBe(false)
      consumed.add(token)
    }
    expect(f.mints).toBe(8)
  })

  it('legacy clock and skew options do not enable caching', async () => {
    const f = fakeMinter()
    const p = createBrokerTokenProvider({
      client: f.minter, clientId: 'c', clientSecret: 's', grantId: 'g',
      now: () => 0, refreshSkewMs: 0,
    })
    expect(await p.getToken()).not.toBe(await p.getToken())
    expect(f.mints).toBe(2)
  })

  it('propagates a failed mint without retrying it or poisoning later calls', async () => {
    let attempts = 0
    const p = provider({
      async mintBrokerToken() {
        if (++attempts === 1) throw new Error('issuer unavailable')
        return { accessToken: 'fresh', expiresIn: 3600, scope: '' }
      },
    })
    await expect(p.getToken()).rejects.toThrow('issuer unavailable')
    expect(attempts).toBe(1)
    expect(await p.getToken()).toBe('fresh')
  })

  it('forwards the exact grant and requested TTL for each mint', async () => {
    const calls: Array<Parameters<BrokerTokenMinter['mintBrokerToken']>[0]> = []
    const p = createBrokerTokenProvider({
      client: {
        async mintBrokerToken(input) {
          calls.push(input)
          return { accessToken: `token-${calls.length}`, expiresIn: 60, scope: '' }
        },
      },
      clientId: 'c', clientSecret: 's', grantId: 'g', ttlSeconds: 60,
    })
    await p.getToken()
    await p.getToken()
    expect(calls).toEqual([
      { clientId: 'c', clientSecret: 's', grantId: 'g', ttlSeconds: 60 },
      { clientId: 'c', clientSecret: 's', grantId: 'g', ttlSeconds: 60 },
    ])
  })

  it('retains invalidate as a compatibility no-op without minting', async () => {
    const f = fakeMinter()
    const p = provider(f.minter)
    p.invalidate()
    expect(f.mints).toBe(0)
    expect(await p.getToken()).toBe('sk-tan-broker-1')
    p.invalidate()
    expect(await p.getToken()).toBe('sk-tan-broker-2')
    expect(f.mints).toBe(2)
  })
})
