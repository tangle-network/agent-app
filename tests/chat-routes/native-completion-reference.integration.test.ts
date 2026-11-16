import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { toChatMessageParts } from '../../src/chat-store/parts'
import { createAssistantDraftWriter } from '../../src/chat-routes/draft-persistence'
import { promoteAgentFilePart, type RawAgentFilePart } from '../../src/chat-routes/promote-file-part'
import { NATIVE_COMPLETION_RECEIPT_MAX_BYTES, observeNativeCompletion, type NativeCompletionReceipt } from '../../src/chat-routes/native-completion'
import { runNativeCompletionWorkflow } from '../../src/preset-cloudflare/native-completion-workflow'
import type { CloudflareWorkflowStepLike } from '../../src/preset-cloudflare/detached-turn-workflow'
import { openDatabase } from '../teams/db-helper'

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
const payload = { sessionId: 'native-session', turnId: 'native-turn', registeredAt: 1 }
const messageId = 'assistant:native-turn'
const text = '"\\\u0000😀'.repeat(35_000)
const file = Buffer.alloc(1024 * 1024, 0x61)
const interaction = { type: 'interaction', id: 'question-1', kind: 'question', title: 'Proceed?',
  answerSpec: { fields: [{ id: 'answer', type: 'text', label: 'Answer' }] }, status: 'answered', answers: { answer: 'approved' } }

/** Actual SDK HTTP reads, artifact promotion, chat-store writes and SQL-replayed
 * Workflow checkpoints. The fixture enforces the non-stream checkpoint budget
 * and the D1 row byte limit; neither native methods nor projection owners are mocked. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'native-reference-'))
  let sqlite = new Database(join(directory, 'steps.sqlite'))
  sqlite.exec('CREATE TABLE checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE effects (name TEXT PRIMARY KEY);')
  const tables = createChatTables()
  const db = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(db as unknown as ChatDatabase, tables)
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  let native: 'available' | 'missing' | 'failed' | 'changed' | 'reordered' = 'available'
  let failSettlement = true
  let failPromotion = false
  let observeCalls = 0
  let readCalls = 0
  let preparations = 0
  const requests: string[] = []
  const persisted: NativeCompletionReceipt[] = []
  const delivered: NativeCompletionReceipt[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    requests.push(`${request.method} ${url.pathname}`)
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (request.method !== 'GET') return json({ error: 'Native replay cannot dispatch or cancel' }, 405)
    if (url.pathname === '/v1/sandboxes/fixture-box') return json({ id: 'fixture-box', status: 'running',
      filesystemIncarnationId: 'fixture-incarnation', filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready' })
    const path = url.pathname.replace('/v1/sandboxes/fixture-box/runtime', '')
    if (path === `/agents/sessions/${payload.sessionId}`) return json({ id: payload.sessionId, status: 'completed' })
    if (path === `/agents/sessions/${payload.sessionId}/runs`) return json({ success: true, executions: [{
      executionId: payload.turnId, sessionId: payload.sessionId, status: 'completed', startedAt: 1, completedAt: 2, eventCount: 1, lastEventId: '1',
    }] })
    if (path === '/messages') return native === 'failed' ? json({ error: 'unavailable' }, 503) : json([])
    if (path === '/messages/turns') {
      if (native === 'failed') return json({ error: 'unavailable' }, 503)
      if (native === 'missing') return json(null, 404)
      if (url.searchParams.get('sessionId') !== payload.sessionId || url.searchParams.get('turnId') !== payload.turnId) return json({ error: 'Wrong native identity' }, 400)
      const content = native === 'changed' ? `${text}changed` : text
      const nativeFile = { type: 'file', id: 'file-1', filename: 'report.bin', mime: 'application/octet-stream', url: `data:application/octet-stream;base64,${file.toString('base64')}` }
      return json({ turnId: payload.turnId, sessionId: payload.sessionId, completedAt: '2026-11-16T00:00:00Z', result: {
        text: content, parts: [
          { type: 'text', id: 'text-1', text: content },
          native === 'reordered' ? Object.fromEntries(Object.entries(nativeFile).reverse()) : nativeFile,
          interaction,
        ], usage: { inputTokens: 20, outputTokens: 40 }, effectiveBackend: { model: 'native-model', provider: 'native-provider', source: 'profile' },
      } })
    }
    return json({ error: `Unexpected native read ${path}` }, 404)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const box = await new Sandbox({ apiKey: 'local-fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }).get('fixture-box')
  if (!box) throw new Error('Fixture box missing')
  const read = async () => {
    const observation = await observeNativeCompletion({ source: box, ...payload, executionId: payload.turnId, now: 700_000,
      admissionStore: {
        async read() { return { executionId: payload.turnId, state: 'closed', admittedTurnIds: [payload.turnId], ownerLeaseUntil: 0, closedAt: 1 } },
        async renew() { throw new Error('A native reference cannot renew an admission') },
        async closeExpired() { throw new Error('A native reference cannot close an admission') },
      } })
    if (observation.state === 'running') return null
    // GTM adds this exact native proof to the shared observer's receipt. It is
    // checkpoint metadata, independent of the product's mutable transcript.
    return { ...observation.receipt, nativeExecutionProof: { executionId: payload.turnId, sessionId: payload.sessionId, turnIds: [payload.turnId] } }
  }
  const steps: CloudflareWorkflowStepLike = {
    async do<T>(name: string, callback: (context: unknown) => Promise<T>) {
      const cached = sqlite.prepare('SELECT value FROM checkpoints WHERE name = ?').get(name) as { value: string } | undefined
      if (cached) return JSON.parse(cached.value).value as T
      const value = await callback(undefined)
      const serialized = JSON.stringify({ value })
      expect(encoder.encode(serialized).byteLength, `Checkpoint ${name}`).toBeLessThanOrEqual(NATIVE_COMPLETION_RECEIPT_MAX_BYTES)
      sqlite.prepare('INSERT INTO checkpoints VALUES (?, ?)').run(name, serialized)
      return JSON.parse(serialized).value as T
    },
    async sleep() { throw new Error('An exact retained receipt must not poll') },
  }
  const run = () => runNativeCompletionWorkflow({ event: { payload }, step: steps,
    async observe() {
      observeCalls++
      const receipt = await read()
      if (!receipt) throw new Error('Native receipt absent')
      return { state: receipt.state, receipt }
    },
    async readReceipt() {
      readCalls++
      const receipt = await read()
      // Fresh optional accounting/proof metadata must not overwrite the exact
      // facts checkpointed earlier, or make byte-identical output unreplayable.
      return receipt && { ...receipt, usage: {}, nativeExecutionProof: undefined,
        parts: native === 'reordered'
          ? receipt.parts.map(part => Object.fromEntries(Object.entries(part).reverse()))
          : receipt.parts,
      }
    },
    async prepare(_payload, receipt) {
      preparations++
      expect(receipt.text).toBe(text)
      expect(receipt.parts).toContainEqual(interaction)
      const parts = []
      for (const part of receipt.parts) {
        if (part.type !== 'file') { parts.push(part); continue }
        const promoted = await promoteAgentFilePart({ raw: part as unknown as RawAgentFilePart,
          scopeId: 'workspace', sessionId: payload.sessionId, now: () => new Date('2026-11-16T00:00:00Z'),
          async writeAttachment(scope, path, content) {
            expect(scope).toBe('workspace')
            if (failPromotion) return { ok: false, reason: 'attachment store unavailable' }
            writeFileSync(join(directory, 'report.bin'), content)
            return { ok: true }
          }, logger: { error() {} },
        })
        if (!promoted.succeeded) throw new Error(promoted.reason)
        parts.push(promoted.part)
      }
      return { ...receipt, parts }
    },
    async persistTranscript(_payload, receipt) {
      // D1's stored text + parts column bytes differ from outer JSON escaping.
      expect(encoder.encode(receipt.text).byteLength + bytes(receipt.parts)).toBeLessThan(2_000_000)
      persisted.push(receipt)
      await createAssistantDraftWriter({ store, threadId: 'thread', messageId, snapshot: () => null }).finalize({
        content: receipt.text, parts: toChatMessageParts(receipt.parts), ...receipt.usage,
      })
      return messageId
    },
    async settle(_payload, receipt, id) {
      expect(id).toBe(messageId)
      delivered.push(receipt)
      await steps.do('product:answer-interaction', async () => {
        const row = await store.getMessage(id)
        expect(row).not.toBeNull()
        await store.updateMessage(id, { parts: toChatMessageParts([...(row!.parts ?? []), { type: 'notice', id: 'settled', noticeKind: 'info', text: 'Stored interaction answer' }]) })
        sqlite.prepare("INSERT INTO effects VALUES ('answered')").run()
      })
      if (failSettlement) throw new Error('settlement dependency unavailable')
      await steps.do('product:charge', async () => { sqlite.prepare("INSERT INTO effects VALUES ('charged')").run() })
    },
    async releaseLock() { sqlite.prepare("INSERT INTO effects VALUES ('released')").run() },
  })
  return {
    run, read, store, persisted, delivered,
    setNative(value: typeof native) { native = value },
    allowSettlement() { failSettlement = false },
    refusePromotion() { failPromotion = true },
    counts: () => ({ observeCalls, readCalls, preparations }),
    reopen() { sqlite.close(); sqlite = new Database(join(directory, 'steps.sqlite')) },
    effects: () => sqlite.prepare('SELECT name FROM effects ORDER BY name').all(),
    checkpointBytes: () => sqlite.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM checkpoints').all() as Array<{ bytes: number }>,
    artifact: () => readFileSync(join(directory, 'report.bin')),
    async close() {
      sqlite.close(); db.$client.close(); server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

describe('large native receipts through the real completion boundaries', () => {
  it('preserves text, files, interactions and proof across checkpoint/reload and a mutable transcript', async () => {
    const test = await fixture()
    try {
      const original = await test.read()
      expect(bytes(original)).toBeGreaterThan(2_000_000)
      await expect(test.run()).rejects.toThrow('settlement dependency unavailable')
      expect(test.effects()).toEqual([{ name: 'answered' }])
      expect(test.artifact()).toEqual(file)
      expect(test.persisted).toHaveLength(1) // Raw inline file never reaches D1.
      test.reopen()
      test.setNative('reordered')
      test.allowSettlement()
      const result = await test.run()
      expect(bytes(result)).toBeLessThanOrEqual(NATIVE_COMPLETION_RECEIPT_MAX_BYTES)
      expect(result).toMatchObject({ state: 'completed', usage: { inputTokens: 20, outputTokens: 40 },
        nativeExecutionProof: original!.nativeExecutionProof,
        transcriptReference: { messageId, omitted: ['text', 'parts'] } })
      expect(test.delivered[1]).toEqual(test.delivered[0])
      expect(test.delivered[1]!.text).toBe(text)
      expect(test.delivered[1]!.parts).toContainEqual(interaction)
      expect(test.persisted).toHaveLength(1) // A cached write cannot undo settlement's transcript update.
      expect((await test.store.getMessage(messageId))!.parts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'settled' })]))
      expect(test.counts()).toEqual({ observeCalls: 1, readCalls: 1, preparations: 2 })
      expect(test.effects()).toEqual([{ name: 'answered' }, { name: 'charged' }, { name: 'released' }])
      expect(test.checkpointBytes().every(row => row.bytes <= NATIVE_COMPLETION_RECEIPT_MAX_BYTES)).toBe(true)
      await test.run()
      expect(test.effects()).toEqual([{ name: 'answered' }, { name: 'charged' }, { name: 'released' }])
    } finally { await test.close() }
  })

  it.each(['missing', 'failed', 'changed'] as const)('keeps %s native references explicit without re-observing or releasing', async native => {
    const test = await fixture()
    try {
      await expect(test.run()).rejects.toThrow('settlement dependency unavailable')
      test.reopen(); test.setNative(native); test.allowSettlement()
      await expect(test.run()).rejects.toThrow(native === 'changed' ? /referenced receipt changed/ : /could not be verified/)
      expect(test.counts()).toEqual({ observeCalls: 1, readCalls: 1, preparations: 1 })
      expect(test.effects()).toEqual([{ name: 'answered' }])
      expect(test.persisted).toHaveLength(1)
    } finally { await test.close() }
  })

  it('retains the native body when artifact promotion fails and records no false terminal effects', async () => {
    const test = await fixture()
    try {
      test.refusePromotion()
      await expect(test.run()).rejects.toThrow('attachment store unavailable')
      expect(test.effects()).toEqual([])
      expect(test.persisted).toEqual([])
      expect((await test.read())!.text).toBe(text)
      expect(test.checkpointBytes().every(row => row.bytes <= NATIVE_COMPLETION_RECEIPT_MAX_BYTES)).toBe(true)
    } finally { await test.close() }
  })
})
