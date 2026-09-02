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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  createSandboxChatProducer,
  normalizeChatPromptForSandbox,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
} from '@tangle-network/agent-app/chat-routes'
import type { ChatDatabase } from '@tangle-network/agent-app/chat-store'
import { PREWARM_CLAIM_TABLE_DDL } from '@tangle-network/agent-app/sandbox'
import {
  createMemoryTurnEventStore,
  TURN_EVENTS_MIGRATION_SQL,
} from '@tangle-network/agent-app/stream'
import {
  sqlApiKeyStoreSchemaStatements,
  sqlGatewayUsageStoreSchemaStatements,
  type SqlAdapter,
} from '@tangle-network/agent-gateway'

import { config } from '../agent.config'
import { buildChatApp, type ChatApp } from '../src/chat'
import type { AppEnv } from '../src/env'
import { buildGatewayApp } from '../src/gateway'
import { appSlug } from '../src/sandbox'
import { createWorker } from '../src/worker'

const BASE = 'http://localhost:8787'
const MODEL = 'test/model-1'

// ── fixtures ────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort()
  .map((name) => join(MIGRATIONS_DIR, name))
const BASE_MIGRATION = join(MIGRATIONS_DIR, '0001_init.sql')
const GATEWAY_MIGRATION = join(MIGRATIONS_DIR, '0002_agent_gateway.sql')

/** The real migration, executed against a real SQLite database. Every query
 *  the test makes afterwards runs over THESE tables — schema drift between
 *  `migrations/` and `src/db/schema.ts` fails here, not in production. */
function openMigratedDb(migrations = MIGRATIONS): {
  db: ChatDatabase
  sql: SqlAdapter
  applyMigration(path: string): void
} {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const migration of migrations) sqlite.exec(readFileSync(migration, 'utf8'))
  // better-sqlite3's sync drizzle handle narrows the driver generic; the store
  // treats sync and async drivers identically (builders are awaited).
  return {
    db: drizzle(sqlite) as unknown as ChatDatabase,
    sql: {
      async exec(statement, params = []) {
        return { rowsAffected: sqlite.prepare(statement).run(...params).changes }
      },
      async query<TRow>(statement: string, params: readonly unknown[] = []) {
        return sqlite.prepare(statement).all(...params) as TRow[]
      },
    },
    applyMigration(path) {
      sqlite.exec(readFileSync(path, 'utf8'))
    },
  }
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
  workerFetch(request: Request): Promise<Response>
  sql: SqlAdapter
  cookie: string
  gatewayBuilds(): number
  settle(): Promise<unknown>
}

async function createHarness(
  produce: (args: ChatTurnProduceArgs<void>) => ChatTurnRouteProducer = () =>
    createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL }),
): Promise<Harness> {
  const database = openMigratedDb()
  const pending: Promise<unknown>[] = []
  let gatewayBuildCount = 0
  const chatOverrides = {
    db: database.db,
    turnStore: createMemoryTurnEventStore(),
    produce,
    uploadSink: async () => null,
  }
  const app = buildChatApp(env, {
    ...chatOverrides,
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

  const originalTurn = app.routes.turn
  app.routes.turn = (request) =>
    originalTurn(request, { waitUntil: (p) => void pending.push(p) })
  const worker = createWorker({
    buildChatApp: () => app,
    buildGatewayApp: (_env, chatApp, options) => {
      gatewayBuildCount += 1
      return buildGatewayApp(env, chatApp, {
        ...options,
        sql: database.sql,
        createTrustedChatApp: (ownerId) => buildChatApp(env, {
          ...chatOverrides,
          trustedUserId: ownerId,
        }),
      })
    },
  })
  const executionContext = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  } as ExecutionContext
  const workerHandler = worker.fetch
  if (!workerHandler) throw new Error('Generated Worker has no fetch handler')
  return {
    app,
    workerFetch: async (request) => workerHandler(
      request as Parameters<typeof workerHandler>[0],
      env,
      executionContext,
    ),
    sql: database.sql,
    cookie,
    gatewayBuilds: () => gatewayBuildCount,
    settle: () => Promise.all(pending),
  }
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

async function readGatewayText(response: Response): Promise<string> {
  const body = await response.text()
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as {
      choices?: Array<{ delta?: { content?: string } }>
      error?: { message?: string }
    })
    .map((frame) => {
      if (frame.error) throw new Error(frame.error.message ?? 'gateway stream failed')
      return frame.choices?.[0]?.delta?.content ?? ''
    })
    .join('')
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('e2e: fake sandbox producer → streamed turn → persisted transcript', () => {
  it('normalizes path-backed generic files for the sandbox prompt API', () => {
    expect(
      normalizeChatPromptForSandbox([
        { type: 'text', text: 'Read this' },
        {
          type: 'file',
          filename: 'lease terms.pdf',
          mediaType: 'application/pdf',
          path: '/workspace/uploads/lease terms.pdf',
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'Read this' },
      {
        type: 'file',
        filename: 'lease terms.pdf',
        mediaType: 'application/pdf',
        url: 'file:///workspace/uploads/lease%20terms.pdf',
      },
    ])
  })

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
      expect.objectContaining({
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 40, completionTokens: 20 }),
      }),
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
    expect(assistant.requestedModel).toBe(MODEL)
    expect(assistant.servedModel).toBeNull()
    expect(assistant.servedProvider).toBeNull()
    expect(assistant.servedSource).toBeNull()
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
    expect(normalize(readFileSync(BASE_MIGRATION, 'utf8'))).toContain(normalize(TURN_EVENTS_MIGRATION_SQL))
  })

  it('the migration carries the fenced sandbox claim table, verbatim', () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').replace(/;$/, '').trim()
    expect(normalize(readFileSync(BASE_MIGRATION, 'utf8'))).toContain(normalize(PREWARM_CLAIM_TABLE_DDL))
  })

  it('the migration carries every agent-gateway SQL store statement', () => {
    const migration = readFileSync(GATEWAY_MIGRATION, 'utf8')
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').replace(/;$/, '').trim()
    const statements = [
      ...sqlApiKeyStoreSchemaStatements(),
      ...sqlGatewayUsageStoreSchemaStatements(),
    ]

    for (const statement of statements) {
      expect(normalize(migration)).toContain(normalize(statement))
    }
  })

  it('upgrades a database that already applied the original chat migration', async () => {
    const migrated = openMigratedDb([BASE_MIGRATION])
    const tableNames = async () => (await migrated.sql.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%' ORDER BY name",
    )).map((row) => row.name)

    expect(await tableNames()).toEqual([])
    migrated.applyMigration(GATEWAY_MIGRATION)
    expect(await tableNames()).toEqual([
      'agent_api_key',
      'agent_api_key_request',
      'agent_api_key_usage',
      'agent_gateway_usage',
    ])
  })

  it('shares one owned thread across OpenAI-compatible API calls', async () => {
    const { app, workerFetch, sql, cookie, gatewayBuilds, settle } = await createHarness()
    const cardResponse = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/.well-known/agent.json`,
    ))
    expect(cardResponse.status).toBe(404)

    const keyResponse = await workerFetch(post('/api/keys', cookie, {
      name: 'coding agent',
      rateLimit: 2,
      dailyLimit: 2,
    }))
    expect(keyResponse.status).toBe(201)
    const { key } = (await keyResponse.json()) as { key: string }

    const openAiResponse = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'File my lease summary' }],
          stream: true,
        }),
      },
    ))
    expect(openAiResponse.status).toBe(200)
    const threadId = openAiResponse.headers.get('X-Tangle-Thread-Id')
    expect(threadId).toBeTruthy()
    expect(openAiResponse.headers.get('X-Tangle-Thread-Url')).toBe(
      `${BASE}/?threadId=${encodeURIComponent(threadId!)}`,
    )
    expect(await readGatewayText(openAiResponse)).toBe('Filed the summary.')
    await settle()

    const thread = await app.store.getThread(threadId!)
    expect(thread).toMatchObject({ id: threadId, workspaceId: expect.any(String) })
    expect(await app.store.listMessages(threadId!)).toHaveLength(2)
    expect(await sql.query(`
      SELECT input_tokens, output_tokens, reasoning_tokens, tool_tokens,
        tool_call_count, provider_cost_nanodollars, total_cost_nanodollars,
        settlement_basis
      FROM agent_gateway_usage
    `)).toEqual([{
      input_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 5,
      tool_tokens: 0,
      tool_call_count: 1,
      provider_cost_nanodollars: 12_300_000,
      total_cost_nanodollars: 12_300_000,
      settlement_basis: 'usage-receipt',
    }])
    expect(await sql.query('SELECT request_id FROM agent_api_key_usage')).toHaveLength(1)
    expect(await sql.query('SELECT request_id FROM agent_api_key_request')).toHaveLength(1)

    const continuedResponse = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Tangle-Thread-Id': threadId!,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Continue the same work' }],
          stream: true,
        }),
      },
    ))
    expect(continuedResponse.status).toBe(200)
    expect(continuedResponse.headers.get('X-Tangle-Thread-Id')).toBe(threadId)
    expect(await readGatewayText(continuedResponse)).toBe('Filed the summary.')
    await settle()
    expect(await app.store.listMessages(threadId!)).toHaveLength(4)
    expect(await sql.query('SELECT request_id FROM agent_api_key_request')).toHaveLength(2)
    expect(await sql.query('SELECT request_id FROM agent_gateway_usage')).toHaveLength(2)
    expect(await sql.query('SELECT request_id FROM agent_api_key_usage')).toHaveLength(2)

    await app.store.createThread({
      id: 'another-users-thread',
      workspaceId: 'another-user',
      title: 'Private',
    })
    const probeKeyResponse = await workerFetch(post('/api/keys', cookie, {
      name: 'thread probe',
      rateLimit: 1,
      dailyLimit: 1,
    }))
    expect(probeKeyResponse.status).toBe(201)
    const { key: probeKey } = (await probeKeyResponse.json()) as { key: string }
    const denied = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${probeKey}`,
          'Content-Type': 'application/json',
          'X-Tangle-Thread-Id': 'another-users-thread',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Open it' }] }),
      },
    ))
    expect(denied.status).toBe(403)
    expect(await sql.query('SELECT request_id FROM agent_api_key_request')).toHaveLength(2)

    const rateLimited = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'This third turn must not run' }],
          stream: true,
        }),
      },
    ))
    expect(rateLimited.status).toBe(429)
    expect(await app.store.listMessages(threadId!)).toHaveLength(4)
    expect(await sql.query('SELECT request_id FROM agent_api_key_request')).toHaveLength(2)
    expect(gatewayBuilds()).toBe(6)
  })

  it('finishes the linked browser transcript after the API client disconnects', async () => {
    let releaseTurn = () => {}
    const canFinish = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    async function* delayedEvents(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'message.part.updated',
        data: {
          part: { type: 'text', id: 'answer', text: 'Started. ' },
          delta: 'Started. ',
        },
      }
      await canFinish
      yield {
        type: 'message.part.updated',
        data: {
          part: { type: 'text', id: 'answer', text: 'Started. Finished.' },
          delta: 'Finished.',
        },
      }
      yield {
        type: 'message.part.updated',
        data: {
          part: {
            type: 'step-finish',
            reason: 'stop',
            tokens: { input: 7, output: 3, reasoning: 1 },
            cost: 0.00021,
          },
        },
      }
      yield { type: 'result', data: { finalText: 'Started. Finished.' } }
    }
    const { app, workerFetch, sql, cookie, settle } = await createHarness(() =>
      createSandboxChatProducer({ events: delayedEvents(), model: MODEL }))
    const keyResponse = await workerFetch(post('/api/keys', cookie, {
      name: 'disconnect test',
      rateLimit: 1,
      dailyLimit: 1,
    }))
    const { key } = (await keyResponse.json()) as { key: string }

    const response = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Complete this after I leave' }],
          stream: true,
        }),
      },
    ))
    expect(response.status).toBe(200)
    const threadId = response.headers.get('X-Tangle-Thread-Id')
    expect(response.headers.get('X-Tangle-Thread-Url')).toBe(
      `${BASE}/?threadId=${encodeURIComponent(threadId!)}`,
    )

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let visible = ''
    while (!visible.includes('Started.')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Gateway stream ended before its first answer text')
      visible += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()

    const runningResponse = await app.routes.running(new Request(
      `${BASE}/api/chat/running?threadId=${encodeURIComponent(threadId!)}`,
      { headers: { cookie } },
    ))
    expect(runningResponse.status).toBe(200)
    const { running } = (await runningResponse.json()) as { running: string[] }
    expect(running).toHaveLength(1)
    const replay = await app.routes.replay(
      new Request(`${BASE}/api/chat/replay/${running[0]}?fromSeq=0`, { headers: { cookie } }),
      { turnId: running[0]! },
    )
    const replayLines = readLines(replay)

    releaseTurn()
    await settle()

    const messages = await app.store.listMessages(threadId!)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Started. Finished.' })
    const events = eventsOf(await replayLines)
    expect(events.filter((event) => event.type === 'text').map((event) => event.text).join(''))
      .toBe('Started. Finished.')
    expect(events.at(-1)).toMatchObject({ type: 'turn_status', status: 'complete' })
    expect(await sql.query(`
      SELECT input_tokens, output_tokens, reasoning_tokens, provider_cost_nanodollars
      FROM agent_gateway_usage
    `)).toEqual([{
      input_tokens: 7,
      output_tokens: 3,
      reasoning_tokens: 1,
      provider_cost_nanodollars: 210_000,
    }])
    expect(await sql.query('SELECT request_id FROM agent_api_key_usage')).toHaveLength(1)
  })

  it('passes the complete provider budget into the shared chat turn', async () => {
    let receivedLimits: ChatTurnProduceArgs<void>['executionLimits']
    const { workerFetch, cookie, settle } = await createHarness((args) => {
      receivedLimits = args.executionLimits
      return createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL })
    })
    const keyResponse = await workerFetch(post('/api/keys', cookie, {
      name: 'budget test',
      rateLimit: 1,
      dailyLimit: 1,
    }))
    const { key } = (await keyResponse.json()) as { key: string }

    const response = await workerFetch(new Request(
      `${BASE}/v1/agents/${appSlug}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Use the bounded path' }],
          max_tokens: 321,
          stream: true,
        }),
      },
    ))

    expect(response.status).toBe(200)
    await readGatewayText(response)
    await settle()
    expect(receivedLimits).toMatchObject({
      maxInputTokens: config.gateway.maxProviderInputTokens,
      maxOutputTokens: 321,
      maxReasoningTokens: 321,
      maxToolTokens: 321,
      maxToolCalls: 8,
    })
    expect(receivedLimits?.maxProviderCostUsd).toBeGreaterThan(0)
  })

  it('does not mount API-key or agent routes when the gateway is disabled', async () => {
    const database = openMigratedDb()
    const app = buildChatApp(env, {
      db: database.db,
      turnStore: createMemoryTurnEventStore(),
      produce: () => createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL }),
    })
    const worker = createWorker({
      buildChatApp: () => app,
      buildGatewayApp: (_env, chatApp) => buildGatewayApp(env, chatApp, { sql: database.sql }),
      gatewayEnabled: false,
    })
    const fetch = worker.fetch
    if (!fetch) throw new Error('Generated Worker has no fetch handler')
    const context = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext

    const [keys, agents] = await Promise.all([
      fetch(new Request(`${BASE}/api/keys`), env, context),
      fetch(new Request(`${BASE}/v1/agents/${appSlug}/.well-known/agent.json`), env, context),
    ])
    expect(keys.status).toBe(404)
    expect(agents.status).toBe(404)
  })

  it('agent.config carries a real system prompt (prompts/system.md is wired)', () => {
    expect(config.systemPrompt.length).toBeGreaterThan(0)
    expect(config.name.length).toBeGreaterThan(0)
  })
})
