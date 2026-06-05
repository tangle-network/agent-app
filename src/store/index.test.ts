import { describe, expect, it } from 'vitest'
import { createDatabaseProvider } from './index'

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
