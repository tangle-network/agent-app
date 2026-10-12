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
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

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

import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '@tangle-network/agent-app/turn-stream'
import type { OperatorTurn } from '@tangle-network/agent-app/operator'
import { TurnStreamDO } from '../src/turn-lock'
import { config } from '../agent.config'
import { buildChatApp, type ChatApp, type ChatAppOverrides } from '../src/chat'
import type { AppEnv } from '../src/env'
import { buildGatewayApp, type GatewayAppOptions } from '../src/gateway'
import { appSlug } from '../src/sandbox'
import { ARTIFACT_ROOT } from '../src/files'
import { createWorker, type WorkerAssembly } from '../src/worker'

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
const RESERVATION_MIGRATION = join(MIGRATIONS_DIR, '0003_gateway_reservations.sql')

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
  setOperatorRunEnabled(enabled: boolean): void
  settle(): Promise<unknown>
}

async function createHarness(
  produce: (args: ChatTurnProduceArgs<void>) => ChatTurnRouteProducer = () =>
    createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL }),
  peekWorkspace?: WorkerAssembly['peekWorkspace'],
  origin = BASE,
  operatorStorage: Pick<GatewayAppOptions, 'files' | 'assets'> = {},
  sidecarConnection?: ChatAppOverrides['sidecarConnection'],
): Promise<Harness> {
  const localEnv: AppEnv = { ...env, BETTER_AUTH_URL: origin, TURN_STREAM: createMemoryTurnStreamHarness((state, secret) => new TurnStreamDO(state, { TURN_STREAM_AUTH_SECRET: secret })).namespace, TURN_STREAM_AUTH_SECRET: MEMORY_TURN_STREAM_AUTH_SECRET }
  const database = openMigratedDb()
  const pending: Promise<unknown>[] = []
  let gatewayBuildCount = 0
  const chatOverrides = {
    ...(sidecarConnection ? { sidecarConnection } : {}),
    db: database.db,
    turnStore: createMemoryTurnEventStore(),
    produce,
    uploadSink: async () => null,
  }
  const app = buildChatApp(localEnv, {
    ...chatOverrides,
    uploadSink: async () => null, // inline uploads only; no box in tests
  })
  // Real sign-up through better-auth; the returned cookie is what a browser
  // would replay on every API call.
  const res = await app.auth.auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
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
    peekWorkspace,
    buildChatApp: () => app,
    buildGatewayApp: (_env, chatApp, options) => {
      gatewayBuildCount += 1
      return buildGatewayApp(localEnv, chatApp, {
        ...options,
        ...operatorStorage,
        sql: database.sql,
        createTrustedChatApp: (ownerId) => buildChatApp(localEnv, {
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
      localEnv,
      executionContext,
    ),
    sql: database.sql,
    cookie,
    gatewayBuilds: () => gatewayBuildCount,
    setOperatorRunEnabled: enabled => { localEnv.OPERATOR_RUN_ENABLED = enabled ? 'true' : 'false' },
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
  it('indexes only owned artifacts through the real authenticated Worker route', async () => {
    expect(config.systemPrompt).toContain(ARTIFACT_ROOT)
    const tree = vi.fn(async () => ({
      root: '/home/agent/artifacts',
      files: [
        { path: '/home/agent/artifacts/report.txt', size: 7 },
        { path: '/home/agent/artifacts/.env', size: 99 },
        { path: '/home/agent/private.txt', size: 99 },
        { path: '../private.txt', size: 99 },
      ],
      stats: { truncated: false },
    }))
    const peek = vi.fn().mockResolvedValue({ status: 'running', box: { fs: { tree } } })
    const h = await createHarness(undefined, peek)
    expect((await h.workerFetch(new Request(`${BASE}/api/files`))).status).toBe(401)
    expect(peek).not.toHaveBeenCalled()
    const denied = await h.workerFetch(new Request(`${BASE}/api/files?workspaceId=another-user`, {
      headers: { cookie: h.cookie },
    }))
    expect(denied.status).toBe(404)
    expect(peek).not.toHaveBeenCalled()
    const response = await h.workerFetch(new Request(`${BASE}/api/files?root=/home/agent`, {
      headers: { cookie: h.cookie },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready', files: [{ path: 'report.txt', name: 'report.txt', size: 7 }] })
    expect(tree).toHaveBeenCalledWith('/home/agent/artifacts', { maxDepth: 12 })
    const session = await h.app.auth.getSession(new Request(BASE, { headers: { cookie: h.cookie } }))
    expect(peek).toHaveBeenCalledWith(expect.anything(), { userId: session!.user.id, workspaceId: session!.user.id })
    peek.mockResolvedValue({ status: 'absent' })
    tree.mockClear()
    const cold = await h.workerFetch(new Request(`${BASE}/api/files`, { headers: { cookie: h.cookie } }))
    expect(await cold.json()).toEqual({ status: 'warming' })
    expect(tree).not.toHaveBeenCalled()
  })

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
    const migration = [GATEWAY_MIGRATION, RESERVATION_MIGRATION]
      .map((path) => readFileSync(path, 'utf8')).join('\n')
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

  it('rejects capped remote execution before starting a chat turn', async () => {
    let starts = 0
    const { workerFetch, sql, cookie } = await createHarness(() => {
      starts += 1
      return createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL })
    })
    const keyResponse = await workerFetch(post('/api/keys', cookie, {
      name: 'bounded caller', spendingLimitCents: 100_000,
    }))
    expect(keyResponse.status).toBe(201)
    const { key } = (await keyResponse.json()) as { key: string }
    const response = await workerFetch(new Request(`${BASE}/v1/agents/${appSlug}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Read my lease' }], stream: true }),
    }))
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('api_key.execution_budget_unsupported')
    expect(starts).toBe(0)
    expect(await sql.query('SELECT state FROM agent_api_key_reservation'))
      .toEqual([{ state: 'released' }])
    expect(await sql.query('SELECT cost_cents FROM agent_api_key_usage')).toEqual([])
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
      tool_tokens: null, // The producer did not report this subset.
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
      maxToolCalls: 8,
    })
    expect(receivedLimits).not.toHaveProperty('maxReasoningTokens')
    expect(receivedLimits).not.toHaveProperty('maxToolTokens')
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

/** A fresh HTTP client crosses an actual socket, real signup/key issuance,
 * migrated SQLite, Worker routing and the shared operator adapter. Only the
 * model/sandbox event source and explicitly configured owned artifact storage
 * are deterministic fixtures. No credential or paid call is used.
 */
describe('external-agent HTTP customer journey', () => {
  it('discovers, signs up, scopes, runs once, reads owned bytes and revokes', async () => {
    let h: Harness
    let executions = 0
    let finishSlow = () => {}
    let signalSlow = () => {}
    const slowStarted = new Promise<void>(resolve => { signalSlow = resolve })
    const slowRelease = new Promise<void>(resolve => { finishSlow = resolve })
    const artifact = 'artifact bytes produced by the deterministic backend\n'
    const ownedArtifacts = new Map<string, string>()
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers,
          ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }) })
        const response = await h.workerFetch(request)
        outgoing.statusCode = response.status
        for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value)
        const cookies = response.headers.getSetCookie()
        if (cookies.length) outgoing.setHeader('set-cookie', cookies)
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) { outgoing.statusCode = 500; outgoing.end(String(error)) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local server address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      h = await createHarness(args => {
        executions++
        ownedArtifacts.set(`${args.identity.userId}/proof.txt`, artifact)
        if (args.body.content === 'Lose detached observation') return createSandboxChatProducer({ errorNotice: true, model: MODEL, events: (async function* () { yield RAW_TURN_EVENTS[0]!; throw new Error('Replay lost while deterministic backend remains active') })() })
        if (args.body.content === 'Hold the workspace lock') {
          signalSlow()
          return createSandboxChatProducer({ events: (async function* () { await slowRelease; yield* feed(RAW_TURN_EVENTS) })(), model: MODEL, errorNotice: true })
        }
        return createSandboxChatProducer({ events: feed(RAW_TURN_EVENTS), model: MODEL, errorNotice: true })
      }, undefined, origin, {
        files: {
          list: async ctx => ownedArtifacts.has(`${ctx.identity.userId}/proof.txt`) ? [{ path: 'proof.txt', bytes: new TextEncoder().encode(artifact).length }] : [],
          read: async (ctx, _workspace, path) => {
            const content = ownedArtifacts.get(`${ctx.identity.userId}/${path}`)
            return content === undefined ? null : { path, content, mediaType: 'text/plain', revision: 'fixture-v1' }
          },
        },
      }, async (_env, scope) => ({ runtimeUrl: 'http://sidecar.fixture.test', sessionId: scope.threadId,
        fetchImpl: async () => Response.json({ data: { interactions: [{ id: 'owner-decision', kind: 'permission', title: 'Publish the draft?' }] } }) }))
      const call = (path: string, init?: RequestInit) => fetch(origin + path, { ...init, redirect: 'error' })
      for (const path of ['/llms.txt', '/llms-full.txt', '/agent-setup.md', '/agent-api.md', '/.well-known/tangle-agent.json']) {
        const response = await call(path)
        expect(response.status, path).toBe(200)
        expect(response.headers.get('content-type')).not.toMatch(/text\/html/)
        if (path.endsWith('.json')) expect(((await response.json()) as { operator_api: string }).operator_api).toBe(`${origin}/api/operator/v1`)
      }
      const schema = await (await call('/openapi.json')).json() as { paths: Record<string, unknown> }
      expect(schema.paths).not.toHaveProperty('/api/operator/v1/workspaces/{workspaceId}/assets/{assetId}')
      const markdown = await call('/', { headers: { accept: 'text/markdown' } })
      expect(markdown.headers.get('vary')).toContain('Accept')
      expect(markdown.headers.get('content-type')).toContain('text/markdown')
      const signup = await call('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ name: 'External client owner', email: 'external-client@example.test', password: 'fixture-only-password' }) })
      expect(signup.status).toBe(200)
      const ownerCookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const issue = async (scopes: string[], extra: Record<string, unknown> = {}) => {
        const response = await call('/api/keys', { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'external client', scopes, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra }) })
        expect(response.status).toBe(201)
        return await response.json() as { key: string; id: string }
      }
      const read = await issue(['operator:read'])
      const deniedIssue = await call('/api/keys', { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No payer authority', scopes: ['operator:read', 'operator:run'], expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
      expect(deniedIssue.status).toBe(403)
      expect(schema.paths).not.toHaveProperty('/api/operator/v1/workspaces/{workspaceId}/turns')
      expect(await (await call('/api/keys/access', { headers: { cookie: ownerCookie } })).json()).toEqual({ operatorRunEnabled: false })
      h.setOperatorRunEnabled(true) // Explicit deployment-payer opt-in for the deterministic fixture.
      const run = await issue(['operator:read', 'operator:run'])
      const authorized = (key: string, path: string, body?: unknown) => call(`/api/operator/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      expect((await call('/api/operator/v1', { headers: { cookie: ownerCookie } })).status).toBe(401)
      const discovery = await (await authorized(read.key, '')).json() as { app: { capabilities: string[] } }
      expect(discovery.app.capabilities).toContain('files.read')
      expect(discovery.app.capabilities).not.toContain('workspaces.create')
      const { workspaces } = await (await authorized(read.key, '/workspaces')).json() as { workspaces: Array<{ id: string }> }
      expect(workspaces).toHaveLength(1)
      const workspace = workspaces[0]!.id
      const input = { turnId: crypto.randomUUID(), content: 'Produce the deterministic proof result' }
      expect((await authorized(read.key, `/workspaces/${workspace}/turns`, input)).status).toBe(403)
      h.setOperatorRunEnabled(false)
      expect((await authorized(run.key, `/workspaces/${workspace}/turns`, input)).status).toBe(403)
      expect(executions).toBe(0)
      expect(await h.sql.query('SELECT turn_id FROM operator_turn_admissions')).toHaveLength(0)
      expect((await h.app.store.listThreads({ workspaceId: workspace })).total).toBe(0)
      h.setOperatorRunEnabled(true)
      expect((await authorized(run.key, '/workspaces/another-owner/turns', input)).status).toBe(404)
      const capped = await issue(['operator:read', 'operator:run'], { spendingLimitCents: 100 })
      expect((await authorized(capped.key, `/workspaces/${workspace}/turns`, input)).status).toBe(402)
      expect(executions).toBe(0)
      expect((await authorized(read.key, `/workspaces/${workspace}/file?path=proof.txt`)).status).toBe(404)
      const [start, raced] = await Promise.all([authorized(run.key, `/workspaces/${workspace}/turns`, input), authorized(run.key, `/workspaces/${workspace}/turns`, input)])
      expect(raced.status).toBe(202)
      expect(start.status).toBe(202)
      const outcomes = await Promise.all([start.json(), raced.json()]) as Array<{ turn: OperatorTurn }>
      const turn = outcomes.find(result => result.turn.state === 'succeeded')!.turn
      expect(turn.state).toBe('succeeded')
      expect(turn.reply!.content).toContain('Filed')
      const retry = await authorized(run.key, `/workspaces/${workspace}/turns`, input)
      expect(retry.status).toBe(202)
      expect(((await retry.json()) as { turn: OperatorTurn }).turn.turnId).toBe(input.turnId)
      expect(executions).toBe(1)
      const polled = await authorized(read.key, `/workspaces/${workspace}/threads/${turn.threadId}/turns/${input.turnId}?wait=1`)
      expect(((await polled.json()) as { turn: OperatorTurn }).turn.state).toBe('succeeded')
      // A new HTTP request builds a new operator adapter over the same database:
      // simulate retained claim state from a process that died before transcript insertion.
      const interruptedId = crypto.randomUUID()
      await h.sql.exec('INSERT INTO operator_turn_admissions (owner_id, turn_id, thread_id, created_at) VALUES (?, ?, ?, ?)', [workspace, interruptedId, turn.threadId, Date.now()])
      const interrupted = await authorized(run.key, `/workspaces/${workspace}/turns`, { turnId: interruptedId, threadId: turn.threadId, content: 'Do not repeat uncertain effects' })
      expect(((await interrupted.json()) as { turn: OperatorTurn }).turn.state).toBe('unknown')
      expect(executions).toBe(1)
      const slow = authorized(run.key, `/workspaces/${workspace}/turns`, { turnId: crypto.randomUUID(), threadId: turn.threadId, content: 'Hold the workspace lock' })
      await slowStarted
      const browserContender = await call('/api/chat', { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: turn.threadId, turnId: crypto.randomUUID(), content: 'Browser contender' }) })
      expect(browserContender.status).toBe(409)
      const contender = await authorized(run.key, `/workspaces/${workspace}/turns`, { turnId: crypto.randomUUID(), threadId: turn.threadId, content: 'Operator contender' })
      expect(await contender.json()).toMatchObject({ turn: { state: 'failed', failure: { code: 'workspace_turn_in_flight' } } })
      expect(executions).toBe(2)
      const during = await h.app.store.listMessages(turn.threadId)
      expect(during.filter(row => row.role === 'user').map(row => row.content)).toEqual([input.content, 'Hold the workspace lock'])
      finishSlow()
      expect(await (await slow).json()).toMatchObject({ turn: { state: 'succeeded', reply: { content: expect.stringContaining('Filed') } } })
      const approvals = await authorized(read.key, `/workspaces/${workspace}/approvals`)
      expect(approvals.status).toBe(200)
      const held = await approvals.json() as { approvals: Array<{ decidedBy: string; url: string }> }
      expect(held.approvals[0]?.decidedBy).toBe('owner')
      expect(held.approvals.map(item => item.url)).toContain(`${origin}/?threadId=${encodeURIComponent(turn.threadId)}`)
      const file = await (await authorized(read.key, `/workspaces/${workspace}/file?path=proof.txt`)).json() as { file: { content: string } }
      expect(file.file.content).toBe(artifact)
      expect((await authorized(read.key, '/workspaces/another-owner/file?path=proof.txt')).status).toBe(404)
      expect((await authorized(read.key, `/workspaces/${workspace}/file?path=..%2Fsecret`)).status).toBe(400)
      expect((await authorized(run.key, `/workspaces/${workspace}/approvals`, { id: 'decision', outcome: 'accepted' })).status).toBe(404)
      const lostId = crypto.randomUUID()
      const lost = await authorized(run.key, `/workspaces/${workspace}/turns`, { turnId: lostId, threadId: turn.threadId, content: 'Lose detached observation' })
      expect(lost.status).toBe(202)
      await h.settle()
      const uncertain = await authorized(read.key, `/workspaces/${workspace}/threads/${turn.threadId}/turns/${lostId}`)
      expect(await uncertain.json()).toMatchObject({ turn: { state: 'unknown', reply: null } })
      const forbiddenRestart = await authorized(run.key, `/workspaces/${workspace}/turns`, { turnId: crypto.randomUUID(), threadId: turn.threadId, content: 'Must not overlap detached backend' })
      expect(await forbiddenRestart.json()).toMatchObject({ turn: { state: 'failed', failure: { code: 'workspace_turn_in_flight' } } })
      expect(executions).toBe(3)
      expect((await call(`/api/keys/${run.id}`, { method: 'DELETE', headers: { cookie: ownerCookie } })).status).toBe(200)
      expect((await authorized(run.key, '')).status).toBe(401)
      await h.settle()
    } finally { finishSlow(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }, 30_000)
})
