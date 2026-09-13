import { describe, expect, it } from 'vitest'
import { createBrokerTokenProvider, type BrokerToken, type BrokerTokenMinter } from '../src/tangle/index'

// Broker tokens authorize one execution, not all requests within their TTL.
// In-flight promise sharing would give competing executions the same bearer.
describe('createBrokerTokenProvider concurrency', () => {
  it('gives concurrent executions separate tokens, including out-of-order mints', async () => {
    const pending: Array<(token: BrokerToken) => void> = []
    const minter: BrokerTokenMinter = {
      mintBrokerToken: () => new Promise<BrokerToken>((resolve) => { pending.push(resolve) }),
    }
    const provider = createBrokerTokenProvider({
      client: minter, clientId: 'app', clientSecret: 'test-only', grantId: 'grant',
    })
    const first = provider.getToken()
    const second = provider.getToken()
    expect(pending).toHaveLength(2)
    pending[1]!({ accessToken: 'second', expiresIn: 120, scope: 'gmail.read' })
    pending[0]!({ accessToken: 'first', expiresIn: 120, scope: 'gmail.read' })
    const issued = await Promise.all([first, second])
    const consumed = new Set<string>()
    for (const token of issued) {
      expect(consumed.has(token)).toBe(false)
      consumed.add(token)
    }
    expect(issued).toEqual(['first', 'second'])
  })
})
