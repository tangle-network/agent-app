import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  createDatabaseProvider,
  createInMemoryKV,
  runAtomicSqliteStatements,
  runSqliteStatements,
  type SqliteAtomicConnection,
  type SqliteLazyStatement,
  type SqliteManualTransactionConnection,
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
  it('uses the native transaction callback and its one connection', async () => {
    const order: string[] = []
    const connections: SqliteAtomicConnection[] = []
    let transactionConnection!: SqliteAtomicConnection
    const execute = vi.fn(async <T>(statement: SqliteLazyStatement<T>) => {
      order.push('execute')
      connections.push(transactionConnection)
      return await statement(transactionConnection)
    })
    const transaction = vi.fn(async (callback: (connection: SqliteAtomicConnection) => unknown[] | Promise<unknown[]>) => {
      order.push('transaction')
      transactionConnection = { execute }
      return callback(transactionConnection)
    })
    const statements: [SqliteLazyStatement, ...SqliteLazyStatement[]] = [
      async () => {
        order.push('first')
        return 'first'
      },
      async () => {
        order.push('second')
        return 'second'
      },
    ]
    await expect(runAtomicSqliteStatements({ transaction }, statements)).resolves.toEqual([
      'first',
      'second',
    ])
    expect(transaction).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['transaction', 'execute', 'first', 'execute', 'second'])
    expect(connections).toHaveLength(2)
    expect(connections[0]).toBe(connections[1])
  })

  it('fails closed before invoking a lazy statement when no atomic capability exists', async () => {
    let awaited = false
    const statement: SqliteLazyStatement = () => {
      awaited = true
      return 'should not run'
    }

    await expect(runAtomicSqliteStatements({}, [statement])).rejects.toThrow(
      'transaction() or one fallbackConnection with exec() and execute()',
    )
    expect(awaited).toBe(false)
  })

  it('rejects a prestarted promise before opening a transaction', async () => {
    const exec = vi.fn()
    const prestarted = Promise.resolve('already started') as unknown as SqliteLazyStatement

    await expect(runAtomicSqliteStatements({ fallbackConnection: {
      exec,
      execute: async (statement) => statement({ execute: async () => undefined }),
    } }, [prestarted])).rejects.toThrow('every statement must be a lazy function')
    expect(exec).not.toHaveBeenCalled()
  })

  it('wraps lazy operations in BEGIN IMMEDIATE and COMMIT on one connection', async () => {
    const commands: string[] = []
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
    })
    const order: number[] = []
    const connections: SqliteAtomicConnection[] = []
    let connection!: SqliteManualTransactionConnection
    const execute = vi.fn(async <T>(statement: SqliteLazyStatement<T>) =>
      statement(connection),
    )
    connection = { execute, exec }
    const statement = (value: number): SqliteLazyStatement => (currentConnection) => {
      connections.push(currentConnection)
      order.push(value)
      return value
    }

    await expect(runAtomicSqliteStatements({ fallbackConnection: connection }, [statement(1), statement(2)])).resolves.toEqual([1, 2])
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    expect(order).toEqual([1, 2])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(connections[0]).toBe(connections[1])
  })

  it('rolls back when a statement rejects and preserves the original failure', async () => {
    const commands: string[] = []
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
    })
    const failure = new Error('statement failed')

    let connection!: SqliteManualTransactionConnection
    const execute = vi.fn(async <T>(statement: SqliteLazyStatement<T>) =>
      statement(connection),
    )
    connection = { execute, exec }
    await expect(runAtomicSqliteStatements({ fallbackConnection: connection }, [
      () => 'first',
      () => Promise.reject(failure),
    ])).rejects.toBe(failure)
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })

  it('rolls back when COMMIT rejects', async () => {
    const commands: string[] = []
    const commitFailure = new Error('commit failed')
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      commands.push(command)
      if (command === 'COMMIT') throw commitFailure
    })
    let connection!: SqliteManualTransactionConnection
    const execute = vi.fn(async <T>(statement: SqliteLazyStatement<T>) =>
      statement(connection),
    )
    connection = { execute, exec }

    await expect(runAtomicSqliteStatements({ fallbackConnection: connection }, [() => 'done'])).rejects.toBe(commitFailure)
    expect(commands).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'])
  })

  it('aggregates a rollback failure without discarding the statement failure', async () => {
    const statementFailure = new Error('statement failed')
    const rollbackFailure = new Error('rollback failed')
    const exec = vi.fn(async (command: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK') => {
      if (command === 'ROLLBACK') throw rollbackFailure
    })
    let connection!: SqliteManualTransactionConnection
    const execute = vi.fn(async <T>(statement: SqliteLazyStatement<T>) =>
      statement(connection),
    )
    connection = { execute, exec }

    const result = runAtomicSqliteStatements({ fallbackConnection: connection }, [() => Promise.reject(statementFailure)])
    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'runAtomicSqliteStatements: statement execution and rollback both failed',
    })
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([statementFailure, rollbackFailure])
    })
  })

  it('commits two writes on a real SQLite connection', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    let connection!: SqliteManualTransactionConnection
    connection = {
      exec: (command) => sqlite.exec(command),
      execute: (statement) => statement(connection),
    }
    const db = {
      fallbackConnection: connection,
    }

    try {
      await expect(runAtomicSqliteStatements(db, [
        () => sqlite.prepare('INSERT INTO item (value) VALUES (?)').run('first'),
        () => sqlite.prepare('INSERT INTO item (value) VALUES (?)').run('second'),
      ])).resolves.toHaveLength(2)
      expect(sqlite.prepare('SELECT value FROM item ORDER BY id').all()).toEqual([
        { value: 'first' },
        { value: 'second' },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('rolls back a real SQLite write when the next write fails', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)')
    let connection!: SqliteManualTransactionConnection
    connection = {
      exec: (command) => sqlite.exec(command),
      execute: (statement) => statement(connection),
    }
    const db = {
      fallbackConnection: connection,
    }

    try {
      await expect(runAtomicSqliteStatements(db, [
        () => sqlite.prepare('INSERT INTO item (value) VALUES (?)').run('same'),
        () => sqlite.prepare('INSERT INTO item (value) VALUES (?)').run('same'),
      ])).rejects.toThrow('UNIQUE constraint failed')
      expect(sqlite.prepare('SELECT count(*) AS count FROM item').get()).toEqual({ count: 0 })
    } finally {
      sqlite.close()
    }
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
