/** SQLite transcript → file store → HTTP materialization → sandbox prompt. No model calls. */
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { prepareDispatchAttachments, type ReadAttachmentFn } from '../../src/chat-routes/attachment-store'
import { buildDispatchParts, projectDispatchHistory, type DispatchHistoryMessage } from '../../src/chat-routes/dispatch-parts'
import { DISPATCH_MAX_MEDIA_PARTS } from '../../src/chat-routes/wire'
import { historyAttachmentsFromMessages } from '../../src/chat-store/parts'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { openDatabase, workspacesTable } from '../teams/db-helper'

it('carries persisted files through real uploads and refuses missing or incomplete copies before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-dispatch-'))
  let closeDatabase: (() => void) | undefined
  let server: ReturnType<typeof createServer> | undefined
  try {
    const stored = join(directory, 'stored', 'workspace')
    const sandbox = join(directory, 'sandbox')
    const tables = createChatTables({ workspaceTable: workspacesTable })
    const db = openDatabase([workspacesTable, tables.threads, tables.messages])
    closeDatabase = () => db.$client.close()
    const store = createChatStore(db as unknown as ChatDatabase, tables)
    await db.insert(workspacesTable).values({ id: 'workspace', organizationId: 'org', name: 'Fixture' })
    const thread = await store.createThread({ workspaceId: 'workspace' })
    const file = (path: string, name = path) => ({ type: 'file' as const, path, name, mediaType: 'text/plain' })
    const copies: string[] = []
    server = createServer(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/history') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(await store.listMessages(thread.id)))
          return
        }
        const name = decodeURIComponent((request.url ?? '').slice(1))
        if (request.method !== 'POST' || !['current.txt', 'older.txt', 'other.txt'].includes(name)) {
          response.writeHead(404).end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        await writeFile(join(sandbox, name), request.headers['x-short-copy'] === 'yes' ? bytes.subarray(0, 1) : bytes)
        copies.push(name)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ size: (await stat(join(sandbox, name))).size }))
      } catch (error) {
        response.writeHead(500).end(String(error))
      }
    })
    await mkdir(stored, { recursive: true })
    await mkdir(sandbox)
    for (const name of ['current.txt', 'older.txt', 'other.txt']) await writeFile(join(stored, name), `bytes:${name}`)
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Earlier files',
      parts: [file('older.txt', 'old label'), file('current.txt', 'old current label')] })
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'Another file', parts: [file('other.txt')] })
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Updated label', parts: [file('older.txt', 'latest label')] })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const prior: DispatchHistoryMessage[] = await (await fetch(`${origin}/history`)).json()
    const current = [file('current.txt', 'current label')]
    const history = historyAttachmentsFromMessages(current, prior)
    expect(history.map(part => [part.path, part.name])).toEqual([
      ['older.txt', 'latest label'], ['other.txt', 'other.txt'],
    ])
    const readAttachment: ReadAttachmentFn = async (scope, path) => {
      try {
        const bytes = await readFile(join(directory, 'stored', scope, path))
        return { ok: true, size: bytes.length, bytes, mediaType: 'text/plain' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { ok: false, reason: `Attachment missing: ${path}` }
      }
    }
    const upload = async (target: string, bytes: Uint8Array, short = false): Promise<{ size: number }> => {
      const response = await fetch(`${origin}/${encodeURIComponent(basename(target))}`, {
        method: 'POST', headers: { 'x-short-copy': short ? 'yes' : 'no' }, body: new Uint8Array(bytes).buffer,
      })
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      return response.json()
    }
    const input = { attachments: current, historyAttachments: history, scopeId: 'workspace', readAttachment,
      resolveAttachmentPath: (path: string) => join(sandbox, path),
      materialize: { upload, missingBytesMessage: (path: string) => `Bytes unavailable: ${path}` } }
    const attachments = await prepareDispatchAttachments(input)
    expect(copies).toEqual(['current.txt', 'older.txt', 'other.txt'])
    for (const part of attachments) expect(await readFile(join(sandbox, part.path), 'utf8')).toBe(`bytes:${part.path}`)
    const historyText = projectDispatchHistory(prior)
    expect(historyText.map(row => row.role)).toEqual(['user', 'assistant', 'user'])
    expect(historyText[2]?.content).toContain('latest label (vault: older.txt)')
    const dispatched = await buildDispatchParts({ text: 'Continue', attachments, history: historyText,
      systemPrompt: '', profileWireBytes: 0, scopeId: 'workspace', readAttachment,
      resolveAttachmentPath: input.resolveAttachmentPath, forcePath: true })
    expect(dispatched.succeeded).toBe(true)
    if (!dispatched.succeeded) throw new Error(dispatched.error)
    expect(dispatched.value.slice(1).map(part => 'url' in part ? part.url : undefined))
      .toEqual(attachments.map(part => pathToFileURL(join(sandbox, part.path)).href))
    // Preserve the apps' existing slice(-0) edge while adopting the shared owner.
    expect(await prepareDispatchAttachments({ ...input, materialize: undefined,
      mentionCount: DISPATCH_MAX_MEDIA_PARTS - current.length })).toEqual(attachments)
    await rm(join(stored, 'older.txt'))
    await expect(prepareDispatchAttachments({ ...input, attachments: [file('older.txt')], historyAttachments: [] }))
      .rejects.toThrow('Attachment missing: older.txt')
    expect(copies).toHaveLength(3)
    await expect(prepareDispatchAttachments({ ...input, attachments: current, historyAttachments: [],
      materialize: { ...input.materialize, upload: (target, bytes) => upload(target, bytes, true) } }))
      .rejects.toThrow('Sandbox attachment size mismatch for current.txt')
  } finally {
    try {
      if (server?.listening) {
        const listener = server
        await new Promise<void>((resolve, reject) => {
          listener.close(error => error ? reject(error) : resolve())
          listener.closeAllConnections()
        })
      }
    } finally {
      try { closeDatabase?.() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
}, 15_000)

it('copies a carried file only when the box lacks it or holds a different size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-present-'))
  try {
    const stored = join(directory, 'stored', 'workspace')
    const box = join(directory, 'box')
    await mkdir(stored, { recursive: true })
    await mkdir(box)
    const names = ['first.txt', 'second.txt']
    for (const name of names) await writeFile(join(stored, name), `bytes:${name}`)
    const reads: string[] = []
    const uploads: string[] = []
    const part = (name: string) => ({ type: 'file' as const, path: name, name, size: `bytes:${name}`.length })
    const input = {
      attachments: [] as ReturnType<typeof part>[],
      historyAttachments: names.map(part),
      scopeId: 'workspace',
      resolveAttachmentPath: (path: string) => join(box, path),
      readAttachment: (async (scope, path) => {
        reads.push(path)
        const bytes = await readFile(join(directory, 'stored', scope, path))
        return { ok: true, size: bytes.length, bytes }
      }) satisfies ReadAttachmentFn,
      materialize: {
        missingBytesMessage: (path: string) => `Bytes unavailable: ${path}`,
        upload: async (target: string, bytes: Uint8Array) => {
          uploads.push(basename(target))
          await writeFile(target, bytes)
          return { size: (await stat(target)).size }
        },
        present: async (targets: readonly string[]) => {
          const sizes = new Map<string, number>()
          for (const target of targets) {
            try { sizes.set(target, (await stat(target)).size) } catch { /* absent */ }
          }
          return sizes
        },
      },
    }
    await prepareDispatchAttachments(input)
    expect(uploads).toEqual(names)
    // The next turns carry the same files: nothing is read or copied again.
    await prepareDispatchAttachments(input)
    await prepareDispatchAttachments(input)
    expect(reads).toEqual(names)
    expect(uploads).toEqual(names)
    // A removed or truncated box file is restored once.
    await rm(join(box, 'first.txt'))
    await writeFile(join(box, 'second.txt'), 'x')
    await prepareDispatchAttachments(input)
    expect(uploads).toEqual([...names, ...names])
    for (const name of names) expect(await readFile(join(box, name), 'utf8')).toBe(`bytes:${name}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
