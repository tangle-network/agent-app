/**
 * The release canary, run as `pnpm canary` runs it, against this app's real Worker served over HTTP: real
 * better-auth sign-up, the real migration in SQLite, the shared hybrid lane, and the real Sandbox SDK.
 * The Router and the sandbox are local protocol peers; the sandbox peer computes the command's digest as a box
 * would. A pass needs both turns; a computer step the box refuses fails the release and names its cause.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import type { ChatDatabase } from '@tangle-network/agent-app/chat-store'
import { sandboxPromptRunner } from '@tangle-network/agent-app/sandbox'
import { createMemoryTurnEventStore } from '@tangle-network/agent-app/stream'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '@tangle-network/agent-app/turn-stream'
import { buildChatApp, type ChatApp } from '../src/chat'
import type { AppEnv } from '../src/env'
import { createSandboxShell } from '../src/sandbox'
import { TurnStreamDO } from '../src/turn-lock'
import { createChatWorker } from '../src/worker'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CANARY = join(ROOT, 'scripts', 'release-canary.mjs')

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** The Router and the sandbox API over loopback HTTP. A box that `answers` runs the canary's command. */
async function protocolPeers(computer: 'answers' | 'refuses') {
  const dispatched: string[] = []
  let origin = ''
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const path = new URL(request.url ?? '/', 'http://peer.local').pathname
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    if (path === '/v1/sandboxes/canary-box') {
      return json({ id: 'canary-box', status: 'running', filesystemIncarnationId: 'canary-incarnation',
        filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
        connection: { runtimeUrl: `${origin}/v1/sandboxes/canary-box/runtime` } })
    }
    if (request.method === 'POST' && path === '/v1/sandboxes/canary-box/runtime/agents/run/stream') {
      const input = JSON.parse(body) as { sessionId: string; parts?: Array<{ type: string; text?: string }> }
      // The SDK encodes every text part on the wire; the sidecar decodes it before dispatch.
      const task = (input.parts ?? []).filter(part => part.type === 'text')
        .map(part => Buffer.from(part.text ?? '', 'base64').toString('utf8')).join('\n')
      dispatched.push(task)
      const ids = { executionId: String(request.headers['x-execution-id'] ?? 'canary-execution'), sessionId: input.sessionId }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (computer === 'refuses') {
        const refusal = { code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Request body exceeds the 1048576 byte limit' }
        return response.end(frame('execution.started', ids) + frame('error', refusal)
          + frame('result', { ...ids, status: 'failed', error: refusal }))
      }
      const nonce = /canary-[0-9a-f]{32}/.exec(task)?.[0] ?? ''
      const printed = `${createHash('sha256').update(nonce).digest('hex')}  -`
      return response.end(frame('execution.started', ids) + frame('result', { ...ids, finalText: printed })
        + frame('done', { ...ids, status: 'completed' }))
    }
    if (request.method === 'POST' && path.endsWith('/chat/completions')) {
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
      const member = String(payload.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
      const result = payload.messages.find(message => message.role === 'tool')
      const escalate = member.includes('sandbox_run') && !result
      const delta = escalate
        ? { tool_calls: [{ index: 0, id: 'canary-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: member }) } }] }
        : { content: result ? `The computer returned: ${String(result.content)}` : 'I can answer.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      return response.end(`data: ${JSON.stringify({ model: 'served/canary', choices: [{ index: 0, delta,
        finish_reason: escalate ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    }
    return json({ error: `Unexpected protocol path ${request.method} ${path}` }, 500)
  })
  origin = await listen(server)
  return { origin, dispatched, close: () => close(server) }
}

/** This app's Worker over HTTP, on the real migration, with the hybrid lane bound to the peers. */
async function servedApp(peer: { origin: string }) {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const migrations = join(ROOT, 'migrations')
  for (const name of readdirSync(migrations).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
    sqlite.exec(readFileSync(join(migrations, name), 'utf8'))
  }
  let app: ChatApp | undefined
  let env: AppEnv | undefined
  const pending: Promise<unknown>[] = []
  const worker = createChatWorker({
    buildChatApp: () => app!,
    buildGatewayApp: () => { throw new Error('The canary does not use the gateway') },
    gatewayEnabled: false,
  })
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
      const response = await worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], env!, {
        waitUntil: (work: Promise<unknown>) => { pending.push(work) }, passThroughOnException: () => undefined, props: {},
      } as unknown as ExecutionContext)
      outgoing.statusCode = response.status
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) outgoing.setHeader('set-cookie', cookies)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { outgoing.statusCode = 500; outgoing.end(String(error)) }
  })
  const origin = await listen(server)
  env = {
    DB: null as unknown as AppEnv['DB'], BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'canary-test-secret-not-for-production',
    TURN_STREAM: createMemoryTurnStreamHarness((state, secret) => new TurnStreamDO(state, { TURN_STREAM_AUTH_SECRET: secret })).namespace,
    TURN_STREAM_AUTH_SECRET: MEMORY_TURN_STREAM_AUTH_SECRET,
    TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: peer.origin,
    SANDBOX_API_KEY: 'loopback-only-sandbox-key', SANDBOX_GATEWAY_URL: peer.origin,
  }
  const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: peer.origin }).get('canary-box')
  if (!box) throw new Error('The loopback sandbox peer has no canary box')
  const shell = createSandboxShell(env)
  app = buildChatApp(env, {
    db: drizzle(sqlite) as unknown as ChatDatabase,
    turnStore: createMemoryTurnEventStore(),
    uploadSink: async () => null,
    produce: {
      router: args => ({
        apiKey: 'loopback-only-router-key', model: 'requested/canary', baseUrl: peer.origin,
        systemPrompt: 'Use the workspace computer when the member asks for it.',
        box: {
          acquire: async () => box,
          runTask: sandboxPromptRunner(shell, { model: 'native/canary', sessionId: `sandbox-run-${args.identity.sessionId}` }),
          timeoutMs: 10_000,
        },
      }),
    },
  })
  return {
    origin,
    close: async () => { await Promise.allSettled(pending); await close(server); sqlite.close() },
  }
}

function runCanary(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CANARY], { env: { PATH: process.env.PATH ?? '', ...env } })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

const member = { CANARY_EMAIL: 'release-canary@example.test', CANARY_PASSWORD: 'canary-fixture-password', CANARY_TURN_MS: '20000' }

describe('release canary', () => {
  it('passes a release whose plain answer and computer step both succeed', async () => {
    const peer = await protocolPeers('answers')
    const served = await servedApp(peer)
    try {
      const run = await runCanary({ ...member, CANARY_URL: served.origin })
      expect(run.output).toMatch(/canary answer PASS/)
      expect(run.output).toMatch(/canary computer PASS/)
      expect(run.code).toBe(0)
      // The computer step reached the box once, carrying the command with the canary's fresh nonce.
      expect(peer.dispatched).toHaveLength(1)
      expect(peer.dispatched[0]).toMatch(/printf %s 'canary-[0-9a-f]{32}' \| sha256sum/)
      // The second release signs the member in rather than signing up again, and passes again.
      expect((await runCanary({ ...member, CANARY_URL: served.origin })).code).toBe(0)
    } finally { await served.close(); await peer.close() }
  }, 60_000)

  it('fails the release when the computer step fails, naming the recorded cause', async () => {
    const peer = await protocolPeers('refuses')
    const served = await servedApp(peer)
    try {
      const run = await runCanary({ ...member, CANARY_URL: served.origin })
      expect(run.output).toMatch(/canary answer PASS/)
      expect(run.output).toMatch(/canary computer FAIL .*the computer step failed \(sandbox_\w+\)/)
      // The box's refusal reaches the release log through the transcript's persisted notice.
      expect(run.output).toContain('Request body exceeds the 1048576 byte limit')
      expect(run.code).toBe(1)
    } finally { await served.close(); await peer.close() }
  }, 60_000)

  it('refuses to pass a release it was not configured to check', async () => {
    const run = await runCanary({})
    expect(run.output).toContain('CANARY_URL')
    expect(run.code).toBe(1)
  })
})
