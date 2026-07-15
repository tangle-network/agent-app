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
  const authorize = async ({ request }: { request: Request }) => {
    const auth = await guardResolution(() => requireApiUser(request))
    if (!auth.ok) return auth
    const { user } = auth.value
    return { ok: true as const, tenantId: user.id, userId: user.id, context: { user } }
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
