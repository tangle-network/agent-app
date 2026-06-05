import { describe, expect, it } from 'vitest'
import { createDatabaseProvider, createInMemoryKV } from './index'

describe('createDatabaseProvider', () => {
  it('throws a custom message until a database is injected, then forwards', () => {
    const provider = createDatabaseProvider<{ ping(): string }>({ notReadyMessage: 'D1 not initialized.' })
    expect(provider.isReady()).toBe(false)
    expect(() => provider.db.ping()).toThrow('D1 not initialized.')

    provider.setDatabase({ ping: () => 'pong' })
    expect(provider.isReady()).toBe(true)
    expect(provider.db.ping()).toBe('pong')
  })

  it('binds methods so `this` resolves through the proxy (drizzle/class stores)', () => {
    class Store {
      private rows = ['a', 'b']
      list() {
        return this.rows
      }
    }
    const provider = createDatabaseProvider<Store>()
    provider.setDatabase(new Store())
    expect(provider.db.list()).toEqual(['a', 'b'])
  })

  it('is hot-swappable — a new driver replaces the old one with no re-import', () => {
    const provider = createDatabaseProvider<{ name(): string }>()
    provider.setDatabase({ name: () => 'd1' })
    expect(provider.db.name()).toBe('d1')
    // Swap the adapter (e.g. D1 → sqlite → turso) — same `db` reference.
    provider.setDatabase({ name: () => 'sqlite' })
    expect(provider.db.name()).toBe('sqlite')
  })

  it('reset() makes the next access throw again', () => {
    const provider = createDatabaseProvider<{ v: number }>()
    provider.setDatabase({ v: 1 })
    expect(provider.db.v).toBe(1)
    provider.reset()
    expect(provider.isReady()).toBe(false)
    expect(() => provider.db.v).toThrow()
  })
})

describe('createInMemoryKV (portable vault backend)', () => {
  it('get/put/delete round-trip', async () => {
    const kv = createInMemoryKV()
    expect(await kv.get('vault:w:brief.md')).toBeNull()
    await kv.put('vault:w:brief.md', '# Brief')
    expect(await kv.get('vault:w:brief.md')).toBe('# Brief')
    await kv.delete('vault:w:brief.md')
    expect(await kv.get('vault:w:brief.md')).toBeNull()
  })

  it('list filters by prefix, returns names, and completes in one page', async () => {
    const kv = createInMemoryKV({
      'vault:w1:a.md': 'a',
      'vault:w1:dir/b.md': 'b',
      'vault:w2:c.md': 'c',
    })
    const res = await kv.list({ prefix: 'vault:w1:' })
    expect(res.list_complete).toBe(true)
    expect(res.keys.map((k) => k.name)).toEqual(['vault:w1:a.md', 'vault:w1:dir/b.md'])
  })

  it('seeds from initial entries', async () => {
    const kv = createInMemoryKV({ 'k': 'v' })
    expect(await kv.get('k')).toBe('v')
  })
})

describe('createInMemoryKV — metadata surface', () => {
  it('put with metadata + getWithMetadata round-trips value and metadata', async () => {
    const kv = createInMemoryKV()
    await kv.put('vault:w:secret.md', 'cipher', { metadata: { encrypted: true, hasPII: true } })
    expect(await kv.get('vault:w:secret.md')).toBe('cipher')
    const res = await kv.getWithMetadata('vault:w:secret.md')
    expect(res.value).toBe('cipher')
    expect(res.metadata).toEqual({ encrypted: true, hasPII: true })
  })

  it('getWithMetadata on a missing key returns null/null', async () => {
    const kv = createInMemoryKV()
    expect(await kv.getWithMetadata('nope')).toEqual({ value: null, metadata: null })
  })
})
