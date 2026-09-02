/**
 * src/worker.ts — the HTTP surface. Routing only; every handler is a factory
 * product from `src/chat.ts`. Static assets (the dev chat page in `public/`)
 * are served by the Workers assets pipeline before this fetch handler runs.
 *
 * Route map:
 *   ALL  /api/auth/*                    better-auth (sign-up/sign-in/session)
 *   POST /api/threads                   create a thread
 *   GET  /api/threads                   list threads
 *   GET  /api/threads/:id/messages      typed transcript (parts + usage)
 *   POST /api/chat                      run one turn (NDJSON stream)
 *   GET  /api/chat/replay/:turnId       replay a buffered turn (?fromSeq=)
 *   GET  /api/chat/running              live turn ids on a thread (?threadId=)
 *   POST /api/chat/upload               multipart upload → prompt parts
 *   GET  /api/chat/interactions         outstanding agent asks (?threadId=)
 *   POST /api/chat/interactions         answer an ask
 *   CRUD /api/keys                      manage personal API keys
 *   POST /v1/agents/:slug/chat/completions  OpenAI-compatible API
 */

import { config } from '../agent.config'
import { buildChatApp, type ChatApp } from './chat'
import type { AppEnv } from './env'
import {
  buildGatewayApp,
  type GatewayAppOptions,
} from './gateway'

export interface WorkerAssembly {
  buildChatApp(env: AppEnv): ChatApp
  buildGatewayApp(
    env: AppEnv,
    app: ChatApp,
    options?: GatewayAppOptions,
  ): ReturnType<typeof buildGatewayApp>
  /** Test override. Production follows agent.config.ts. */
  gatewayEnabled?: boolean
}

function attachThreadUrl(response: Response, request: Request): Response {
  const threadId = response.headers.get('X-Tangle-Thread-Id')
  if (!threadId) return response
  const threadUrl = new URL('/', request.url)
  threadUrl.searchParams.set('threadId', threadId)
  const headers = new Headers(response.headers)
  headers.set('X-Tangle-Thread-Url', threadUrl.toString())
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const defaultAssembly: WorkerAssembly = {
  buildChatApp,
  buildGatewayApp,
  gatewayEnabled: config.gateway.enabled,
}

/** Build the Worker around one app assembly. Tests inject the real app with a test database. */
export function createWorker(assembly: WorkerAssembly = defaultAssembly): ExportedHandler<AppEnv> {
  // Reuse the database-backed chat assembly within one Worker environment.
  // Build the gateway per request so its background work binds to that
  // request's ExecutionContext. Durable stores remain authoritative.
  const instances = new WeakMap<object, ChatApp>()

  const resolveApp = (env: AppEnv) => {
    const key = env as object
    const existing = instances.get(key)
    if (existing) return existing
    const app = assembly.buildChatApp(env)
    instances.set(key, app)
    return app
  }

  return {
    async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      const { pathname } = url
      const method = request.method

      const isGatewayPath = pathname === '/api/keys'
        || pathname.startsWith('/api/keys/')
        || pathname === '/v1/agents'
        || pathname.startsWith('/v1/agents/')
      const isUnsupportedA2APath = /^\/v1\/agents\/[^/]+(?:\/\.well-known\/agent\.json)?$/.test(pathname)
      if (isGatewayPath && assembly.gatewayEnabled === false) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      // Long-running A2A task control is not mounted until agent-gateway owns
      // durable cross-isolate cancel and replay. OpenAI-compatible calls do
      // not depend on that unfinished path.
      if (isUnsupportedA2APath) return Response.json({ error: 'Not found' }, { status: 404 })

      const app = resolveApp(env)
      if (isGatewayPath) {
        const gateway = assembly.buildGatewayApp(env, app, {
          waitUntil: (promise) => ctx.waitUntil(promise),
        })
        return attachThreadUrl(await gateway.fetch(request), request)
      }

      if (pathname.startsWith('/api/auth/')) return app.auth.auth.handler(request)

      if (pathname === '/api/chat' && method === 'POST') {
        // Pass waitUntil so the turn keeps running (and buffering for replay)
        // after a client disconnect.
        return app.routes.turn(request, ctx)
      }
      const replay = pathname.match(/^\/api\/chat\/replay\/([^/]+)$/)
      if (replay && method === 'GET') return app.routes.replay(request, { turnId: replay[1]! })
      // Reconnect discovery: which turns are still live on a thread, so a page
      // reloaded mid-turn re-attaches via /replay instead of losing the run.
      if (pathname === '/api/chat/running' && method === 'GET') return app.routes.running(request)
      if (pathname === '/api/chat/upload' && method === 'POST') return app.upload(request)
      if (pathname === '/api/chat/interactions' && app.routes.interactions) {
        if (method === 'GET') return app.routes.interactions.list(request)
        if (method === 'POST') return app.routes.interactions.answer(request)
      }

      if (pathname === '/api/threads' && method === 'POST') return app.routes.createThread(request)
      if (pathname === '/api/threads' && method === 'GET') return app.routes.listThreads(request)
      const transcript = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/)
      if (transcript && method === 'GET') {
        return app.routes.threadMessages(request, { threadId: transcript[1]! })
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  }
}

export default createWorker()
