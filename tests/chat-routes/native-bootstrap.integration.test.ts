import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { noticePart } from '../../src/interactions/contract'
import { runNativeCompletionWorkflow } from '../../src/preset-cloudflare/native-completion-workflow'
import { createAssistantDraftWriter } from '../../src/chat-routes/draft-persistence'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import { observeNativeCompletion, type NativeCompletionAdmissionStore } from '../../src/chat-routes/native-completion'
import { createBufferedTurnTap, createMemoryTurnEventStore } from '../../src/stream/turn-buffer'
import { openDatabase } from '../teams/db-helper'

const sessionId = 'native-session'
const turnId = 'native-turn'
const threadId = 'member-thread'
const diskCause = 'MCP bootstrap failed: stderr: npm TAR_ENTRY_ERROR ENOSPC; token=fixture-private-value'
const publicDiskCause = 'The Sandbox ran out of disk space before the execution finished.'

type Case = {
  name: string
  status?: 'failed' | 'cancelled'
  assistant?: 'one' | 'ambiguous' | 'unmarked'
  error?: string
  resultId?: string
  ledgerSessionId?: string
  malformedLedger?: boolean
  transportFailure?: boolean
  eventCount?: number
  expected: 'failed' | 'running' | 'throw'
  publicCause?: string
}

/**
 * Replay a native wire record over real loopback HTTP. The official SDK owns
 * validation, execution-scoped SSE parsing and result assembly. No SDK method,
 * clock, fetch, observer or buffer implementation is replaced. This is not a
 * live sandbox/model proof; it exercises terminal replay and the member route.
 */
async function boundary(test: Case) {
  const status = test.status ?? 'failed'
  const requests: Array<{ method: string; path: string }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    requests.push({ method: request.method!, path: url.pathname })
    const json = (value: unknown, code = 200) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (request.method !== 'GET') return json({ error: 'Observation must never admit, cancel or mutate native work' }, 405)
    if (url.pathname === '/v1/sandboxes/fixture-box') return json({
      id: 'fixture-box', status: 'running', filesystemIncarnationId: 'fixture-incarnation',
      filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
    })
    const path = url.pathname.replace('/v1/sandboxes/fixture-box/runtime', '')
    if (path === `/agents/sessions/${sessionId}`) return json({ id: sessionId, status, latestExecutionId: 'unrelated-later-turn' })
    if (path === `/agents/sessions/${sessionId}/runs`) return json({ success: true, executions: [{
      executionId: turnId, sessionId: test.ledgerSessionId ?? sessionId, status,
      startedAt: 1, completedAt: 2, eventCount: test.eventCount ?? 6,
      ...(test.malformedLedger ? {} : { lastEventId: '1066' }),
    }] })
    if (path === '/messages') {
      if (url.searchParams.get('sessionId') !== sessionId) return json({ error: 'wrong session' }, 400)
      const count = test.assistant === 'ambiguous' ? 2 : test.assistant ? 1 : 0
      return json(Array.from({ length: count }, (_, index) => ({
        info: { id: `assistant-${index}`, role: 'assistant', timestamp: new Date().toISOString(),
          metadata: { turnId, ...(test.assistant === 'unmarked' ? {} : { interrupted: true }), interruptReason: 'Interrupted' } },
        parts: [{ type: 'text', text: 'Exact partial answer.' }],
      })))
    }
    if (path === `/agents/run/${turnId}/events`) {
      if (url.searchParams.get('sessionId') !== sessionId) return json({ error: 'wrong session' }, 400)
      if (test.transportFailure) return json({ error: 'retained event transport unavailable' }, 503)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // A terminal done frame can carry a contradictory id. The SDK returns
      // that id; the observer must not accept it as the admitted execution.
      const event = { type: 'done', sessionId, executionId: turnId, data: {
        executionId: test.resultId ?? turnId, success: false, status: status === 'cancelled' ? 'cancelled' : 'error',
        error: test.error ?? diskCause,
      } }
      return response.end(`id: 1066\nevent: done\ndata: ${JSON.stringify(event)}\n\n`)
    }
    return json({ error: `Unexpected read: ${path}` }, 404)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const tables = createChatTables()
  const db = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(db as unknown as ChatDatabase, tables)
  await store.createThread({ id: threadId, workspaceId: 'member-workspace' })
  db.$client.exec('CREATE TABLE native_admission (execution_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)')
  const registeredAt = Date.now()
  db.$client.prepare('INSERT INTO native_admission VALUES (?, ?)').run(turnId, JSON.stringify({
    executionId: turnId, state: 'closed', admittedTurnIds: [turnId], ownerLeaseUntil: registeredAt,
    closedAt: registeredAt,
  }))
  const admissions: NativeCompletionAdmissionStore = {
    async read(id) {
      const row = db.$client.prepare('SELECT receipt FROM native_admission WHERE execution_id = ?').get(id) as { receipt: string } | undefined
      return row ? JSON.parse(row.receipt) : null
    },
    async renew(id) { return this.read(id) },
    async closeExpired(id) { return this.read(id) },
  }
  db.$client.exec("CREATE TABLE native_turn_lock (turn_id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE native_settlement (turn_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)")
  db.$client.prepare('INSERT INTO native_turn_lock VALUES (?, ?)').run(turnId, 'held')
  const turnStore = createMemoryTurnEventStore()
  await turnStore.setStatus(turnId, 'running', threadId)
  const routes = createChatTurnRoutes({ projectId: 'terminal-boundary', store, turnStore,
    async authorize({ request }) {
      return request.headers.get('authorization') === 'Bearer member-fixture'
        ? { ok: true, tenantId: 'member-workspace', userId: 'member-user', context: undefined }
        : { ok: false, response: new Response(null, { status: 401 }) }
    },
    produce() { throw new Error('A replay route must not produce a model turn') },
  })
  try {
    const box = await new Sandbox({ apiKey: 'local-fixture', baseUrl }).get('fixture-box')
    if (!box) throw new Error('Fixture box missing')
    const observe = () => observeNativeCompletion({ source: box, admissionStore: admissions,
      executionId: turnId, sessionId, turnId, registeredAt, now: registeredAt + 1_000 })
    if (test.expected === 'throw') {
      await expect(observe()).rejects.toThrow()
    } else if (test.expected === 'running') {
      expect(await observe()).toEqual({ state: 'running' })
    } else {
      const steps: string[] = []
      const receipt = await runNativeCompletionWorkflow({
        event: { payload: { sessionId, turnId, registeredAt } },
        step: {
          async do(_name, callback) { steps.push(_name); return callback(undefined) },
          async sleep() { throw new Error('An exact terminal must settle without a poll sleep') },
        },
        observe,
        async persistTranscript(_payload, receipt) {
          const writer = createAssistantDraftWriter({ store, threadId,
            messageId: `assistant:${turnId}`, snapshot: () => null })
          await writer.finalize({ content: receipt.text,
            parts: [...receipt.parts, noticePart('error', 'native-failure', receipt.error!, 'native_completion_failed')] })
          return `assistant:${turnId}`
        },
        async settle(_payload, receipt) {
          db.$client.prepare('INSERT INTO native_settlement VALUES (?, ?)').run(turnId, JSON.stringify(receipt))
        },
        async finalizeBuffer(_payload, receipt) {
          const tap = createBufferedTurnTap({ turnId, scopeId: threadId, store: turnStore })
          await tap.onEvent({ type: 'error', code: 'native_completion_failed', message: receipt.error })
          await tap.done('error')
        },
        async releaseLock() {
          expect(db.$client.prepare("UPDATE native_turn_lock SET state = 'released' WHERE turn_id = ? AND state = 'held'").run(turnId).changes).toBe(1)
        },
      })
      expect(receipt.state).toBe('failed')
      expect(receipt.completedTurnIds).toEqual([turnId])
      expect(receipt.usage).toEqual({})
      expect(steps).toContain('native-completion:finalize-buffer')
      expect(steps.at(-1)).toBe('native-completion:release-lock')
      expect(db.$client.prepare('SELECT state FROM native_turn_lock WHERE turn_id = ?').get(turnId)).toEqual({ state: 'released' })
      expect(db.$client.prepare('SELECT count(*) AS count FROM native_settlement').get()).toEqual({ count: 1 })
      const response = await routes.replay(new Request('http://local/chat/replay', {
        headers: { authorization: 'Bearer member-fixture' },
      }), { turnId })
      const publicBody = await response.text()
      expect(publicBody).toContain(test.publicCause ?? publicDiskCause)
      expect(publicBody).not.toContain('fixture-private-value')
      expect(publicBody).not.toContain('stderr:')
      expect(publicBody).not.toContain('/private/runtime/path')
      expect(await turnStore.getStatus(turnId)).toBe('error')
      expect(await turnStore.listRunning!(threadId)).toEqual([])
      const transcript = await store.listMessages(threadId)
      expect(transcript).toHaveLength(1)
      expect(transcript[0]!.content).toBe(test.assistant === 'one' ? 'Exact partial answer.' : '')
      expect(JSON.stringify(transcript)).not.toContain('fixture-private-value')
      expect(JSON.stringify(transcript[0]!.parts)).toContain(test.publicCause ?? publicDiskCause)
    }
    if (test.expected !== 'failed') {
      expect(await turnStore.getStatus(turnId)).toBe('running')
      expect(await turnStore.read(turnId, 0)).toEqual([])
      expect(await store.listMessages(threadId)).toEqual([])
      expect(db.$client.prepare('SELECT state FROM native_turn_lock WHERE turn_id = ?').get(turnId)).toEqual({ state: 'held' })
    }
    expect((await routes.replay(new Request('http://local/chat/replay'), { turnId })).status).toBe(401)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(requests.some(request => request.path.includes('/unrelated-later-turn/'))).toBe(false)
    if (test.expected === 'failed') expect(requests.some(request => request.path.includes(`/run/${turnId}/events`))).toBe(true)
  } finally {
    db.$client.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('native terminal replay reaches the authorized public boundary', () => {
  for (const test of [
    { name: 'bootstrap failure with no assistant settles on its first observation', expected: 'failed' },
    { name: 'ordinary interrupted assistant keeps its exact partial answer', assistant: 'one', expected: 'failed' },
    { name: 'cancelled native execution remains failed rather than completed', status: 'cancelled', error: 'Native execution was cancelled.', publicCause: 'Native Sandbox execution was cancelled.', expected: 'failed' },
    { name: 'unknown credentials and paths remain opaque without stderr', error: 'Refused /private/runtime/path; token=fixture-private-value', publicCause: 'Native Sandbox execution failed before producing an answer.', expected: 'failed' },
    { name: 'unknown credentials and paths remain opaque with stderr', error: '/private/runtime/path token=fixture-private-value; stderr: secret diagnostics', publicCause: 'Native Sandbox execution failed before producing an answer.', expected: 'failed' },
    { name: 'recognized bootstrap startup reports a fixed safe cause', error: 'MCP runtime bootstrap failed: /private/runtime/path token=fixture-private-value', publicCause: 'The Sandbox could not start the agent runtime.', expected: 'failed' },
    { name: 'mismatched terminal execution id cannot settle this admission', resultId: 'foreign-turn', expected: 'running' },
    { name: 'foreign ledger session is rejected by the SDK without finalization', ledgerSessionId: 'foreign-session', expected: 'throw' },
    { name: 'malformed native ledger remains retryable', malformedLedger: true, expected: 'throw' },
    { name: 'ambiguous assistant records stay unfinalized', assistant: 'ambiguous', expected: 'running' },
    { name: 'an unmarked assistant is not misclassified as pre-assistant bootstrap', assistant: 'unmarked', expected: 'running' },
    { name: 'event transport errors remain retryable and cannot publish a terminal', transportFailure: true, expected: 'throw' },
    { name: 'a large native replay stays bounded', eventCount: 2_001, expected: 'running' },
  ] satisfies Case[]) it(test.name, () => boundary(test), 30_000)
})
