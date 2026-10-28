/** Persisted interleaved transcript → real SQLite reload → each responder's prompt. */
import { expect, it } from 'vitest'
import { projectDispatchHistory } from '../../src/chat-routes/dispatch-parts'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { openDatabase, workspacesTable } from '../teams/db-helper'

it('projects each stored responder once with its own text and files, preserving shared text and private traces', async () => {
  const tables = createChatTables({ workspaceTable: workspacesTable })
  const db = openDatabase([workspacesTable, tables.threads, tables.messages])
  try {
    const store = createChatStore(db as unknown as ChatDatabase, tables)
    await db.insert(workspacesTable).values({ id: 'workspace', organizationId: 'org', name: 'Fixture' })
    const thread = await store.createThread({ workspaceId: 'workspace' })
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'Combined display text', parts: [
      { type: 'text', text: 'Shared.' },
      { type: 'speaker', id: 'writer', name: 'Writer' },
      { type: 'speaker', id: 'research', name: 'Research' },
      { type: 'text', text: 'Headline.', speaker: 'writer' },
      { type: 'file', name: 'Brief', path: 'brief.md', mediaType: 'text/plain', speaker: 'writer' },
      { type: 'reasoning', text: 'Private reasoning', speaker: 'writer' },
      { type: 'text', text: 'Risks.', speaker: 'research' },
      { type: 'tool-result', text: 'Private tool trace', speaker: 'research' },
      { type: 'text', text: 'Unannounced.', speaker: 'unknown' },
      { type: 'speaker', id: 'writer', name: 'Writer', state: 'done' },
      { type: 'speaker', id: 'research', name: 'Research', state: 'done' },
    ] })
    const rows = await store.listMessages(thread.id)
    expect(rows).toHaveLength(1)
    const writer = projectDispatchHistory(rows, { pov: 'writer' })
    expect(writer.map(({ role, content }) => [role, content.split('\n\n')[0]])).toEqual([
      ['assistant', 'Shared.Unannounced.'], ['assistant', 'Headline.'], ['user', '[Research] Risks.'],
    ])
    expect(writer[1]!.content).toContain('- Brief (vault: brief.md)')
    expect(writer[0]!.content + writer[2]!.content).not.toContain('brief.md')
    const research = projectDispatchHistory(rows, { pov: 'research', attachments: false })
    expect(research).toEqual([
      { role: 'assistant', content: 'Shared.Unannounced.' },
      { role: 'user', content: '[Writer] Headline.' },
      { role: 'assistant', content: 'Risks.' },
    ])
    expect(projectDispatchHistory(rows, { attachments: false })).toEqual([
      { role: 'assistant', content: 'Shared.Unannounced.' },
      { role: 'assistant', content: '[Writer] Headline.' },
      { role: 'assistant', content: '[Research] Risks.' },
    ])
    expect(JSON.stringify(writer)).not.toMatch(/Private|Combined display text/)
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'Plain answer', parts: [] })
    const plain = (await store.listMessages(thread.id)).slice(1)
    expect(projectDispatchHistory(plain, { pov: 'research', owner: { id: 'writer', name: 'Writer' } })).toEqual([
      { role: 'user', content: '[Writer] Plain answer' },
    ])
  } finally { db.$client.close() }
})
