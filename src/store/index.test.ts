import { describe, expect, it, vi } from 'vitest'
import {
  createDatabaseProvider,
  createInMemoryKV,
  runAtomicSqliteStatements,
  runSqliteStatements,
} from './index'

describe('runSqliteStatements', () => {
  it('uses one driver batch when the database supports it', async () => {
    const statements = [{ id: 1 }, { id: 2 }] as [unknown, ...unknown[]]
    const batch = vi.fn(async () => ['first', 'second'])

    await expect(runSqliteStatements({ batch }, statements)).resolves.toEqual([
      'first',
      'second',
    ])
    expect(batch).toHaveBeenCalledOnce()
    expect(batch).toHaveBeenCalledWith(statements)
  })

  it('awaits statements in order when a portable driver has no batch method', async () => {
    const order: number[] = []
    const statement = (value: number) => ({
      then(resolve: (result: number) => void) {
        order.push(value)
        resolve(value)
      },
    })

    await expect(
      runSqliteStatements({}, [statement(1), statement(2)]),
    ).resolves.toEqual([1, 2])
    expect(order).toEqual([1, 2])
  })
})

describe('runAtomicSqliteStatements', () => {
  it('uses the driver batch and does not issue raw transaction commands', async () => {
    const statements = [{ id: 1 }, { id: 2 }] as [unknown, ...unknown[]]
    const batch = vi.fn(async () => ['first', 'second'])
    const exec = vi.fn()

    await expect(runAtomicSqliteStatements({ batch, exec }, statements)).resolves.toEqual([
      'first',
      'second',
    ])
    expect(batch).toHaveBeenCalledOnce()
    expect(batch).toHaveBeenCalledWith(statements)
    expect(exec).not.toHaveBeenCalled()
  })

  it('fails closed before awaiting a statement when no atomic capability exists', async () => {
    let awaited = false
    const statement = {
      then(resolve: (value: string) => void) {
        awaited = true
        resolve('should not run')
      },
    }

    await expect(runAtomicSqliteStatements({}, [statement])).rejects.toThrow(
      'neither batch() nor exec()',
    )
    expect(awaited).toBe(false)
  })

  it('wraps sequential statements in BEGIN IMMEDIATE and COMMIT', async () => {
    const commands: string[] = []
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
    })
    const order: number[] = []
    const statement = (value: number) => ({
      then(resolve: (result: number) => void) {
        order.push(value)
        resolve(value)
      },
    })

    await expect(runAtomicSqliteStatements({ exec }, [statement(1), statement(2)])).resolves.toEqual([1, 2])
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    expect(order).toEqual([1, 2])
  })

  it('rolls back when a statement rejects and preserves the original failure', async () => {
    const commands: string[] = []
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
    })
    const failure = new Error('statement failed')

    await expect(
      runAtomicSqliteStatements({ exec }, [Promise.resolve('first'), Promise.reject(failure)]),
    ).rejects.toBe(failure)
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })

  it('rolls back when COMMIT rejects', async () => {
    const commands: string[] = []
    const commitFailure = new Error('commit failed')
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
      if (command === 'COMMIT') throw commitFailure
    })

    await expect(runAtomicSqliteStatements({ exec }, [Promise.resolve('done')])).rejects.toBe(commitFailure)
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'])
  })

  it('aggregates a rollback failure without discarding the statement failure', async () => {
    const statementFailure = new Error('statement failed')
    const rollbackFailure = new Error('rollback failed')
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      if (command === 'ROLLBACK') throw rollbackFailure
    })

    const result = runAtomicSqliteStatements({ exec }, [Promise.reject(statementFailure)])
    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'runAtomicSqliteStatements: statement execution and rollback both failed',
    })
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([statementFailure, rollbackFailure])
    })
  })
})

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
