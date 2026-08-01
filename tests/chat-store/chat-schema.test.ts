import { describe, it, expect } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, index, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Part as HarnessWirePart } from '@tangle-network/agent-interface'
import { createChatTables } from '../../src/chat-store/schema'
import type { ChatMessagePart } from '../../src/chat-store/parts'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const tables = createChatTables({ workspaceTable: workspacesTable })

/** Find the FK on `table.localColumn` and return its referenced table+column+onDelete. */
function fkFor(table: Parameters<typeof getTableConfig>[0], localColumn: string) {
  const config = getTableConfig(table)
  for (const fk of config.foreignKeys) {
    const ref = fk.reference()
    if (ref.columns.some((c) => c.name === localColumn)) {
      return {
        foreignTable: getTableName(ref.foreignTable),
        foreignColumn: ref.foreignColumns[0]?.name,
        onDelete: fk.onDelete,
      }
    }
  }
  return null
}

describe('createChatTables — table shapes', () => {
  it('produces thread and message (legal/gtm row-compatible names)', () => {
    expect(getTableName(tables.threads)).toBe('thread')
    expect(getTableName(tables.messages)).toBe('message')
  })

  it('thread.workspace_id → the passed workspace table (cascade)', () => {
    expect(fkFor(tables.threads, 'workspace_id')).toEqual({
      foreignTable: 'workspace',
      foreignColumn: 'id',
      onDelete: 'cascade',
    })
  })

  it('message.thread_id → thread (cascade)', () => {
    expect(fkFor(tables.messages, 'thread_id')).toEqual({
      foreignTable: 'thread',
      foreignColumn: 'id',
      onDelete: 'cascade',
    })
  })

  it('defines nullable requested and effective model attribution columns', () => {
    const columns = getTableConfig(tables.messages).columns
    for (const name of [
      'requested_model',
      'served_model',
      'served_provider',
      'served_model_source',
    ]) {
      const column = columns.find((candidate) => candidate.name === name)
      expect(column).toBeDefined()
      expect(column?.notNull).toBe(false)
    }
  })

  it('workspace_id stays a plain column when no workspace table is passed', () => {
    const detached = createChatTables()
    expect(fkFor(detached.threads, 'workspace_id')).toBeNull()
    const config = getTableConfig(detached.threads)
    expect(config.columns.find((c) => c.name === 'workspace_id')?.notNull).toBe(true)
  })
})

describe('createChatTables — tablePrefix', () => {
  const prefixed = createChatTables({ workspaceTable: workspacesTable, tablePrefix: 'chat_' })

  it('prefixes table names', () => {
    expect(getTableName(prefixed.threads)).toBe('chat_thread')
    expect(getTableName(prefixed.messages)).toBe('chat_message')
  })

  it('prefixes index names so prefixed and unprefixed tables coexist in one db', () => {
    const names = [
      ...getTableConfig(prefixed.threads).indexes,
      ...getTableConfig(prefixed.messages).indexes,
    ].map((idx) => idx.config.name)
    expect(names).toEqual([
      'idx_chat_thread_workspace',
      'idx_chat_thread_workspace_updated',
      'idx_chat_message_thread',
      'idx_chat_message_thread_created',
    ])
    // Both variants migrate into the same database without index collisions.
    const db = openDatabase([
      workspacesTable,
      tables.threads,
      tables.messages,
      prefixed.threads,
      prefixed.messages,
    ])
    expect(db).toBeTruthy()
  })
})

describe('createChatTables — defaults at runtime', () => {
  it('applies id/isPinned/parts/timestamps defaults on insert', async () => {
    const db = openDatabase([workspacesTable, tables.threads, tables.messages])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })

    const [thread] = await db.insert(tables.threads).values({ workspaceId: 'ws1', title: 'T' }).returning()
    expect(thread!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(thread!.isPinned).toBe(false)
    expect(thread!.category).toBeNull()
    expect(thread!.createdAt).toBeInstanceOf(Date)
    expect(thread!.updatedAt).toBeInstanceOf(Date)

    const [message] = await db.insert(tables.messages)
      .values({ threadId: thread!.id, role: 'user', content: 'hi' })
      .returning()
    expect(message!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(message!.parts).toEqual([])
    expect(message!.toolName).toBeNull()
    expect(message!.model).toBeNull()
    expect(message!.requestedModel).toBeNull()
    expect(message!.servedModel).toBeNull()
    expect(message!.servedProvider).toBeNull()
    expect(message!.servedSource).toBeNull()
    expect(message!.inputTokens).toBeNull()
    expect(message!.costUsd).toBeNull()
  })

  it('deleting a thread cascades to its messages (FK graph is real)', async () => {
    const db = openDatabase([workspacesTable, tables.threads, tables.messages])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })
    const [thread] = await db.insert(tables.threads).values({ workspaceId: 'ws1', title: 'T' }).returning()
    await db.insert(tables.messages).values({ threadId: thread!.id, role: 'user', content: 'hi' })

    const { eq } = await import('drizzle-orm')
    await db.delete(tables.threads).where(eq(tables.threads.id, thread!.id))
    const remaining = await db.select().from(tables.messages)
    expect(remaining).toEqual([])
  })
})

describe('ChatMessagePart — canonical coverage', () => {
  it('covers every agent-interface harness wire-part kind', () => {
    // Compile-time: a new canonical part kind in the peer must extend the
    // stored vocabulary or this line stops typechecking.
    type Covered = HarnessWirePart['type'] extends ChatMessagePart['type'] ? true : false
    const covered: Covered = true
    expect(covered).toBe(true)
  })

  it('round-trips a step-finish usage receipt and a persisted tool part', async () => {
    const db = openDatabase([workspacesTable, tables.threads, tables.messages])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })
    const [thread] = await db.insert(tables.threads).values({ workspaceId: 'ws1', title: 'T' }).returning()

    const parts: ChatMessagePart[] = [
      { type: 'text', text: 'answer', id: 'seg-1' },
      {
        type: 'tool',
        id: 'tool-1',
        tool: 'grep',
        state: { status: 'completed', input: { pattern: 'x' }, output: 'ok', time: { start: 1, end: 2 } },
      },
      { type: 'step-finish', tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 5, write: 1 } }, cost: 0.02 },
      { type: 'interaction', id: 'i-1', kind: 'question', title: 'Pick', answerSpec: { fields: [] }, status: 'answered' },
      { type: 'mention', mentionKind: 'image', path: 'assets/logo.png', name: 'logo.png', size: 42 },
    ]
    const [message] = await db.insert(tables.messages)
      .values({ threadId: thread!.id, role: 'assistant', content: 'answer', parts })
      .returning()
    expect(message!.parts).toEqual(parts)
  })

  it('round-trips requested and effective model attribution', async () => {
    const db = openDatabase([workspacesTable, tables.threads, tables.messages])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })
    const [thread] = await db.insert(tables.threads).values({ workspaceId: 'ws1', title: 'T' }).returning()

    const [message] = await db.insert(tables.messages)
      .values({
        threadId: thread!.id,
        role: 'assistant',
        content: 'answer',
        model: 'anthropic/claude-sonnet-4',
        requestedModel: 'openai/gpt-5',
        servedModel: 'anthropic/claude-sonnet-4',
        servedProvider: 'openrouter',
        servedSource: 'profile',
      })
      .returning()

    expect(message).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      requestedModel: 'openai/gpt-5',
      servedModel: 'anthropic/claude-sonnet-4',
      servedProvider: 'openrouter',
      servedSource: 'profile',
    })
  })
})

/**
 * A product with one extra index used to have no way to adopt the factory: it
 * kept a hand-rolled duplicate of the same physical table, and the two drifted
 * on the next factory change. gtm carried exactly that — two `message`
 * declarations, one for reads and one for writes.
 */
describe('createChatTables — product indexes', () => {
  const withIndexes = createChatTables({
    workspaceTable: workspacesTable,
    threadExtraColumns: { scopeKey: text('scope_key') },
    messageExtraColumns: { turnId: text('turn_id') },
    threadExtraIndexes: (c) => [index('idx_thread_scope').on(c.scopeKey!)],
    messageExtraIndexes: (c) => [
      uniqueIndex('uniq_message_thread_role_turn').on(c.threadId!, c.role!, c.turnId!),
    ],
  })

  function indexNames(table: Parameters<typeof getTableConfig>[0]) {
    return getTableConfig(table).indexes.map((i) => i.config.name).sort()
  }

  it('appends product indexes to the factory’s own, on both tables', () => {
    expect(indexNames(withIndexes.threads)).toEqual([
      'idx_thread_scope', 'idx_thread_workspace', 'idx_thread_workspace_updated',
    ])
    expect(indexNames(withIndexes.messages)).toEqual([
      'idx_message_thread', 'idx_message_thread_created', 'uniq_message_thread_role_turn',
    ])
  })

  it('can index a column the PRODUCT added, not just the factory’s own', () => {
    const scope = getTableConfig(withIndexes.threads).indexes.find((i) => i.config.name === 'idx_thread_scope')
    expect(scope?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['scope_key'])
  })

  it('carries uniqueness, so a dedup index is actually unique', () => {
    const uniq = getTableConfig(withIndexes.messages).indexes.find(
      (i) => i.config.name === 'uniq_message_thread_role_turn',
    )
    expect(uniq?.config.unique).toBe(true)
  })

  it('does not prefix a product index name — it must match the product’s migration', () => {
    const prefixedWithExtras = createChatTables({
      tablePrefix: 'chat_',
      threadExtraColumns: { scopeKey: text('scope_key') },
      threadExtraIndexes: (c) => [index('idx_thread_scope').on(c.scopeKey!)],
    })
    expect(indexNames(prefixedWithExtras.threads)).toEqual([
      'idx_chat_thread_workspace', 'idx_chat_thread_workspace_updated', 'idx_thread_scope',
    ])
  })

  it('leaves a product that supplies none byte-unchanged', () => {
    const plain = createChatTables({ workspaceTable: workspacesTable })
    expect(indexNames(plain.threads)).toEqual(['idx_thread_workspace', 'idx_thread_workspace_updated'])
    expect(indexNames(plain.messages)).toEqual(['idx_message_thread', 'idx_message_thread_created'])
  })
})

/**
 * A table built WITH product indexes still behaves like one built without.
 *
 * Worth stating plainly: these assertions did NOT catch the regression that
 * prompted them. Typing the callback `unknown[]` forced a cast on the whole
 * extra-config array, and the resulting column widening
 * (`PgColumn | MySqlColumn | …`) is invisible inside this package — it appears
 * only through the emitted `.d.ts`, in a consumer whose own `db` meets the
 * table. gtm's typecheck is what failed, with five errors on one `db.select`.
 *
 * They stay because what they pin is real and cheap: the seam does not change
 * insert/select behaviour or the column types this package can see. The guard
 * for the emitted-type shape is a consumer's typecheck, which is where the
 * defect surfaced and where it is caught again.
 */
describe('createChatTables — the seam preserves table inference', () => {
  const t = createChatTables({
    workspaceTable: workspacesTable,
    threadExtraColumns: { scopeKey: text('scope_key') },
    messageExtraColumns: { turnId: text('turn_id') },
    threadExtraIndexes: (c) => [index('idx_thread_scope').on(c.scopeKey!)],
    messageExtraIndexes: (c) => [
      uniqueIndex('uniq_message_thread_role_turn').on(c.threadId!, c.role!, c.turnId!),
    ],
  })

  it('still supports a projected select over core AND extra columns', async () => {
    const db = openDatabase([workspacesTable, t.threads, t.messages])
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })
    const [thread] = await db
      .insert(t.threads)
      .values({ workspaceId: 'ws1', title: 'T', scopeKey: 'deal-1' })
      .returning()
    await db
      .insert(t.messages)
      .values({ threadId: thread!.id, role: 'user', content: 'hi', turnId: 'turn-1' })

    // Projected select — the exact shape that broke when the columns widened.
    const rows = await db
      .select({ id: t.messages.id, role: t.messages.role, turnId: t.messages.turnId })
      .from(t.messages)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'user', turnId: 'turn-1' })
    // `role` keeps its enum type, not `unknown` — a widened column loses this.
    const role: 'user' | 'assistant' | 'system' | 'tool' = rows[0]!.role
    expect(role).toBe('user')
    // And the product's extra column keeps `string | null`, not `unknown`.
    const turnId: string | null = rows[0]!.turnId
    expect(turnId).toBe('turn-1')
  })

  /** Column types this package CAN see stay SQLite-shaped. */
  it('keeps SQLite column types on both tables', () => {
    const threadWorkspaceId: SQLiteColumn = t.threads.workspaceId
    const threadScopeKey: SQLiteColumn = t.threads.scopeKey
    const messageRole: SQLiteColumn = t.messages.role
    const messageTurnId: SQLiteColumn = t.messages.turnId
    for (const column of [threadWorkspaceId, threadScopeKey, messageRole, messageTurnId]) {
      expect(column.name).toBeTruthy()
    }
  })
})
