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
 *   producer     the hybrid lane from `src/sandbox.ts`: the Router answers
 *                first and escalates to the box through `sandbox_run`
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

import { createDurableTurnLock } from '@tangle-network/agent-app/turn-stream'
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
import { appSlug, createHybridLane, createPrewarmRoute, resolveSidecarConnection, resolveUploadSink } from './sandbox'

export interface ChatAppOverrides {
  /** Test seam: an in-memory drizzle db (the e2e test runs the REAL
   *  `migrations/0001_init.sql` into better-sqlite3). Default: `drizzle(env.DB)`. */
  db?: ChatDatabase
  /** Test seam: `createMemoryTurnEventStore()`. Default: D1-backed buffer. */
  turnStore?: TurnEventStore
  /** Test seam: a fake producer. Default: the real hybrid lane. */
  produce?: (args: ChatTurnProduceArgs<void>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
  /** Test seam: where large uploads land. Default: the workspace box's fs. */
  uploadSink?: (scope: { workspaceId: string; userId: string }) => Promise<SandboxUploadSink | null>
  /** Server-trusted identity for a private gateway chat assembly. Never read
   *  this value from a request body or header. */
  trustedUserId?: string
  /** Test seam at the sidecar transport boundary; real route authorization remains active. */
  sidecarConnection?: typeof resolveSidecarConnection
}

export interface ChatApp {
  auth: AppAuth
  store: ChatStore
  turnStore: TurnEventStore
  routes: ChatTurnRoutes & {
    /** POST `{ title?, firstMessage? }` → `{ thread }`. */
    createThread(request: Request): Promise<Response>
    /** GET → `{ threads, total, limit, offset }`. */
    listThreads(request: Request): Promise<Response>
    /** GET → `{ thread, messages }` — the full typed transcript. */
    threadMessages(request: Request, params: { threadId: string }): Promise<Response>
  }
  upload(request: Request): Promise<Response>
  /** POST: warm the open workspace's box (`AgentWorkspaceLayout`'s `prewarm`). */
  prewarm(request: Request): Promise<Response>
}

const notFound = () => Response.json({ error: 'Thread not found' }, { status: 404 })

export function buildChatApp(env: AppEnv, overrides: ChatAppOverrides = {}): ChatApp {
  const db = overrides.db ?? (drizzle(env.DB) as unknown as ChatDatabase)
  const store = createChatStore(db, { threads, messages })
  const turnStore = overrides.turnStore ?? createD1TurnEventStore(env.DB)

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
    if (overrides.trustedUserId) {
      return { ok: true as const, value: { user: { id: overrides.trustedUserId } } }
    }
    return guardResolution(() => auth.requireApiUser(request))
  }

  /** The one product-supplied access step for turn + replay. Identity comes
   *  from the SESSION, never from the request body — a client cannot forge
   *  `userId`/`workspaceId`. */
  async function authorize(args: {
    request: Request
    intent: 'turn' | 'replay' | 'running'
    body?: Record<string, unknown>
    threadId?: string
  }): Promise<ChatTurnAuthorization<void>> {
    const session = await requireUser(args.request)
    if (!session.ok) return session
    const { user } = session.value
    // `turn` and `running` are thread-scoped and MUST verify ownership: both name
    // a thread the caller supplies (POST body for turn, `?threadId=` for running,
    // whose response enumerates that thread's live turn ids). Inaccessible reads
    // are indistinguishable from missing ones — a cross-workspace probe must not
    // learn the thread exists.
    if (args.intent === 'turn' || args.intent === 'running') {
      const threadId = args.intent === 'turn' ? String(args.body?.threadId ?? '') : args.threadId
      const thread = threadId ? await store.getThread(threadId) : null
      if (!thread || thread.workspaceId !== user.id) return { ok: false, response: notFound() }
    }
    // Replay authorizes on session only: turn ids are unguessable UUIDs minted
    // server-side and announced only on the owner's live stream.
    return { ok: true, tenantId: user.id, userId: user.id, context: undefined }
  }

  const durableLock = env.TURN_STREAM && env.TURN_STREAM_AUTH_SECRET
    ? createDurableTurnLock<void>({ namespace: env.TURN_STREAM, auth: { secret: env.TURN_STREAM_AUTH_SECRET }, scopeOf: () => 'workspace',
      onRefused: active => Response.json({ error: { code: 'workspace_turn_in_flight', message: `Execution ${active.executionId} in thread ${active.threadId} still owns this workspace. If observation was lost, the deployment operator must verify that exact backend execution stopped and use a fenced reconciliation adapter; elapsed time or another UUID is not recovery.`, executionId: active.executionId, threadId: active.threadId } }, { status: 409 }),
    })
    : null
  interface Admission { handle: unknown; started: boolean; producer?: ChatTurnRouteProducer; userMessageId?: string }
  const admissions = new Map<string, Admission>()
  const lane = overrides.produce ? null : createHybridLane(env)
  // Native Sandbox execution keeps the backend-terminal ownership check.
  // Router option data goes directly to the shared route before its lock.
  const nativeProduce = async (args: ChatTurnProduceArgs<void>) => {
    const admission = admissions.get(args.executionId)
    if (!admission) throw new Error('Turn admission is unavailable')
    admission.started = true
    admission.producer = await (overrides.produce ?? lane!.produce.sandbox)(args)
    return admission.producer
  }
  const routes = createChatTurnRoutes<void>({
    turnLock: {
      acquire: async args => {
        if (!durableLock) return { acquired: false, response: Response.json({ error: 'Durable turn locking is not configured', code: 'chat.lock_not_configured' }, { status: 503 }) }
        const acquired = await durableLock.acquire(args)
        if (!acquired.acquired) return acquired
        admissions.set(args.executionId, { handle: acquired.handle, started: false })
        return { acquired: true, handle: args.executionId }
      },
      release: async handle => {
        const id = String(handle)
        const admission = admissions.get(id)
        admissions.delete(id)
        if (!admission) return
        if (admission.started && !admission.producer?.terminalObserved?.()) return
        if (admission.userMessageId) await store.updateMessage(admission.userMessageId, { extras: { backendTerminal: true } })
        await durableLock?.release(admission.handle)
      },
    },
    // `projectId` also names the Intelligence project every turn's trace goes to (first_text_ms included). The route
    // reads the Sandbox product key and warns in the Worker log when an export fails; pass `turnTrace: false` only
    // with an exemption in signoff.config.mjs.
    projectId: appSlug,
    authorize,
    store,
    turnStore,
    // The box starts the moment the caller is admitted when the ask needs a computer.
    ...(lane ? { afterAuthorize: lane.afterAuthorize } : {}),
    beforeTurn: async args => {
      const admission = admissions.get(args.executionId)
      if (args.userMessageId) {
        if (admission) admission.userMessageId = args.userMessageId
        await store.updateMessage(args.userMessageId, { extras: { turnStreamId: args.turnStreamId, backendTerminal: false } })
      }
    },
    produce: overrides.produce ? nativeProduce : { ...lane!.produce, sandbox: nativeProduce },
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
        const connection = await (overrides.sidecarConnection ?? resolveSidecarConnection)(env, {
          workspaceId: user.id,
          userId: user.id,
          threadId,
        }, { readOnly: intent === 'list' })
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
      return {
        ok: true,
        sink: await resolveSink({ workspaceId: user.id, userId: user.id }),
      }
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

  const prewarmRoute = createPrewarmRoute(env, async request => {
    const session = await requireUser(request)
    return session.ok ? session.value.user.id : null
  })

  return {
    auth,
    store,
    turnStore,
    routes: { ...routes, createThread, listThreads, threadMessages },
    upload,
    prewarm: request => prewarmRoute(request),
  }
}
