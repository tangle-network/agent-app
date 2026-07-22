import { describe, it, expect } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, text } from 'drizzle-orm/sqlite-core'
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
})
