/**
 * src/chat.ts — the COMPOSER. The whole server chat vertical assembled from
 * `@tangle-network/agent-app` factories, exactly the `examples/chat-app.md`
 * assembly made runnable:
 *
 *   auth         `createAppAuth` (better-auth over drizzle/D1) + its guards
 *   persistence  `createChatStore` over the tables in `src/db/schema.ts`
 *   turn         `createChatTurnRoutes` — body validation, turn identity,
 *                the default turn-buffer tap (replay after a drop), user and
 *                assistant rows persisted with typed parts + usage receipt
 *   producer     the sandbox lane from `src/sandbox.ts`
 *   uploads      `createUploadRoute` — small files inline (`data:` URI),
 *                large files into the sandbox workspace by path
 *   asks         `/interactions` list/answer endpoints over the sidecar
 *
 * You extend THIS file (and `src/worker.ts`); you never edit the shell. The
 * `overrides` seams exist so the e2e test in `tests/` can run the identical
 * assembly against an in-memory database and a fake sandbox producer — the
 * production wiring is the zero-override call.
 *
 * Workspaces are single-user here (workspace id = user id). Multi-user teams
 * later: `@tangle-network/agent-app/teams` + `createChatTables({ workspaceTable })`.
 */

import { config } from '../agent.config'
import { createAppAuth, type AppAuth } from '@tangle-network/agent-app/app-auth'
import {
  createChatTurnRoutes,
  createUploadRoute,
  type ChatTurnAuthorization,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
  type ChatTurnRoutes,
  type SandboxUploadSink,
} from '@tangle-network/agent-app/chat-routes'
import {
  createChatStore,
  type ChatDatabase,
  type ChatStore,
} from '@tangle-network/agent-app/chat-store'
import { guardResolution } from '@tangle-network/agent-app/platform'
import {
  createD1TurnEventStore,
  type TurnEventStore,
} from '@tangle-network/agent-app/stream'
import { drizzle } from 'drizzle-orm/d1'
import { accounts, messages, sessions, threads, users, verifications } from './db/schema'
import type { AppEnv } from './env'
import { appSlug, createSandboxProduce, resolveSidecarConnection, resolveUploadSink } from './sandbox'

export interface ChatAppOverrides {
  /** Test seam: an in-memory drizzle db (the e2e test runs the REAL
   *  `migrations/0001_init.sql` into better-sqlite3). Default: `drizzle(env.DB)`. */
  db?: ChatDatabase
  /** Test seam: `createMemoryTurnEventStore()`. Default: D1-backed buffer. */
  turnStore?: TurnEventStore
  /** Test seam: a fake sandbox producer. Default: the real sandbox lane. */
  produce?: (args: ChatTurnProduceArgs<void>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
  /** Test seam: where large uploads land. Default: the workspace box's fs. */
  uploadSink?: (scope: { workspaceId: string; userId: string }) => Promise<SandboxUploadSink | null>
}

export interface ChatApp {
  auth: AppAuth
  store: ChatStore
  routes: ChatTurnRoutes & {
    /** POST `{ title?, firstMessage? }` → `{ thread }`. */
    createThread(request: Request): Promise<Response>
    /** GET → `{ threads, total, limit, offset }`. */
    listThreads(request: Request): Promise<Response>
    /** GET → `{ thread, messages }` — the full typed transcript. */
    threadMessages(request: Request, params: { threadId: string }): Promise<Response>
  }
  upload(request: Request): Promise<Response>
}

const notFound = () => Response.json({ error: 'Thread not found' }, { status: 404 })

export function buildChatApp(env: AppEnv, overrides: ChatAppOverrides = {}): ChatApp {
  const db = overrides.db ?? (drizzle(env.DB) as unknown as ChatDatabase)
  const store = createChatStore(db, { threads, messages })

  const auth = createAppAuth({
    appName: config.name,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    db,
    schema: { users, sessions, accounts, verifications },
    // For a throwaway prototype you can swap the drizzle pair for
    // `database: memoryAdapter({ user: [], session: [], account: [], verification: [] })`
    // (from 'better-auth/adapters/memory') — nothing survives a restart.
  })

  /** Session → identity + thread access, for both routes and seams. Guards
   *  throw JSON Responses; `guardResolution` adapts them to `{ ok, response }`. */
  async function requireUser(request: Request) {
    return guardResolution(() => auth.requireApiUser(request))
  }

  /** The one product-supplied access step for turn + replay. Identity comes
   *  from the SESSION, never from the request body — a client cannot forge
   *  `userId`/`workspaceId`. */
  async function authorize(args: {
    request: Request
    intent: 'turn' | 'replay'
    body?: Record<string, unknown>
  }): Promise<ChatTurnAuthorization<void>> {
    const session = await requireUser(args.request)
    if (!session.ok) return session
    const { user } = session.value
    if (args.intent === 'turn') {
      const threadId = String(args.body?.threadId ?? '')
      const thread = await store.getThread(threadId)
      // Inaccessible reads are indistinguishable from missing ones — a
      // cross-workspace probe must not learn the thread exists.
      if (!thread || thread.workspaceId !== user.id) return { ok: false, response: notFound() }
    }
    // Replay authorizes on session only: turn ids are unguessable UUIDs minted
    // server-side and announced only on the owner's live stream.
    return { ok: true, tenantId: user.id, userId: user.id, context: undefined }
  }

  const routes = createChatTurnRoutes<void>({
    projectId: appSlug,
    authorize,
    store,
    turnStore: overrides.turnStore ?? createD1TurnEventStore(env.DB),
    produce: overrides.produce ?? createSandboxProduce(env),
    interactions: {
      resolveConnection: async ({ request, intent, body }) => {
        const session = await requireUser(request)
        if (!session.ok) return session
        const { user } = session.value
        const threadId =
          intent === 'answer'
            ? String(body?.threadId ?? '')
            : (new URL(request.url).searchParams.get('threadId') ?? '')
        const thread = await store.getThread(threadId)
        if (!thread || thread.workspaceId !== user.id) return { ok: false, response: notFound() }
        const connection = await resolveSidecarConnection(env, {
          workspaceId: user.id,
          userId: user.id,
          threadId,
        })
        if (!connection) return { ok: false, unavailable: 'SANDBOX_UNAVAILABLE' }
        return { ok: true, connection }
      },
    },
  })

  const upload = createUploadRoute({
    authorize: async ({ request }) => {
      const session = await requireUser(request)
      if (!session.ok) return session
      const { user } = session.value
      const resolveSink = overrides.uploadSink ?? ((scope) => resolveUploadSink(env, scope))
      return { ok: true, sink: await resolveSink({ workspaceId: user.id, userId: user.id }) }
    },
  })

  async function createThread(request: Request): Promise<Response> {
    const session = await requireUser(request)
    if (!session.ok) return session.response
    const body = (await request.json().catch(() => null)) as
      | { title?: string; firstMessage?: string }
      | null
    const thread = await store.createThread({
      workspaceId: session.value.user.id,
      ...(body?.title ? { title: body.title } : {}),
      ...(body?.firstMessage ? { firstMessage: body.firstMessage } : {}),
    })
    return Response.json({ thread })
  }

  async function listThreads(request: Request): Promise<Response> {
    const session = await requireUser(request)
    if (!session.ok) return session.response
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit')) || undefined
    const offset = Number(url.searchParams.get('offset')) || undefined
    const result = await store.listThreads({
      workspaceId: session.value.user.id,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    })
    return Response.json(result)
  }

  async function threadMessages(request: Request, params: { threadId: string }): Promise<Response> {
    const session = await requireUser(request)
    if (!session.ok) return session.response
    const thread = await store.getThread(params.threadId)
    if (!thread || thread.workspaceId !== session.value.user.id) return notFound()
    return Response.json({ thread, messages: await store.listMessages(params.threadId) })
  }

  return {
    auth,
    store,
    routes: { ...routes, createThread, listThreads, threadMessages },
    upload,
  }
}
