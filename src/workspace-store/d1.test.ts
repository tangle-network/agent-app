import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createMemoryTools, workspaceStoreContractCases } from '@tangle-network/agent-runtime/workspace-store'
import { createD1R2WorkspaceStore, WORKSPACE_STORE_D1_SCHEMA_SQL, type WorkspaceStoreD1Database } from './d1'

/** better-sqlite3 behind the D1 surface; `batch` is one transaction, as on D1. */
function d1() {
  const sqlite = new Database(':memory:')
  sqlite.exec(WORKSPACE_STORE_D1_SCHEMA_SQL)
  const statement = (sql: string, values: (string | number | null)[] = []) => ({
    bind: (...next: (string | number | null)[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
    exec: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) =>
      sqlite.transaction(() => statements.map(item => item.exec()))(),
  } as unknown as WorkspaceStoreD1Database
  return { db, sqlite }
}

function bucket() {
  const deleted: string[] = []
  return { deleted, delete: async (key: string) => { deleted.push(key) } }
}

describe('D1 + R2 workspace store', () => {
  for (const contractCase of workspaceStoreContractCases(() => createD1R2WorkspaceStore({ db: d1().db, bucket: bucket() }))) {
    it(`meets the store contract: ${contractCase.name}`, contractCase.run)
  }

  it('erases the R2 object after the row and keeps the tombstone', async () => {
    const r2 = bucket()
    const store = createD1R2WorkspaceStore({ db: d1().db, bucket: r2 })
    const saved = await store.put({ workspaceId: 'ws', path: '/files/menu.pdf', kind: 'file', ifRevision: null,
      actor: 'm-1', bytes: { key: 'ws/files/menu.pdf', size: 10, contentType: 'application/pdf' } })
    const tomb = await store.delete({ workspaceId: 'ws', path: '/files/menu.pdf', ifRevision: saved.revision, actor: 'm-1' })
    expect(tomb).toMatchObject({ path: '/files/menu.pdf', revision: saved.revision + 1, deletedBy: 'm-1' })
    expect(r2.deleted).toEqual(['ws/files/menu.pdf'])
    expect(await store.get('ws', '/files/menu.pdf')).toBeNull()
    expect(await store.tombstones('ws')).toHaveLength(1)
  })

  it('treats LIKE wildcards in a prefix as literal text', async () => {
    const store = createD1R2WorkspaceStore({ db: d1().db })
    for (const path of ['/files/a_b.md', '/files/axb.md']) {
      await store.put({ workspaceId: 'ws', path, kind: 'file', ifRevision: null, actor: 'm', content: path })
    }
    expect((await store.list('ws', '/files/a_')).map(entry => entry.path)).toEqual(['/files/a_b.md'])
  })

  it('remembers through the runtime tools and writes no profile revision', async () => {
    const { db, sqlite } = d1()
    const store = createD1R2WorkspaceStore({ db })
    const remember = createMemoryTools({ store,
      activeTurn: async () => ({ workspaceId: 'ws', memberId: 'm-1', role: 'owner' as const }) })
      .find(tool => tool.name === 'memory.remember')!
    await remember.run({ text: 'The sauna closes at 8pm on Sundays.', kind: 'fact', scope: 'workspace' } as never)
    const rows = sqlite.prepare('SELECT path, content FROM workspace_store_entry').all() as { content: string }[]
    expect(rows.map(row => row.content)).toEqual(['The sauna closes at 8pm on Sundays.'])
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(row => row.name)
    expect(tables.some(name => name.startsWith('agent_profile'))).toBe(false)
  })
})
