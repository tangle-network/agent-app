/**
 * The e2e gate this app ships with: the REAL assembly (`buildChatApp` — auth,
 * store, turn routes, upload, replay) driven end to end against the REAL
 * migration, with exactly one fake at the outermost seam — the sandbox event
 * feed. `createSandboxChatProducer` (the real bridge) consumes canonical
 * sidecar events a live box would emit, so everything below the fake is
 * production code:
 *
 *   sign-up (better-auth drizzle adapter over the migrated tables)
 *   → create thread → upload a file (inline `data:` part)
 *   → POST /api/chat with content + parts → consume the NDJSON stream
 *   → user + assistant rows persisted with typed parts + usage receipt
 *   → replay the buffered turn after the live stream is gone.
 *
 * If this file fails after an edit, the app has drifted from the framework
 * contract (or the migration from the schema). Fix the drift, not the test.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  createSandboxChatProducer,
  type ChatTurnRouteProducer,
} from '@tangle-network/agent-app/chat-routes'
import type { ChatDatabase } from '@tangle-network/agent-app/chat-store'
import {
  createMemoryTurnEventStore,
  TURN_EVENTS_MIGRATION_SQL,
} from '@tangle-network/agent-app/stream'

import { config } from '../agent.config'
import { buildChatApp, type ChatApp } from '../src/chat'
import type { AppEnv } from '../src/env'

const BASE = 'http://localhost:8787'
const MODEL = 'test/model-1'

// ── fixtures ────────────────────────────────────────────────────────────────

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0001_init.sql')

/** The real migration, executed against a real SQLite database. Every query
 *  the test makes afterwards runs over THESE tables — schema drift between
 *  `migrations/` and `src/db/schema.ts` fails here, not in production. */
function openMigratedDb(): ChatDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(readFileSync(MIGRATION, 'utf8'))
  // better-sqlite3's sync drizzle handle narrows the driver generic; the store
  // treats sync and async drivers identically (builders are awaited).
  return drizzle(sqlite) as unknown as ChatDatabase
}

/** Raw sidecar events, exactly as `streamSandboxPrompt` would yield them from
 *  a live box: reasoning + text deltas, a tool round-trip, the usage receipt,
 *  and the final-text result. */
const RAW_TURN_EVENTS: Array<Record<string, unknown>> = [
  { type: 'message.part.updated', data: { part: { type: 'reasoning', id: 'r1', text: 'checking the records' }, delta: 'checking the records' } },
  { type: 'message.part.updated', data: { part: { type: 'text', id: 't1', text: 'Filed ' }, delta: 'Filed ' } },
  { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'record_search', state: { status: 'running', input: { query: 'lease' } } } } },
  { type: 'message.part.updated', data: { part: { type: 'tool', id: 'call-1', tool: 'record_search', state: { status: 'completed', input: { query: 'lease' }, output: { hits: 2 } } } } },
  { type: 'message.part.updated', data: { part: { type: 'text', id: 't1', text: 'Filed the summary.' }, delta: 'the summary.' } },
  { type: 'message.part.updated', data: { part: { type: 'step-finish', reason: 'stop', tokens: { input: 40, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }, cost: 0.0123 } } },
  { type: 'result', data: { finalText: 'Filed the summary.' } },
]

async function* feed(events: Array<Record<string, unknown>>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

const env: AppEnv = {
  // The DB binding is unused when the test injects its own drizzle handle.
  DB: null as unknown as AppEnv['DB'],
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: 'e2e-test-secret-not-for-production',
}

interface Harness {
  app: ChatApp
  cookie: string
  settle(): Promise<unknown>
}

async function createHarness(
  produce: () => ChatTurnRouteProducer = () =>
    createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL }),
): Promise<Harness> {
  const app = buildChatApp(env, {
    db: openMigratedDb(),
    turnStore: createMemoryTurnEventStore(),
    produce,
    uploadSink: async () => null, // inline uploads only; no box in tests
  })
  // Real sign-up through better-auth; the returned cookie is what a browser
  // would replay on every API call.
  const res = await app.auth.auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'e2e@example.com', password: 'correct-horse-battery', name: 'e2e' }),
    }),
  )
  expect(res.status).toBe(200)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ')

  const pending: Promise<unknown>[] = []
  const originalTurn = app.routes.turn
  app.routes.turn = (request) =>
    originalTurn(request, { waitUntil: (p) => void pending.push(p) })
  return { app, cookie, settle: () => Promise.all(pending) }
}

function post(path: string, cookie: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

async function readLines(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(res.body).text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Flatten the NDJSON line vocabulary (`{kind:'event', event}` wrappers) the
 *  same way web-react's `dispatchChatStreamLine` does. */
function eventsOf(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.map((l) => (l.kind === 'event' ? (l.event as Record<string, unknown>) : l))
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('e2e: fake sandbox producer → streamed turn → persisted transcript', () => {
  it('runs the full multimodal vertical: upload, turn, stream, rows, replay', async () => {
    const { app, cookie, settle } = await createHarness()

    // Thread
    const threadRes = await app.routes.createThread(
      post('/api/threads', cookie, { firstMessage: 'File my lease summary' }),
    )
    expect(threadRes.status).toBe(200)
    const { thread } = (await threadRes.json()) as { thread: { id: string } }

    // Upload → inline `data:` part (≤700 KiB stays in the turn body)
    const form = new FormData()
    form.append('files', new File(['%PDF-1.4 fake'], 'lease.pdf', { type: 'application/pdf' }))
    const uploadRes = await app.upload(
      new Request(`${BASE}/api/chat/upload`, { method: 'POST', headers: { cookie }, body: form }),
    )
    expect(uploadRes.status).toBe(200)
    const { files } = (await uploadRes.json()) as {
      files: Array<{ inline: boolean; part: Record<string, unknown> }>
    }
    expect(files[0]!.inline).toBe(true)
    expect(String(files[0]!.part.url)).toMatch(/^data:application\/pdf;base64,/)

    // Turn: content + the uploaded part, streamed as NDJSON
    const turnRes = await app.routes.turn(
      post('/api/chat', cookie, {
        threadId: thread.id,
        content: 'File my lease summary',
        parts: [files[0]!.part],
      }),
    )
    expect(turnRes.status).toBe(200)
    const lines = await readLines(turnRes)
    const events = eventsOf(lines)

    // The stream announced the replay handle first, then the client vocabulary.
    const turnId = String(lines[0]!.turnId ?? '')
    expect(lines[0]).toMatchObject({ type: 'turn' })
    expect(turnId).toBeTruthy()
    expect(
      events.filter((e) => e.type === 'text').map((e) => String(e.text)).join(''),
    ).toBe('Filed the summary.')
    expect(events.some((e) => e.type === 'reasoning')).toBe(true)
    const toolCall = events.find((e) => e.type === 'tool_call') as
      | { call?: { toolName?: string } }
      | undefined
    expect(toolCall?.call?.toolName).toBe('record_search')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'usage', usage: { promptTokens: 40, completionTokens: 20 } }),
    )
    await settle()

    // A later page load reads back both rows with typed parts + the receipt.
    const transcriptRes = await app.routes.threadMessages(
      new Request(`${BASE}/api/threads/${thread.id}/messages`, { headers: { cookie } }),
      { threadId: thread.id },
    )
    const { messages } = (await transcriptRes.json()) as {
      messages: Array<Record<string, unknown> & { parts?: Array<Record<string, unknown>> }>
    }
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])

    const user = messages[0]!
    expect(user.parts?.some((p) => p.type === 'file' && p.filename === 'lease.pdf')).toBe(true)

    const assistant = messages[1]!
    expect(assistant.content).toBe('Filed the summary.')
    expect(assistant.model).toBe(MODEL)
    expect(assistant.inputTokens).toBe(40)
    expect(assistant.outputTokens).toBe(20)
    expect(assistant.reasoningTokens).toBe(5)
    expect(assistant.costUsd).toBeCloseTo(0.0123)
    expect(assistant.parts?.some((p) => p.type === 'reasoning')).toBe(true)
    const tool = assistant.parts?.find((p) => p.type === 'tool')
    expect(tool).toMatchObject({ tool: 'record_search', state: { status: 'completed' } })
    expect(assistant.parts?.some((p) => p.type === 'step-finish')).toBe(true)

    // The buffered turn replays in full after the live stream is long gone.
    const replayRes = await app.routes.replay(
      new Request(`${BASE}/api/chat/replay/${turnId}?fromSeq=0`, { headers: { cookie } }),
      { turnId },
    )
    const replayEvents = eventsOf(await readLines(replayRes))
    expect(
      replayEvents.filter((e) => e.type === 'text').map((e) => String(e.text)).join(''),
    ).toBe('Filed the summary.')
    expect(replayEvents.at(-1)).toMatchObject({ type: 'turn_status', status: 'complete' })
  })

  it('rejects an unauthenticated turn with the guard 401, before any row is written', async () => {
    const { app, cookie } = await createHarness()
    const threadRes = await app.routes.createThread(post('/api/threads', cookie, { firstMessage: 'seed' }))
    const { thread } = (await threadRes.json()) as { thread: { id: string } }

    const res = await app.routes.turn(post('/api/chat', '', { threadId: thread.id, content: 'hi' }))
    expect(res.status).toBe(401)
    expect(await app.store.listMessages(thread.id)).toEqual([])
  })

  it('the migration carries the turn-buffer DDL the /stream store expects, verbatim', () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
    expect(normalize(readFileSync(MIGRATION, 'utf8'))).toContain(normalize(TURN_EVENTS_MIGRATION_SQL))
  })

  it('agent.config carries a real system prompt (prompts/system.md is wired)', () => {
    expect(config.systemPrompt.length).toBeGreaterThan(0)
    expect(config.name.length).toBeGreaterThan(0)
  })
})
