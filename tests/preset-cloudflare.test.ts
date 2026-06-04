import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  PRESET_MIGRATION_SQL,
  PRESET_TABLES,
  createPresetToolHandlers,
  createD1KnowledgeStateAccessor,
  createPresetWorkspaceKeyStore,
  createPresetWorkspaceKeyManager,
  createPresetFieldCrypto,
  createPresetDrizzleSchema,
  type D1Like,
  type D1PreparedLike,
  type DrizzleSqliteCoreLike,
  type DrizzleColumnLike,
} from '../src/preset-cloudflare/index'
import { deriveSignals, buildKnowledgeRequirements, type KnowledgeRequirementSpec } from '../src/knowledge/index'
import type { AppToolContext } from '../src/tools/index'
import type { KvLike } from '../src/web/index'
import type { KeyProvisioner } from '../src/billing/index'

// --- In-memory D1 over node:sqlite (real SQL — proves the DDL + queries) -----

function fakeD1(): { db: D1Like; raw: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  const prepared = (query: string, bound: unknown[] = []): D1PreparedLike => ({
    bind(...values: unknown[]) {
      return prepared(query, values)
    },
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const row = sqlite.prepare(query).get(...(bound as never[])) as Record<string, unknown> | undefined
      if (!row) return null
      if (colName) return (row[colName] ?? null) as T
      return row as T
    },
    async run() {
      return sqlite.prepare(query).run(...(bound as never[]))
    },
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
      const rows = sqlite.prepare(query).all(...(bound as never[])) as T[]
      return { results: rows }
    },
  })
  return { db: { prepare: (q) => prepared(q) }, raw: sqlite }
}

// --- In-memory KV (KvLike) ---------------------------------------------------

function fakeKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, value) {
      store.set(key, value)
    },
  }
}

const ctx: AppToolContext = { userId: 'u1', workspaceId: 'ws1', threadId: 't1' }

let env: ReturnType<typeof fakeD1>
let kv: ReturnType<typeof fakeKv>

beforeEach(() => {
  env = fakeD1()
  for (const sql of PRESET_MIGRATION_SQL) env.raw.exec(sql)
  kv = fakeKv()
})

describe('PRESET_MIGRATION_SQL', () => {
  it('creates exactly the preset tables with the contract column names', () => {
    const tables = (env.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    )
    expect(tables).toEqual(['deadlines', 'knowledge', 'proposals', 'threads', 'workspace_keys'])
    // Every contract column exists in its table.
    for (const spec of Object.values(PRESET_TABLES)) {
      const cols = new Set(
        (env.raw.prepare(`PRAGMA table_info(${spec.name})`).all() as { name: string }[]).map((c) => c.name),
      )
      for (const col of Object.values(spec.columns)) expect(cols.has(col), `${spec.name}.${col}`).toBe(true)
    }
  })
})

describe('createPresetToolHandlers', () => {
  it('submit_proposal writes a pending proposals row and dedupes on (workspace, title)', async () => {
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    const first = await handlers.submitProposal({ type: 'recommend', title: 'Proposal A', description: 'why' }, ctx)
    expect(first.deduped).toBe(false)

    const row = env.raw.prepare(`SELECT * FROM proposals WHERE id = ?`).get(first.proposalId) as Record<string, unknown>
    expect(row).toMatchObject({
      workspace_id: 'ws1',
      thread_id: 't1',
      type: 'recommend',
      title: 'Proposal A',
      description: 'why',
      status: 'pending',
      created_by: 'u1',
    })

    // Same (workspace, title) → dedupe to the existing row, no second insert.
    const again = await handlers.submitProposal({ type: 'recommend', title: 'Proposal A' }, ctx)
    expect(again).toEqual({ proposalId: first.proposalId, deduped: true })
    const count = env.raw.prepare(`SELECT count(*) AS n FROM proposals`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('schedule_followup writes a deadlines row and dedupes on (workspace, title, dueDate)', async () => {
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    const r = await handlers.scheduleFollowup({ title: 'Call client', dueDate: '2026-07-01', priority: 'high' }, ctx)
    expect(r.deduped).toBe(false)
    const row = env.raw.prepare(`SELECT * FROM deadlines WHERE id = ?`).get(r.id) as Record<string, unknown>
    expect(row).toMatchObject({ workspace_id: 'ws1', title: 'Call client', due_date: '2026-07-01', priority: 'high', status: 'scheduled' })

    const dup = await handlers.scheduleFollowup({ title: 'Call client', dueDate: '2026-07-01' }, ctx)
    expect(dup.deduped).toBe(true)
    expect((env.raw.prepare(`SELECT count(*) AS n FROM deadlines`).get() as { n: number }).n).toBe(1)
  })

  it('render_ui persists a vault artifact + knowledge row and returns the exact content', async () => {
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    const schema = { kind: 'board', columns: ['new', 'won'] }
    const r = await handlers.renderUi({ title: 'Lead Board', schema }, ctx)
    expect(r.path).toBe('ui/t1/lead-board.json')
    expect(r.content).toBe(JSON.stringify(schema))
    expect(kv.store.get(r.path)).toBe(JSON.stringify(schema))
    const krow = env.raw.prepare(`SELECT * FROM knowledge WHERE path = ?`).get(r.path) as Record<string, unknown>
    expect(krow).toMatchObject({ workspace_id: 'ws1', kind: 'ui', label: 'Lead Board' })
  })

  it('add_citation persists a citation artifact + knowledge row', async () => {
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    const r = await handlers.addCitation({ path: 'docs/policy.md', quote: 'a human reviews first', label: 'Policy Doc' }, ctx)
    expect(r.path.startsWith('citations/policy-doc-')).toBe(true)
    const body = JSON.parse(kv.store.get(r.path)!)
    expect(body).toEqual({ sourcePath: 'docs/policy.md', quote: 'a human reviews first', label: 'Policy Doc' })
    expect((env.raw.prepare(`SELECT count(*) AS n FROM knowledge WHERE kind='citation'`).get() as { n: number }).n).toBe(1)
  })
})

describe('createD1KnowledgeStateAccessor', () => {
  it('config reads a dot-path; count scopes to workspace + statusIn', async () => {
    // Seed: one pending proposal in ws1, one in ws2, one approved in ws1.
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    await handlers.submitProposal({ type: 'recommend', title: 'A' }, ctx)
    await handlers.submitProposal({ type: 'recommend', title: 'B' }, { ...ctx, workspaceId: 'ws2' })
    env.raw.prepare(`UPDATE proposals SET status='approved' WHERE title='A'`).run()
    await handlers.submitProposal({ type: 'recommend', title: 'C' }, ctx) // pending in ws1

    const accessor = createD1KnowledgeStateAccessor({
      db: env.db,
      workspaceId: 'ws1',
      config: { agency: { licensed: true, agents: ['alice'] }, empty: [] },
    })

    expect(accessor.config('agency.licensed')).toBe(true)
    expect(accessor.config('agency.agents')).toEqual(['alice'])
    expect(accessor.config('agency.missing')).toBeUndefined()

    // ws1 total proposals = 2 (A approved + C pending); ws2's B is excluded.
    expect(await accessor.count({ table: 'proposals' })).toBe(2)
    // status filter: only pending in ws1 = 1.
    expect(await accessor.count({ table: 'proposals', statusIn: ['pending'] })).toBe(1)
    expect(await accessor.count({ table: 'proposals', statusIn: ['pending', 'approved'] })).toBe(2)
  })

  it('rejects an unsafe table/where identifier (fail loud, no injection)', async () => {
    const accessor = createD1KnowledgeStateAccessor({ db: env.db, workspaceId: 'ws1', config: {} })
    await expect(accessor.count({ table: 'proposals; DROP TABLE proposals' })).rejects.toThrow(/unsafe table/)
    await expect(accessor.count({ table: 'proposals', where: 'workspace_id = workspace_id OR 1' })).rejects.toThrow(/unsafe where/)
  })

  it('end-to-end: a submit_proposal write satisfies a declarative satisfiedBy rule with ZERO consumer code', async () => {
    const specs: KnowledgeRequirementSpec[] = [
      {
        id: 'has_pending_proposal',
        description: 'At least one pending proposal exists for the workspace.',
        category: 'domain_specific',
        acquisitionMode: 'query_connector',
        satisfiedBy: { table: 'proposals', statusIn: ['pending'], minRows: 1 },
      },
      {
        id: 'agency_licensed',
        description: 'The agency config marks a licensed agent.',
        category: 'domain_specific',
        acquisitionMode: 'ask_user',
        satisfiedBy: { config: 'agency.licensed' },
      },
    ]
    const accessor = createD1KnowledgeStateAccessor({ db: env.db, workspaceId: 'ws1', config: { agency: { licensed: true } } })

    // Before any proposal: the row rule is unmet (0 confidence), the config rule met.
    const before = await deriveSignals(specs, accessor)
    expect(before.has_pending_proposal!.confidence).toBe(0)
    expect(before.agency_licensed!.confidence).toBe(1)
    const reqBefore = buildKnowledgeRequirements(specs, before)
    expect(reqBefore.find((r) => r.id === 'has_pending_proposal')!.currentConfidence).toBe(0)

    // The default handler writes the row...
    const handlers = createPresetToolHandlers({ db: env.db, vault: kv })
    await handlers.submitProposal({ type: 'recommend', title: 'Proposal A' }, ctx)

    // ...and the SAME declarative rule now resolves satisfied — no handler-specific glue.
    const after = await deriveSignals(specs, accessor)
    expect(after.has_pending_proposal!.confidence).toBe(1)
    const reqAfter = buildKnowledgeRequirements(specs, after)
    expect(reqAfter.find((r) => r.id === 'has_pending_proposal')!.currentConfidence).toBe(1)
  })
})

describe('crypto + per-workspace key wiring', () => {
  const KEY_HEX = 'a'.repeat(64)

  it('field crypto round-trips a secret', async () => {
    const crypto = createPresetFieldCrypto(KEY_HEX)
    const enc = await crypto.encrypt('sk-tan-secret')
    expect(enc).not.toContain('sk-tan-secret')
    expect(await crypto.decrypt(enc)).toBe('sk-tan-secret')
  })

  it('workspace key store + manager mint, encrypt-at-rest, and rotate over D1', async () => {
    let counter = 0
    const provisioner: KeyProvisioner = {
      async createKey() {
        counter += 1
        return { id: `key-${counter}`, key: `sk-router-${counter}` }
      },
      async revokeKey() {
        return {}
      },
      async getKey() {
        return { budgetUsd: 50, budgetSpent: 10 }
      },
    }

    const manager = createPresetWorkspaceKeyManager({
      db: env.db,
      provisioner,
      encryptionKey: KEY_HEX,
      defaultBudgetUsd: 50,
      now: () => new Date('2026-06-15T00:00:00Z'),
    })

    // ensureKey mints + persists; the secret is encrypted at rest (not plaintext in D1).
    const secret = await manager.ensureKey('ws1')
    expect(secret).toBe('sk-router-1')
    const rowAfterMint = env.raw.prepare(`SELECT key_encrypted, revoked_at FROM workspace_keys WHERE workspace_id='ws1'`).get() as {
      key_encrypted: string
      revoked_at: number | null
    }
    expect(rowAfterMint.key_encrypted).not.toContain('sk-router-1')
    expect(rowAfterMint.revoked_at).toBeNull()

    // ensureKey again reuses the active key (decrypts the stored secret) — no new mint.
    expect(await manager.ensureKey('ws1')).toBe('sk-router-1')
    expect(counter).toBe(1)

    // rotateKey mints a fresh key and revokes the prior row.
    const rotated = await manager.rotateKey('ws1')
    expect(rotated).toBe('sk-router-2')
    const active = env.raw.prepare(`SELECT key_id FROM workspace_keys WHERE workspace_id='ws1' AND revoked_at IS NULL`).all() as {
      key_id: string
    }[]
    expect(active).toEqual([{ key_id: 'key-2' }])

    // Usage reflects the provisioner's live budget.
    const usage = await manager.getUsage('ws1')
    expect(usage).toMatchObject({ budgetUsd: 50, budgetSpent: 10, budgetRemaining: 40, exhausted: false })
  })

  it('preset key store getActive returns null for an unknown workspace', async () => {
    const store = createPresetWorkspaceKeyStore(env.db)
    expect(await store.getActive('nope')).toBeNull()
  })
})

describe('createPresetDrizzleSchema', () => {
  it('builds one table per contract entry using the injected sqlite-core builders', () => {
    // A tiny fake of the drizzle builder module: records the table name it was
    // asked to build (proving agent-app never imports drizzle — the consumer
    // supplies the builders).
    const built: string[] = []
    const col = (): DrizzleColumnLike => {
      const c: DrizzleColumnLike = {
        primaryKey: () => c,
        notNull: () => c,
        default: () => c,
      }
      return c
    }
    const fake: DrizzleSqliteCoreLike = {
      sqliteTable: (name) => {
        built.push(name)
        return { __table: name }
      },
      text: () => col(),
      integer: () => col(),
      real: () => col(),
    }
    const schema = createPresetDrizzleSchema(fake)
    expect(built.sort()).toEqual(['deadlines', 'knowledge', 'proposals', 'threads', 'workspace_keys'])
    expect(Object.keys(schema).sort()).toEqual(['deadlines', 'knowledge', 'proposals', 'threads', 'workspaceKeys'])
  })
})
