import { describe, it, expect, vi } from 'vitest'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { BULK_DELETE_MAX_THREADS, ChatStoreInputError, threadTitleFromMessage } from '../../src/chat-store/core'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const tables = createChatTables({ workspaceTable: workspacesTable })

async function freshStore() {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([
    { id: 'ws1', organizationId: 'org1', name: 'WS 1' },
    { id: 'ws2', organizationId: 'org1', name: 'WS 2' },
  ])
  return { db, store: createChatStore(db, tables) }
}

describe('threadTitleFromMessage', () => {
  it('takes the first non-empty line', () => {
    expect(threadTitleFromMessage('\n\n  hello there  \nsecond line')).toBe('hello there')
  })

  it('caps at 80 chars with an ellipsis', () => {
    const title = threadTitleFromMessage('x'.repeat(200))
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back to "New Thread" for blank input', () => {
    expect(threadTitleFromMessage('   \n \n')).toBe('New Thread')
  })
})

describe('createChatStore — threads', () => {
  it('createThread derives the title from firstMessage', async () => {
    const { store } = await freshStore()
    const thread = await store.createThread({
      workspaceId: 'ws1',
      firstMessage: '\nDraft the filing\nlots of detail…',
    })
    expect(thread.title).toBe('Draft the filing')
    expect(thread.workspaceId).toBe('ws1')
    expect(thread.isPinned).toBe(false)
  })

  it('createThread normalizes an explicit title through the same 80-char cap', async () => {
    const { store } = await freshStore()
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'y'.repeat(120) })
    expect(thread.title).toHaveLength(80)
  })

  it('getThread returns the row or null', async () => {
    const { store } = await freshStore()
    const created = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    expect((await store.getThread(created.id))?.id).toBe(created.id)
    expect(await store.getThread('nope')).toBeNull()
  })

  it('renameThread trims, rejects empty titles, and returns null for a missing thread', async () => {
    const { store } = await freshStore()
    const created = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    const renamed = await store.renameThread(created.id, '  New name  ')
    expect(renamed?.title).toBe('New name')
    await expect(store.renameThread(created.id, '   ')).rejects.toBeInstanceOf(ChatStoreInputError)
    expect(await store.renameThread('nope', 'x')).toBeNull()
  })

  it('pinThread toggles and returns null for a missing thread', async () => {
    const { store } = await freshStore()
    const created = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    expect((await store.pinThread(created.id, true))?.isPinned).toBe(true)
    expect((await store.pinThread(created.id, false))?.isPinned).toBe(false)
    expect(await store.pinThread('nope', true)).toBeNull()
  })
})

describe('createChatStore — listThreads', () => {
  it('scopes to the workspace, orders by updatedAt desc with id tiebreak, and counts the full set', async () => {
    const { db, store } = await freshStore()
    // Explicit timestamps: unixepoch() default is second-granular, so an
    // insert burst would otherwise tie.
    const rows = [
      { id: 'a', workspaceId: 'ws1', title: 'old', updatedAt: new Date(1_000_000) },
      { id: 'c', workspaceId: 'ws1', title: 'tied-c', updatedAt: new Date(2_000_000) },
      { id: 'b', workspaceId: 'ws1', title: 'tied-b', updatedAt: new Date(2_000_000) },
      { id: 'z', workspaceId: 'ws2', title: 'other-ws', updatedAt: new Date(9_000_000) },
    ]
    for (const row of rows) await db.insert(tables.threads).values(row)

    const result = await store.listThreads({ workspaceId: 'ws1' })
    expect(result.threads.map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(result).toMatchObject({ total: 3, limit: 50, offset: 0 })
  })

  it('clamps limit to 1..200 and offset to >= 0; total stays the unpaged count', async () => {
    const { store } = await freshStore()
    for (let i = 0; i < 3; i += 1) await store.createThread({ workspaceId: 'ws1', title: `t${i}` })

    const clampedLow = await store.listThreads({ workspaceId: 'ws1', limit: -5, offset: -10 })
    expect(clampedLow).toMatchObject({ limit: 1, offset: 0, total: 3 })
    expect(clampedLow.threads).toHaveLength(1)

    const clampedHigh = await store.listThreads({ workspaceId: 'ws1', limit: 9999 })
    expect(clampedHigh.limit).toBe(200)

    const paged = await store.listThreads({ workspaceId: 'ws1', limit: 2, offset: 2 })
    expect(paged.threads).toHaveLength(1)
    expect(paged.total).toBe(3)
  })
})

describe('createChatStore — messages', () => {
  it('appendMessage persists parts + usage columns and bumps the thread updatedAt', async () => {
    const { db, store } = await freshStore()
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    const { eq } = await import('drizzle-orm')
    const stale = new Date(1_000_000)
    await db.update(tables.threads).set({ updatedAt: stale }).where(eq(tables.threads.id, thread.id))

    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'answer',
      parts: [{ type: 'text', text: 'answer' }],
      model: 'claude-fable-5',
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      costUsd: 0.02,
    })
    expect(message.parts).toEqual([{ type: 'text', text: 'answer' }])
    expect(message).toMatchObject({
      role: 'assistant',
      model: 'claude-fable-5',
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      costUsd: 0.02,
    })

    const bumped = await store.getThread(thread.id)
    expect(bumped!.updatedAt.getTime()).toBeGreaterThan(stale.getTime())
  })

  it('listMessages returns oldest-first with rowid tiebreak inside a same-second burst', async () => {
    const { store } = await freshStore()
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    // Same epoch second (unixepoch() default): rowid must keep insertion order.
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'first' })
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'second' })
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'third' })

    const all = await store.listMessages(thread.id)
    expect(all.map((m) => m.content)).toEqual(['first', 'second', 'third'])

    const paged = await store.listMessages(thread.id, { limit: 1, offset: 1 })
    expect(paged.map((m) => m.content)).toEqual(['second'])
  })
})

describe('createChatStore — deleteThread', () => {
  it('deletes messages then the thread; resolves false for a missing thread', async () => {
    const { db, store } = await freshStore()
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' })

    expect(await store.deleteThread(thread.id)).toBe(true)
    expect(await store.getThread(thread.id)).toBeNull()
    expect(await db.select().from(tables.messages)).toEqual([])
    expect(await store.deleteThread(thread.id)).toBe(false)
  })

  it('passes the thread workspaceId to assertAccess and aborts on throw', async () => {
    const { store } = await freshStore()
    const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })

    const seen: string[] = []
    await expect(store.deleteThread(thread.id, {
      assertAccess: (workspaceId) => {
        seen.push(workspaceId)
        throw new Error('denied')
      },
    })).rejects.toThrow('denied')
    expect(seen).toEqual(['ws1'])
    expect(await store.getThread(thread.id)).not.toBeNull()
  })
})

describe('createChatStore — bulkDeleteThreads', () => {
  it('validates input: assertAccess required, ids non-empty strings, max cap', async () => {
    const { store } = await freshStore()
    const ok = () => {}
    await expect(store.bulkDeleteThreads({ ids: ['a'], assertAccess: undefined as never }))
      .rejects.toBeInstanceOf(ChatStoreInputError)
    await expect(store.bulkDeleteThreads({ ids: [], assertAccess: ok }))
      .rejects.toBeInstanceOf(ChatStoreInputError)
    await expect(store.bulkDeleteThreads({ ids: ['a', ''], assertAccess: ok }))
      .rejects.toBeInstanceOf(ChatStoreInputError)
    await expect(store.bulkDeleteThreads({
      ids: Array.from({ length: BULK_DELETE_MAX_THREADS + 1 }, (_, i) => `id-${i}`),
      assertAccess: ok,
    })).rejects.toBeInstanceOf(ChatStoreInputError)
  })

  it('checks access once per distinct workspace and fail-closed rejects the whole batch', async () => {
    const { store } = await freshStore()
    const t1 = await store.createThread({ workspaceId: 'ws1', title: 'A' })
    const t2 = await store.createThread({ workspaceId: 'ws1', title: 'B' })
    const t3 = await store.createThread({ workspaceId: 'ws2', title: 'C' })

    const assertAccess = vi.fn((workspaceId: string) => {
      if (workspaceId === 'ws2') throw new Error('denied')
    })
    await expect(store.bulkDeleteThreads({ ids: [t1.id, t2.id, t3.id], assertAccess }))
      .rejects.toThrow('denied')
    // Once per workspace, not per thread — and nothing was deleted.
    expect(assertAccess.mock.calls.map(([ws]) => ws).sort()).toEqual(['ws1', 'ws2'])
    expect(await store.getThread(t1.id)).not.toBeNull()
    expect(await store.getThread(t3.id)).not.toBeNull()
  })

  it('deletes found threads with their messages and reports only real deletions', async () => {
    const { db, store } = await freshStore()
    const t1 = await store.createThread({ workspaceId: 'ws1', title: 'A' })
    const t2 = await store.createThread({ workspaceId: 'ws1', title: 'B' })
    await store.appendMessage({ threadId: t1.id, role: 'user', content: 'hi' })

    const result = await store.bulkDeleteThreads({
      ids: [t1.id, t2.id, 'missing-id'],
      assertAccess: () => {},
    })
    expect(result).toEqual({ deleted: 2 })
    expect(await store.getThread(t1.id)).toBeNull()
    expect(await store.getThread(t2.id)).toBeNull()
    expect(await db.select().from(tables.messages)).toEqual([])
  })

  it('resolves {deleted: 0} without calling assertAccess when no ids match', async () => {
    const { store } = await freshStore()
    const assertAccess = vi.fn()
    expect(await store.bulkDeleteThreads({ ids: ['ghost'], assertAccess })).toEqual({ deleted: 0 })
    expect(assertAccess).not.toHaveBeenCalled()
  })
})

describe('createChatStore — batch seam', () => {
  it('routes multi-statement writes through db.batch when the driver has one', async () => {
    const { db, store } = await freshStore()
    const batch = vi.fn(async (statements: [unknown, ...unknown[]]) => {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement)
      return results
    })
    ;(db as { batch?: typeof batch }).batch = batch

    const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' })
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toHaveLength(2)

    await store.deleteThread(thread.id)
    expect(batch).toHaveBeenCalledTimes(2)
  })
})

describe('createChatStore — extras passthrough', () => {
  it('writes product extra columns verbatim in the same insert and never defaults them', async () => {
    const { text } = await import('drizzle-orm/sqlite-core')
    const extended = createChatTables({
      workspaceTable: workspacesTable,
      tablePrefix: 'x_',
      threadExtraColumns: { status: text('status').notNull().default('active') },
      messageExtraColumns: { vaultFiles: text('vault_files') },
    })
    const db = openDatabase([workspacesTable, extended.threads, extended.messages]) as unknown as ChatDatabase
    await db.insert(workspacesTable).values({ id: 'ws1', organizationId: 'org1', name: 'WS' })
    const store = createChatStore(db, extended)

    const thread = await store.createThread({
      workspaceId: 'ws1',
      title: 'T',
      extras: { status: 'archived' },
    })
    expect(thread.status).toBe('archived')

    const defaulted = await store.createThread({ workspaceId: 'ws1', title: 'U' })
    expect(defaulted.status).toBe('active')

    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'hi',
      extras: { vaultFiles: '["a.pdf"]' },
    })
    expect(message.vaultFiles).toBe('["a.pdf"]')
  })
})
