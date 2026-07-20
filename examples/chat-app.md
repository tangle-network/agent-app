# A multimodal chat app on the assembled vertical

The whole server chat vertical — auth, thread/message tables, streaming turn
with buffered replay, file uploads, sidecar question answering — assembled from
factories. No hand-rolled orchestration: the turn engine is agent-runtime's
`handleChatTurn`, durability is `/stream`'s turn buffer, persistence is
`/chat-store`, asks are `/interactions`. This file is the seed of the
`create-agent-app --chat` scaffold.

Who owns each hop:

| Hop | Owner |
| --- | --- |
| Session auth + guards | `/app-auth` (`createAppAuth`) |
| Thread/message tables + CRUD | `/chat-store` (`createChatTables` + `createChatStore`) |
| Body parse, turn identity, routes | `/chat-routes` (`createChatTurnRoutes`) |
| Turn engine (NDJSON protocol, hook order) | agent-runtime `handleChatTurn` |
| Sandbox events → client vocabulary + persisted parts | `/chat-routes` (`createSandboxChatProducer`) |
| Buffered replay after a drop | `/stream` turn buffer (wired by default) |
| Upload → `PromptInputPart` descriptors | `/chat-routes` (`createUploadRoute`) |
| Ask answering (list/answer, 410 mapping, dedupe) | `/interactions` via `routes.interactions` |
| Composer, stream consumption, cards | `/web-react` |

## Schema (drizzle + one migration constant)

```ts
// db/schema.ts
import { createChatTables } from '@tangle-network/agent-app/chat-store'
import { TURN_EVENTS_MIGRATION_SQL } from '@tangle-network/agent-app/stream' // append to migrations

export const { threads, messages } = createChatTables({ workspaceTable: workspaces })
```

## Server (one worker route file)

```ts
// server/chat.ts
import { createAppAuth } from '@tangle-network/agent-app/app-auth'
import {
  createChatTurnRoutes, createSandboxChatProducer, createUploadRoute,
} from '@tangle-network/agent-app/chat-routes'
import { createChatStore } from '@tangle-network/agent-app/chat-store'
import { guardResolution } from '@tangle-network/agent-app/platform'
import { ensureWorkspaceSandbox, streamSandboxPrompt } from '@tangle-network/agent-app/sandbox'
import { createD1TurnEventStore } from '@tangle-network/agent-app/stream'
import { drizzle } from 'drizzle-orm/d1'
import { shell } from './sandbox-shell' // your SandboxRuntimeConfig (see build-agent-app)
import { messages, threads, users, sessions, accounts, verifications } from '../db/schema'

export function buildChat(env: Env) {
  const db = drizzle(env.DB)
  const { requireApiUser } = createAppAuth({
    appName: 'Acme Agent', baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
    db, schema: { users, sessions, accounts, verifications },
  })

  // The guard throws a JSON 401; guardResolution adapts it to {ok, response}.
  // A dispatched/synthetic turn (e.g. a follow-up the product raised itself, not
  // typed by the user) can set `insertUserMessage: false` to run the turn without
  // surfacing a new `role:'user'` row. It only subtracts — the engine's retry
  // dedup still applies — and defaults to today's behavior when omitted.
  const authorize = async ({ request, body }: { request: Request; body?: { planFollowUp?: unknown } }) => {
    const auth = await guardResolution(() => requireApiUser(request))
    if (!auth.ok) return auth
    const { user } = auth.value
    return {
      ok: true as const, tenantId: user.id, userId: user.id, context: { user },
      ...(body?.planFollowUp ? { insertUserMessage: false } : {}),
    }
  }

  const routes = createChatTurnRoutes({
    projectId: 'acme-agent',
    authorize,
    store: createChatStore(db, { threads, messages }),
    turnStore: createD1TurnEventStore(env.DB),
    produce: async ({ prompt, body, identity, executionId }) => {
      const box = await ensureWorkspaceSandbox(shell, {
        workspaceId: identity.tenantId, userId: identity.userId, harness: 'opencode',
      })
      return createSandboxChatProducer({
        model: body.model,
        events: streamSandboxPrompt(shell, box, prompt, {
          sessionId: identity.sessionId, executionId,
          model: body.model, effort: body.effort,
          interactions: { question: true, plan: true },
        }),
      })
    },
    interactions: {
      resolveConnection: async ({ request, body }) => {
        const auth = await authorize({ request })
        if (!auth.ok) return auth
        const threadId = String(body?.threadId ?? new URL(request.url).searchParams.get('threadId') ?? '')
        const box = await ensureWorkspaceSandbox(shell, { workspaceId: auth.userId, harness: 'opencode' })
        const c = box.connection
        if (!c?.runtimeUrl) return { ok: false as const, unavailable: 'SANDBOX_UNAVAILABLE' }
        // sessionId = the agent session the turn streams under (the thread id).
        return { ok: true as const, connection: { runtimeUrl: c.runtimeUrl, authToken: c.authToken, sessionId: threadId } }
      },
    },
  })

  const upload = createUploadRoute({
    authorize: async ({ request }) => {
      const auth = await authorize({ request })
      if (!auth.ok) return auth
      const box = await ensureWorkspaceSandbox(shell, { workspaceId: auth.userId, harness: 'opencode' })
      return { ok: true as const, sink: box.fs }
    },
  })

  return { routes, upload }
}

// worker fetch handler
export async function handleChat(request: Request, env: Env, ctx: ExecutionContext) {
  const { routes, upload } = buildChat(env)
  const url = new URL(request.url)
  if (url.pathname === '/api/chat' && request.method === 'POST') return routes.turn(request, ctx)
  const replay = url.pathname.match(/^\/api\/chat\/replay\/([^/]+)$/)
  if (replay) return routes.replay(request, { turnId: replay[1]! })
  if (url.pathname === '/api/chat/upload') return upload(request)
  if (url.pathname === '/api/chat/interactions' && request.method === 'GET') return routes.interactions!.list(request)
  if (url.pathname === '/api/chat/interactions' && request.method === 'POST') return routes.interactions!.answer(request)
  return new Response('Not found', { status: 404 })
}
```

## Client (composer → parts → stream → resume)

```tsx
// app/chat.tsx
import { ChatComposer, chatTurnRequestInit, streamChatTurn, type ComposerFile } from '@tangle-network/agent-app/web-react'

function Chat({ threadId }: { threadId: string }) {
  const [files, setFiles] = useState<ComposerFile[]>([])

  async function attach(list: FileList) {
    const form = new FormData()
    for (const f of Array.from(list)) form.append('files', f)
    const res = await fetch('/api/chat/upload', { method: 'POST', body: form })
    const { files: uploaded } = await res.json()
    setFiles((prev) => [...prev, ...uploaded.map((u) => ({
      id: u.id, name: u.name, size: u.size, kind: 'file' as const, status: 'ready' as const, part: u.part,
    }))])
  }

  async function send(content: string, parts: ComposerFile['part'][]) {
    setFiles([])
    await streamChatTurn({
      start: () => fetch('/api/chat', chatTurnRequestInit({ threadId, content, parts })),
      resume: (turnId, fromSeq) => fetch(`/api/chat/replay/${turnId}?fromSeq=${fromSeq}`),
      callbacks: { onText: appendDelta, onToolCall: showToolChip, onInteraction: showQuestionCard },
    })
  }

  return <ChatComposer onSendParts={send} onAttach={attach} pendingFiles={files} onRemoveFile={(id) => setFiles((p) => p.filter((f) => f.id !== id))} />
}
```

Uploads ≤700 KiB come back as inline `data:` parts; bigger files are written
into the sandbox workspace and referenced by `path` (the ~1 MiB gateway body
cap makes that two-step mandatory). Question cards render with
`InteractionQuestionCard` + `useChatInteractions` and answer through
`/api/chat/interactions` — see `/web-react`.

## Advanced hooks (optional)

A complex product turn-orchestrator does more than stream: it holds a
single-flight lock, keeps the client alive through long tool calls, gates on
domain readiness, and books telemetry. `createChatTurnRoutes` exposes five
optional seams for exactly that — **omit any one and the route behaves exactly
as above.** They compose with `authorize` / `produce` / `store` / `interactions`.

```ts
const routes = createChatTurnRoutes({
  projectId: 'acme-agent',
  authorize, store, turnStore, produce, // as above

  // 1. Single-flight lock — acquired before any side effect, released once
  //    when the turn settles (drain finish), on short-circuit, or on throw.
  turnLock: {
    acquire: async ({ identity, executionId }) => {
      const got = await acquireLock(identity.tenantId, identity.sessionId, executionId)
      return got.ok
        ? { acquired: true, handle: got.lockId }
        : { acquired: false, response: Response.json({ code: 'turn_in_flight' }, { status: 409 }) }
    },
    release: (lockId) => releaseLock(lockId as string),
  },

  // 2. Domain-readiness gate — short-circuit BEFORE the producer runs (the user
  //    row is already persisted; return the assistant side of the turn).
  contextGate: async ({ identity, prompt }) => {
    const ready = await computeContextSufficiency(identity.tenantId)
    return ready.ok ? { proceed: true } : { proceed: false, response: cannedAskForContext(ready.missing) }
  },

  // 3. Observe + augment the assembled input before the producer runs.
  beforeTurn: async ({ prompt, priorMessages, identity }) => {
    const composed = await composeSystemPromptWithCertified(identity.tenantId)
    return { priorMessages: [systemMessage(composed), ...priorMessages] }
  },

  // 4. Deterministic run telemetry — start, then exactly one of complete/error.
  lifecycle: {
    onTurnStart: ({ identity, executionId }) => startRun(identity, executionId),
    onTurnComplete: ({ finalText, usage, durationMs }) => endRun({ pass: true, finalText, usage, durationMs }),
    onTurnError: ({ error, durationMs }) => endRun({ pass: false, error, durationMs }),
  },

  // 5. Keepalive while the producer is quiet (provisioning, first-token wait).
  //    Window resets on every real event; a chatty producer never triggers one.
  heartbeat: {
    intervalMs: 5_000,
    event: ({ elapsedMs }) => ({ type: 'run-phase', data: { phase: 'working', heartbeat: true, elapsedMs } }),
  },

  // Raw producer events for telemetry, before the engine frames them (distinct
  // from `onEvent`, which sees the engine-framed stream incl. lifecycle).
  onRawEvent: (event) => emitToTrace(event),
})
```

Each seam replaces a slice a hand-rolled generator otherwise owns: the lock is
the dual-scope session/workspace guard; `contextGate` is the sufficiency
short-circuit; `beforeTurn` is the prompt-composition step; `lifecycle` is the
`startRun`/`endRun`/`flush` triple (fires on failure too); `heartbeat` is the
`withHeartbeat` wrapper around silent waits. `handleChatTurn` stays the turn
engine underneath — these only wrap its input, its producer stream, and its
settle.
