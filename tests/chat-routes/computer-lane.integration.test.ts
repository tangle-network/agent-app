import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox, type SandboxInstance } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import { defaultChatShell } from '../../src/chat-routes/default-backend'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { COMPUTER_FILES_GUIDANCE, type ComputerVault } from '../../src/sandbox/computer-files'
import { createComputerStep, type ComputerStepOptions } from '../../src/sandbox/computer-step'
import { readSandboxRouterModels } from '../../src/sandbox/router-models'
import { SandboxRunError } from '../../src/sandbox/sandbox-run-error'
import { openDatabase } from '../teams/db-helper'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'
import { createSidecarRuntimePeer, type RuntimeRun } from '../helpers/sidecar-runtime-peer'

type RouterPayload = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

/**
 * Real HTTP peers for the Router, Platform's model policy and the box's runtime
 * (`tests/helpers/sidecar-runtime-peer`: detached admission, replay, the session's
 * execution ledger, completed turns by turn id, a real directory as the file
 * tree), the real Sandbox SDK and the shared route. The box agent writes a real
 * file under the Vault root; a repeated turn id is the same run, as the sidecar
 * makes it.
 */
async function boundary(options: { policy?: 'down'; allowed?: string[]; refused?: string[] } = {}) {
  const disk = mkdtempSync(join(tmpdir(), 'computer-lane-'))
  // The policy reader keeps answers per key, so each boundary has a payer of its own.
  const payerKey = `payer-key-${crypto.randomUUID()}`
  const root = join(disk, 'vault')
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'earlier.md'), 'already in the vault\n')
  // Written long before this step's run, as an earlier turn's file is.
  const anHourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(join(root, 'notes', 'earlier.md'), anHourAgo, anHourAgo)
  const routerRequests: Array<{ authorization?: string; payload: RouterPayload }> = []
  const held: Array<() => void> = []
  let agentRuns = 0
  let holdNextRun = false
  let origin = ''
  const runtime = createSidecarRuntimePeer({ disk, onRun: (run: RuntimeRun, peer) => {
    const model = String((run.backend.model as { model?: unknown } | undefined)?.model ?? '')
    if (options.refused?.includes(model)) {
      // As the Router refuses a disabled provider, relayed by the box agent at its run's end.
      return peer.fail(run, `opencode execution failed: Tangle-funded openai inference is unavailable for "${model}": the company credential is off (HTTP 403 provider_disabled)`)
    }
    // The box agent's own work: one file under the Vault root, written once per run.
    agentRuns++
    const work = () => {
      mkdirSync(join(root, 'proof'), { recursive: true })
      writeFileSync(join(root, 'proof', 'a.md'), `summary for ${run.executionId.slice(0, 8)}\n`)
      writeFileSync(join(root, 'proof', 'chart.png'), Buffer.from([137, 80, 78, 71]))
      peer.finish(run, `Saved ${join(root, 'proof', 'a.md')}`)
    }
    if (holdNextRun) { holdNextRun = false; held.push(work); return }
    work()
  } })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const url = new URL(request.url!, 'http://peer.local')
      const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (url.pathname === '/v1/keys/sandbox-router-models') {
        if (options.policy === 'down') return json({ error: 'unavailable' }, 503)
        if (request.headers.authorization !== `Bearer ${payerKey}`) return json({ error: 'unauthorized' }, 401)
        return json({ success: true, data: { allowedModels: options.allowed ?? ['flat/model-a'] } })
      }
      if (url.pathname === '/v1/sandboxes/lane-box') {
        return json({ id: 'lane-box', status: 'running', filesystemIncarnationId: 'lane-incarnation',
          filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
          connection: { runtimeUrl: `${origin}/v1/sandboxes/lane-box/runtime` } })
      }
      if (url.pathname === '/v1/backends') return json({ backends: [{ type: 'opencode', capabilities: { interactions: ['question'] } }] })
      const prefix = '/v1/sandboxes/lane-box/runtime'
      if (url.pathname.startsWith(prefix) && runtime.handle(request, response, url.pathname.slice(prefix.length), url, body)) return
      if (request.method === 'POST' && ['/chat/completions', '/v1/chat/completions'].includes(url.pathname)) {
        const payload = JSON.parse(body) as RouterPayload
        routerRequests.push({ authorization: request.headers.authorization, payload })
        const toolResult = payload.messages.find(message => message.role === 'tool')
        const member = String(payload.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
        const escalate = member.includes('computer') && !toolResult
        const delta = escalate
          ? { tool_calls: [{ index: 0, id: 'lane-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: 'Write a summary at proof/a.md and a chart at proof/chart.png.' }) } }] }
          : { content: toolResult ? `Done. ${String(toolResult.content)}` : 'A plain answer.' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ model: 'served/router', choices: [{ index: 0, delta, finish_reason: escalate ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      json({ error: `no local route for ${request.method} ${url.pathname}` }, 404)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const box = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: origin }).get('lane-box')
  if (!box) throw new Error('The local box is missing')
  // The app's Vault: a store the app owns, keyed by path relative to the root.
  const vaultFiles = new Map<string, string>()
  const vault: ComputerVault = { root, save: async file => { vaultFiles.set(file.path, file.content) } }
  const shell = defaultChatShell('computer-lane', { TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: origin }, { model: 'turn/model' })
  const computer = (extra: Partial<ComputerStepOptions> = {}): ComputerStepOptions => ({
    shell, prompt: { model: 'turn/model' }, session: { id: 'computer-lane-session' }, files: vault,
    models: { preferred: ['turn/model', 'flat/model-a'],
      allowed: signal => readSandboxRouterModels({ platformUrl: `${origin}/any/path`, apiKey: payerKey, signal }) },
    ...extra,
  })
  const agentRequests = () => [...runtime.runs.values()].map(run => ({ executionId: run.executionId, sessionId: run.sessionId, task: run.task, backend: run.backend }))
  return { origin, root, box: box as SandboxInstance, shell, vault, vaultFiles, computer, routerRequests, runtime, held,
    get agentRequests() { return agentRequests() },
    get agentRuns() { return agentRuns },
    holdNextRun: () => { holdNextRun = true },
    close: async (closer?: Server) => {
      for (const release of held.splice(0)) release()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => (closer ?? server).close(error => error ? reject(error) : resolve()))
      rmSync(disk, { recursive: true, force: true })
    },
  }
}

const taskOptions = (callId: string, signal = new AbortController().signal) =>
  ({ callId, signal, timeoutMs: 10_000, emit: () => {} })

it('copies the files a computer step wrote into the Vault and gives the Router model only the verified receipt', async () => {
  const peer = await boundary()
  const tables = createChatTables()
  const chatDb = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(chatDb as unknown as ChatDatabase, tables)
  const events = sqliteD1(TURN_EVENTS_MIGRATION_SQL)
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  const pending: Promise<unknown>[] = []
  let revoked = 0
  try {
    const routes = createChatTurnRoutes({
      projectId: 'computer-lane', store, turnStore: createD1TurnEventStore(events.d1), turnTrace: false, log: () => {},
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
      produce: { router: () => ({
        // The turn's funding: a per-turn lease the producer revokes when the turn settles.
        apiKey: Promise.resolve({ key: 'per-turn-lease', revoke: async () => { revoked++ } }),
        model: 'turn/model', baseUrl: peer.origin, systemPrompt: 'Use the workspace computer when asked.',
        box: { acquire: async () => peer.box, computer: peer.computer() },
      }) },
    })
    const response = await routes.turn(new Request('http://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Please use the computer.' }) }),
    { waitUntil: promise => { pending.push(promise) } })
    const wire = await response.text()
    await Promise.all(pending)
    expect(response.status).toBe(200)

    // The box ran the first of the turn's models its key allows, once, in the session the step was given.
    expect(peer.agentRequests).toHaveLength(1)
    const sent = peer.agentRequests[0]!
    expect((sent.backend.model as { model?: string }).model).toBe('flat/model-a')
    expect(sent.sessionId).toBe('computer-lane-session')
    expect(sent.backend.metadata).toBeUndefined()
    expect(sent.task).toContain(`Where files go: the workspace's files live under ${peer.root}.`)

    // The step's text file reached the Vault; the binary one is named as computer-only.
    expect([...peer.vaultFiles.keys()]).toEqual(['proof/a.md'])
    expect(peer.vaultFiles.get('proof/a.md')).toMatch(/^summary for /)
    const toolMessage = String(peer.routerRequests[1]!.payload.messages.find(message => message.role === 'tool')?.content)
    expect(toolMessage).toContain('Workspace vault: the app saved proof/a.md into it after this step.')
    expect(toolMessage).toContain(`Only on the computer, not in the workspace vault: ${peer.root}/proof/chart.png (not a text file the vault stores).`)
    expect(toolMessage).not.toContain('notes/earlier.md')
    const system = String(peer.routerRequests[0]!.payload.messages.find(message => message.role === 'system')?.content)
    expect(system).toContain(COMPUTER_FILES_GUIDANCE)

    // The turn's lease paid for both model calls and was revoked once.
    expect(peer.routerRequests.map(request => request.authorization)).toEqual(['Bearer per-turn-lease', 'Bearer per-turn-lease'])
    expect(revoked).toBe(1)

    // The box ran it detached under the step's turn id, so the run outlives the request that sent it.
    expect([...peer.runtime.runs.values()][0]).toMatchObject({ terminal: 'completed', sessionId: 'computer-lane-session' })
    expect(wire).toContain('Done.')
    const assistant = (await store.listMessages('thread')).find(message => message.role === 'assistant')!
    expect(assistant.content).toContain('Workspace vault: the app saved proof/a.md')
  } finally {
    chatDb.$client.close(); events.sqlite.close(); await peer.close()
  }
}, 20_000)

it('keeps a run its request lost going, and a repeated call reads that run instead of sending another', async () => {
  const peer = await boundary()
  try {
    const step = createComputerStep({ ...peer.computer(), parentExecutionId: 'turn-execution' })
    // The first request is lost after the send, while the box agent is still working.
    peer.holdNextRun()
    const lost = new AbortController()
    const first = step.runTask(peer.box, 'Write the summary.', taskOptions('call-1', lost.signal))
    while (peer.held.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
    lost.abort(new Error('The request was lost'))
    // A failure after the send is never reported as never sent.
    const lostError = await first.then(() => undefined, (error: unknown) => error)
    expect(lostError).toBeDefined()
    expect(lostError instanceof SandboxRunError && lostError.code === 'sandbox_unavailable').toBe(false)
    expect(peer.vaultFiles.size).toBe(0)
    // It was sent detached: the box runs it on with nobody listening, and finishes.
    const [run] = [...peer.runtime.runs.values()]
    expect(run!.terminal).toBe(null)
    peer.held.shift()!()
    expect(run!.terminal).toBe('completed')

    // The repeated call reads the finished run by its turn id: no second run, and it copies that run's file.
    const answer = await step.runTask(peer.box, 'Write the summary.', taskOptions('call-1'))
    expect(peer.agentRuns).toBe(1)
    expect(peer.runtime.runs.size).toBe(1)
    expect([...peer.vaultFiles.keys()]).toEqual(['proof/a.md'])
    expect(answer).toContain('Workspace vault: the app saved proof/a.md into it after this step.')

    // Again, nothing is sent: the runtime's completed turn is the answer.
    const sends = peer.runtime.sends.length
    expect(await step.runTask(peer.box, 'Write the summary.', taskOptions('call-1'))).toBe(answer)
    expect(peer.runtime.sends.length).toBe(sends)

    // Another call of the same turn is another step.
    await step.runTask(peer.box, 'Write the summary.', taskOptions('call-2'))
    expect(peer.runtime.runs.size).toBe(2)
  } finally { await peer.close() }
}, 20_000)

it('derives isolation and the send witness from one session value', async () => {
  const peer = await boundary()
  try {
    const isolated = createComputerStep({ ...peer.computer({ session: { id: 'isolated-session', isolated: true }, files: undefined }),
      parentExecutionId: 'turn-execution' })
    await isolated.runTask(peer.box, 'Read the workspace.', taskOptions('isolated-call'))
    expect(peer.agentRequests[0]).toMatchObject({ sessionId: 'isolated-session', backend: { metadata: { profileSecretIsolation: true } } })

    // A session the product cannot prepare is never sent, so the turn may use the computer again.
    const unprepared = createComputerStep({ ...peer.computer({ files: undefined,
      session: async () => { throw new Error('The isolated session could not be created') } }), parentExecutionId: 'turn-execution' })
    const refusal = await unprepared.runTask(peer.box, 'Read the workspace.', taskOptions('refused-call')).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SandboxRunError)
    expect((refusal as SandboxRunError).code).toBe('sandbox_unavailable')
    expect(peer.agentRequests).toHaveLength(1)
  } finally { await peer.close() }
}, 20_000)

it('keeps the product model when the box key policy cannot be read', async () => {
  const peer = await boundary({ policy: 'down' })
  try {
    const step = createComputerStep({ ...peer.computer({ files: undefined }), parentExecutionId: 'turn-execution' })
    expect(await step.runTask(peer.box, 'Read the workspace.', taskOptions('policy-call'))).toContain('Saved')
    expect((peer.agentRequests[0]!.backend.model as { model?: string }).model).toBe('turn/model')
  } finally { await peer.close() }
}, 20_000)

it('runs the default backend on the product funding lease and tools', async () => {
  const peer = await boundary()
  const events = sqliteD1(TURN_EVENTS_MIGRATION_SQL)
  const tables = createChatTables()
  const chatDb = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(chatDb as unknown as ChatDatabase, tables)
  await store.createThread({ id: 'default-thread', workspaceId: 'workspace' })
  const pending: Promise<unknown>[] = []
  let revoked = 0
  try {
    const routes = createChatTurnRoutes({
      projectId: 'computer-lane', env: { TANGLE_ROUTER_URL: peer.origin }, store, turnStore: createD1TurnEventStore(events.d1),
      turnTrace: false, turnLock: false, log: () => {},
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
      produce: {
        model: 'turn/model', systemPrompt: 'Answer the member.',
        funding: () => ({ key: 'default-lease', revoke: async () => { revoked++ } }),
        tools: () => [{ name: 'read_record', description: 'Read one workspace record.', inputSchema: { type: 'object' },
          run: async () => ({ record: 'none' }) }],
      },
    })
    const response = await routes.turn(new Request('http://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'default-thread', content: 'Hello.' }) }),
    { waitUntil: promise => { pending.push(promise) } })
    expect(await response.text()).toContain('A plain answer.')
    await Promise.all(pending)
    expect(peer.routerRequests).toHaveLength(1)
    expect(peer.routerRequests[0]!.authorization).toBe('Bearer default-lease')
    expect(peer.routerRequests[0]!.payload.tools?.map(tool => tool.function.name)).toEqual(['read_record', 'sandbox_run'])
    expect(revoked).toBe(1)
  } finally {
    chatDb.$client.close(); events.sqlite.close(); await peer.close()
  }
}, 20_000)

it('moves to the next allowed model when the box refuses a disabled provider, under its own execution id', async () => {
  const peer = await boundary({ allowed: ['flat/model-a', 'flat/model-b'], refused: ['flat/model-a'] })
  try {
    const step = createComputerStep({ ...peer.computer({ files: undefined }),
      models: { ...peer.computer().models!, preferred: ['turn/model', 'flat/model-a', 'flat/model-b'] },
      parentExecutionId: 'turn-execution' })
    const answer = await step.runTask(peer.box, 'Read the workspace.', taskOptions('fallback-call'))
    expect(answer).toContain('Saved')
    expect(peer.agentRequests.map(request => (request.backend.model as { model?: string }).model)).toEqual(['flat/model-a', 'flat/model-b'])
    const [first, second] = peer.agentRequests.map(request => request.executionId)
    expect(second).toBe(`${first}-f2`)
    expect(peer.runtime.runs.get(second!)?.terminal).toBe('completed')
  } finally { await peer.close() }
}, 20_000)
