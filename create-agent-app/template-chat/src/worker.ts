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
 *   POST /api/chat/upload               multipart upload → prompt parts
 *   GET  /api/chat/interactions         outstanding agent asks (?threadId=)
 *   POST /api/chat/interactions         answer an ask
 */

import { buildChatApp } from './chat'
import type { AppEnv } from './env'

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // Per-request assembly is the standard Workers pattern: env only exists
    // inside fetch, and the factories are cheap closures over it.
    const app = buildChatApp(env)
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    if (pathname.startsWith('/api/auth/')) return app.auth.auth.handler(request)

    if (pathname === '/api/chat' && method === 'POST') {
      // Pass waitUntil so the turn keeps running (and buffering for replay)
      // after a client disconnect.
      return app.routes.turn(request, ctx)
    }
    const replay = pathname.match(/^\/api\/chat\/replay\/([^/]+)$/)
    if (replay && method === 'GET') return app.routes.replay(request, { turnId: replay[1]! })
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
} satisfies ExportedHandler<AppEnv>
