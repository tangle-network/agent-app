/**
 * Real workerd fixture for agent-app's computer step: `createComputerStep` over
 * the Sandbox SDK to the test's box runtime peer, a D1 Vault, and the shared
 * interaction answer route. The step keeps no ledger; the runtime's admission,
 * replay and completed turns are its durability. `/proof/drop` stands for the
 * request's transport dying after the send: it aborts the call's signal from
 * outside, as an evicted isolate would stop it.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { Sandbox, type SandboxInstance } from '@tangle-network/sandbox'
import { defaultChatShell } from '../../src/chat-routes/default-backend'
import { createInteractionAnswerRoute } from '../../src/interactions/route'
import type { ComputerVault } from '../../src/sandbox/computer-files'
import { createComputerStep } from '../../src/sandbox/computer-step'

interface Env { DB: D1Database }

const SESSION = 'durable-session'
const calls = new Map<string, AbortController>()

async function config(env: Env): Promise<{ peer: string; root: string }> {
  const row = await env.DB.prepare('SELECT value FROM proof_config WHERE key = ?').bind('peer').first<{ value: string }>()
  if (!row) throw new Error('The proof is not seeded')
  return JSON.parse(row.value) as { peer: string; root: string }
}

async function box(peer: string): Promise<SandboxInstance> {
  const found = await new Sandbox({ apiKey: 'loopback-only-sandbox-key', baseUrl: peer }).get('durable-box')
  if (!found) throw new Error('The proof box is missing')
  return found as SandboxInstance
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/proof/seed' && request.method === 'POST') {
      await env.DB.batch(['CREATE TABLE IF NOT EXISTS vault_files (path TEXT PRIMARY KEY, content TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS proof_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'].map(sql => env.DB.prepare(sql)))
      await env.DB.prepare('INSERT OR REPLACE INTO proof_config (key, value) VALUES (?, ?)').bind('peer', await request.text()).run()
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/step' && request.method === 'POST') {
      const body = await request.json() as { callId: string; task: string; questions?: boolean }
      const { peer, root } = await config(env)
      const vault: ComputerVault = { root, save: async file => {
        await env.DB.prepare('INSERT OR REPLACE INTO vault_files (path, content) VALUES (?, ?)').bind(file.path, file.content).run()
      } }
      const controller = new AbortController()
      calls.set(body.callId, controller)
      const emitted: Array<{ kind: string; data?: unknown }> = []
      const step = createComputerStep({
        shell: defaultChatShell('computer-step-proof', { TANGLE_API_KEY: 'loopback-only-router-key', TANGLE_ROUTER_URL: peer }, { model: 'turn/model' }),
        prompt: { model: 'turn/model' }, session: { id: SESSION }, files: vault, parentExecutionId: 'durable-proof-turn',
        ...(body.questions ? { questions: true } : {}),
      })
      try {
        const answer = await step.runTask(await box(peer), body.task, { callId: body.callId, signal: controller.signal,
          timeoutMs: 60_000, emit: (kind, data) => { emitted.push({ kind, data }) } })
        return Response.json({ answer, emitted })
      } catch (error) {
        const failure = error as { code?: unknown; name?: unknown; message?: unknown }
        return Response.json({ error: { code: failure.code ?? failure.name ?? null, message: String(failure.message ?? error) }, emitted }, { status: 500 })
      } finally {
        calls.delete(body.callId)
      }
    }
    if (url.pathname === '/proof/drop' && request.method === 'POST') {
      const { callId } = await request.json() as { callId: string }
      const call = calls.get(callId)
      call?.abort(new Error('the request transport was lost'))
      return new Response(null, { status: call ? 204 : 404 })
    }
    if (url.pathname === '/proof/vault') {
      const files = await env.DB.prepare('SELECT path, content FROM vault_files ORDER BY path').all<{ path: string; content: string }>()
      return Response.json(files.results)
    }
    if (url.pathname === '/interactions') {
      const { peer } = await config(env)
      const route = createInteractionAnswerRoute({ resolveConnection: async () => ({ ok: true as const,
        connection: { runtimeUrl: `${peer}/v1/sandboxes/durable-box/runtime`, sessionId: SESSION } }) })
      return request.method === 'POST' ? route.answer(request) : route.list(request)
    }
    return new Response('not found', { status: 404 })
  },
}
