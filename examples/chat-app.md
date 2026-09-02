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
| Model failover on a dead upstream (attributed, pre-first-byte) | `/chat-routes` (`openEvents` + `fallbackModels` on the producer) |
| Buffered replay after a drop | `/stream` turn buffer (wired by default) |
| Upload → `PromptInputPart` descriptors | `/chat-routes` (`createUploadRoute`) |
| Store-backed attachments (validate, dispatch, promote) | `/chat-routes` (`resolveChatAttachments`, `buildDispatchParts`, `promoteAgentFilePart`) |
| Ask answering (list/answer, 410 mapping, dedupe) | `/interactions` via `routes.interactions` |
| Durable plan projection | `/plans` codec + `/chat-routes` `withDurableChatProjection` (structural) |
| Composer, stream consumption, cards | `/web-react` |

## Schema (Drizzle + shared migration constants)

```ts
// db/schema.ts
import { createChatTables } from '@tangle-network/agent-app/chat-store'
import { PREWARM_CLAIM_TABLE_DDL } from '@tangle-network/agent-app/sandbox' // append to migrations
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
import {
  createD1PrewarmClaimStore,
  ensureWorkspaceSandbox,
  peekWorkspaceSandbox,
  runForegroundSandboxSingleFlight,
  streamSandboxPrompt,
} from '@tangle-network/agent-app/sandbox'
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

  const ensureForegroundBox = (scope: { workspaceId: string; userId?: string }) =>
    runForegroundSandboxSingleFlight({
      claim: createD1PrewarmClaimStore(env.DB),
      workspaceId: scope.workspaceId,
      harness: 'opencode',
      provision: () => ensureWorkspaceSandbox(shell, { ...scope, harness: 'opencode' }),
      peek: () => peekWorkspaceSandbox(shell, scope),
      adopt: ({ box }) => box,
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
      const box = await ensureForegroundBox({
        workspaceId: identity.tenantId, userId: identity.userId,
      })
      const planEnabled = body.enablePlans === true
      return createSandboxChatProducer({
        model: body.model,
        // Reactive model failover, ON by default: a dead upstream (quota wall,
        // 502, provider outage) moves the turn to the next model BEFORE any
        // client-visible byte. Never silent — the persisted row + billing
        // receipt name the model that served, and the transcript gets a notice.
        fallbackModels: ['gemini-2.5-flash-lite', 'gpt-5-mini'],
        // Defaults keep cold source startup (120 s, through the first event)
        // separate from provider first response (60 s after that event).
        // Override with `openTimeoutMs` / `firstResponseTimeoutMs` only when a
        // product has measured requirements that differ.
        // No separate producer planMode option: close over the product's
        // per-turn policy and auto-decline plan asks no card will render.
        isRenderableInteraction: (kind) =>
          kind === 'question' || (kind === 'plan' && planEnabled),
        openEvents: ({ model, attempt, signal }) => streamSandboxPrompt(shell, box, prompt, {
          // A failover attempt is a NEW dispatch — its own execution identity.
          sessionId: identity.sessionId,
          executionId: attempt === 1 ? executionId : `${executionId}-f${attempt}`,
          model, effort: body.effort, signal,
          interactions: { question: true, plan: true },
        }),
      })
    },
    interactions: {
      resolveConnection: async ({ request, body }) => {
        const auth = await authorize({ request })
        if (!auth.ok) return auth
        const threadId = String(body?.threadId ?? new URL(request.url).searchParams.get('threadId') ?? '')
        const box = await ensureForegroundBox({ workspaceId: auth.userId })
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
      const box = await ensureForegroundBox({ workspaceId: auth.userId })
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
  // Reconnect discovery: a client that dropped mid-turn asks which turn id is
  // live for its thread, then replays it. Returns the running turn id or null.
  if (url.pathname === '/api/chat/running' && request.method === 'GET') return routes.running(request)
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
      callbacks: {
        onText: appendDelta,
        onToolCall: showToolChip,
        onInteraction: showQuestionCard,
        onNotice: ({ noticeKind, text }) => showTranscriptNotice(noticeKind, text),
        onErrorEvent: (message) => showTurnError(message), // existing string path
        onErrorEventDetail: ({ code, details }) => recordFailureDetail(code, details),
      },
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

The producer keeps the flattened stream vocabulary: `text`, `reasoning`,
`tool_call`, `tool_result`, and `usage`, plus additive `notice` lines and
structured `{ type: 'error', data: { message, code?, details? } }` lines.
`onNotice` consumes visible warning/auto-decline notices;
`onErrorEventDetail` receives the structured fields while the existing
`onErrorEvent(message)` callback continues to fire unchanged.

## Attachments (store-backed files, #224)

An attachment is a file the product already saved to its own store (vault /
`/object-store`) ahead of the turn — distinct from an inline upload part (which
carries bytes) and from a `@`-mention (a path the sandbox already holds). Every
path is re-validated and every size re-derived from the STORED body, never the
client-reported one. Storage is REQUIRED injection — `ReadAttachmentFn` /
`AtomicAttachmentWriter` (`./attachment-store`) — there is no default store.

`WriteAttachmentFn` and its original `{ ok: true }` result remain available for
existing products. That legacy lane does not promise batch rollback. New code
should use the atomic writer adapter below, which keeps the write and its
ownership-safe cleanup together.

```ts
import {
  resolveChatAttachments, buildDispatchParts, promoteAgentFilePart,
  createAtomicAttachmentWriter, createSandboxChatProducer,
} from '@tangle-network/agent-app/chat-routes'
import type {
  AtomicAttachmentWriter,
  AttachmentWriteOwnership,
  ReadAttachmentFn,
} from '@tangle-network/agent-app/chat-routes'
import { createR2ObjectStore } from '@tangle-network/agent-app/object-store' // or a fleet's own vault adapter

const store = createR2ObjectStore({ bucket: env.ATTACHMENTS })

const readAttachment: ReadAttachmentFn = async (scopeId, path) => {
  const obj = await store.get(`${scopeId}/${path}`)
  if (!obj) return { ok: false, reason: 'not found' }
  const bytes = new Uint8Array(await new Response(obj.stream()).arrayBuffer())
  return { ok: true, size: obj.size, bytes, mediaType: obj.contentType }
}

const abortAttachment: AtomicAttachmentWriter['abort'] = async (
  scopeId: string,
  ownership: AttachmentWriteOwnership,
) => {
  // Upload and promotion paths contain a fresh ownership suffix, so each key is
  // immutable. If a product reuses keys, replace this with compare-and-delete.
  await store.delete(`${scopeId}/${ownership.path}`)
}

const attachmentWriter: AtomicAttachmentWriter = createAtomicAttachmentWriter({
  abort: abortAttachment,
  write: async (scopeId, path, content, { mediaType, ownership }) => {
    const bytes = typeof content === 'string' ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : content
    await store.put(`${scopeId}/${path}`, bytes, { contentType: mediaType })
    return {
      ok: true,
      receipt: {
        ownership,
        rollback: () => abortAttachment(scopeId, ownership),
      },
    }
  },
})

// In the turn route, before dispatch: validate the wire `attachments` field
// and re-derive size, then fold it into the dispatched prompt parts.
const resolved = await resolveChatAttachments(body.attachments, { scopeId: identity.tenantId, readAttachment })
if (!resolved.succeeded) return Response.json({ error: resolved.error }, { status: 400 })

const dispatch = await buildDispatchParts({
  text, attachments: resolved.value, mentions, history, systemPrompt, profileWireBytes,
  scopeId: identity.tenantId, readAttachment,
  resolveAttachmentPath: (path) => `/workspace/${path}`,
})
if (!dispatch.succeeded) return Response.json({ error: dispatch.error }, { status: 413 })

// In the producer: promote harness-emitted files into the same store instead of
// persisting a transient data:/sandbox-path url.
createSandboxChatProducer({
  events,
  promoteFilePart: (raw) => promoteAgentFilePart({
    raw, box, scopeId: identity.tenantId, sessionId: identity.sessionId, attachmentWriter,
  }),
})
```

`/object-store` is a ready-made backend for both seams when a product has no
vault of its own; fleet apps that already have one (gtm's KV vault) inject
their own `ReadAttachmentFn`/`AtomicAttachmentWriter` instead of this module — the
seams are storage-agnostic by design.

## Attachment upload + composer + transcript (#234)

#224 above is the store-backed attachment vertical's read/dispatch half; this
is the other half — the upload route, the composer's staged-upload hook, and
the transcript renderer — so a fleet app no longer hand-rolls its own vault
upload route to get there.

### Server: hardened durable-store upload route

```ts
import { createAttachmentUploadRoute } from '@tangle-network/agent-app/chat-routes'

const uploadAttachment = createAttachmentUploadRoute({
  authorize: async ({ request }) => {
    const auth = await authorize({ request }) // same seam as the turn route: auth + rate-limit + scope
    if (!auth.ok) return auth
    return { ok: true as const, scopeId: auth.tenantId }
  },
  attachmentWriter, // the same #224 adapter defined above
})
```

`authorize` owns auth, rate limiting (a 429 rides `{ok:false, response}`
exactly like a 401), and the store scope — never a query param. A raw-bytes
download route reads back through the matching `readAttachment`:

```ts
async function downloadAttachment(request: Request, scopeId: string) {
  const path = new URL(request.url).searchParams.get('path') ?? ''
  const attachment = await readAttachment(scopeId, path)
  if (!attachment.ok) return new Response('Not found', { status: 404 })
  return new Response(attachment.bytes, { headers: { 'content-type': attachment.mediaType } })
}
```

### Client: staged-upload composer hook

```tsx
import { ChatComposer, useComposerAttachments } from '@tangle-network/agent-app/web-react'

const attachments = useComposerAttachments({
  uploadUrl: '/api/chat/attachments',
  onReject: (reason) => toast(reason),
})

<ChatComposer
  pendingFiles={attachments.composerFiles}
  onAttach={(files) => attachments.addFiles(files)}
  onSend={(text) => streamChatTurn({
    start: () => fetch('/api/chat', chatTurnRequestInit({ threadId, content: text, attachments: attachments.references })),
    resume: (turnId, fromSeq) => fetch(`/api/chat/replay/${turnId}?fromSeq=${fromSeq}`),
    callbacks: { onText: appendDelta },
  })}
/>
```

`references` is the server's pass-through `ChatAttachmentInput[]` — it rides
straight onto the turn body's `attachments` field with no client-side recompute
of size or mime; the server already derived both from the sniffed bytes.

### Transcript: raw-bytes attachment renderer

```tsx
<ChatMessages
  messages={messages}
  resolveAttachmentUrl={(part) => `/api/chat/attachments/file?path=${encodeURIComponent(part.path)}`}
  ...
/>
```

`resolveAttachmentUrl` is additive — omit it and `ChatMessages` renders exactly
as before. `MessageAttachments` is also exported standalone for a transcript
that renders attachments outside `ChatMessages`.

## Durable plan and question workflow

agent-app shipped a `/durable-chat` subpath here — an authorization-scoped
command/settlement protocol (CAS plan decisions, stable follow-up receipts,
answer intent/ack/finalize) over a product-supplied store. It was **removed in
0.44.0**: it exported 60 symbols and, across nine consumer repos on their
default branches, had exactly zero imports. Three apps that needed a plan
decision hand-rolled a local one instead, which is the signal that the
abstraction was not the one they wanted.

What survives, and what to use:

- The durable plan **authority** is the Sandbox SDK's — `SandboxSession.plan()`.
  Read it there; do not re-implement a plan state machine.
- `/plans` still owns the browser-safe projection (lifecycle event parsing, the
  persisted `type:'plan'` codec, revision-aware transcript keys).
- `/chat-routes` still exports `withDurableChatProjection`, which is fully
  structural: hand it any `{ observe, materialize }` object and it folds your
  materialized parts into the producer lane. Your own store, your own protocol.
- `/interactions`' `createInteractionAnswerRoute` still takes a `durable` seam,
  so answer persistence stays available without the removed module.

## Advanced hooks (optional)

A complex product turn-orchestrator does more than stream: it holds a
single-flight lock, keeps the client alive through long tool calls, gates on
domain readiness, and books telemetry. `createChatTurnRoutes` exposes optional
seams for exactly that — **omit any one and the route behaves exactly as
above.** They compose with `authorize` / `produce` / `store` / `interactions`.

**Stability** — `turnLock`, `contextGate`, `beforeTurn`, `lifecycle`,
`heartbeat` and `onRawEvent` are all **stable and safe to depend on**, as is the
`authorize` result's `insertUserMessage` flag (used above for
dispatched/synthetic follow-up turns). They graduated in #227, once each had two
independent product consumers exercising it — the bar this package uses, because
a single consumer's usage is indistinguishable from that consumer's assumptions.

They stay flat/top-level rather than grouped under a `hooks` object: the
grouping would break every shipped call for no mechanism gain, and this
package's exports are additive-only. `onRawEvent` keeps its `(event, context)`
signature for the same reason. Its event type is exported as `ChatRouteEvent`
(also the return type of `heartbeat.event`) if you want a standalone handler
rather than an inline literal.

```ts
const routes = createChatTurnRoutes({
  projectId: 'acme-agent',
  authorize, store, turnStore, produce, // as above

  // 1. Single-flight lock — acquired before any side effect,
  //    released once when the turn settles (drain finish), short-circuit, throw.
  turnLock: {
    acquire: async ({ identity, executionId }) => {
      const got = await acquireLock(identity.tenantId, identity.sessionId, executionId)
      return got.ok
        ? { acquired: true, handle: got.lockId }
        : { acquired: false, response: Response.json({ code: 'turn_in_flight' }, { status: 409 }) }
    },
    release: (lockId) => releaseLock(lockId as string),
  },

  // 2. Domain-readiness gate — short-circuit BEFORE the producer
  //    runs (the user row is already persisted; return the assistant side).
  contextGate: async ({ identity, prompt }) => {
    const ready = await computeContextSufficiency(identity.tenantId)
    return ready.ok ? { proceed: true } : { proceed: false, response: cannedAskForContext(ready.missing) }
  },

  // 3. Observe + augment the assembled input before the producer runs.
  //    Return a patch, or return nothing and mutate `context` for `produce` to read.
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

  // 5. Keepalive while the producer is quiet (provisioning, first-token
  //    wait). Window resets on every real event; a chatty producer never fires one.
  heartbeat: {
    intervalMs: 5_000,
    event: ({ elapsedMs }) => ({ type: 'run-phase', data: { phase: 'working', heartbeat: true, elapsedMs } }),
  },

  // 6. Raw producer events for telemetry, before the engine frames them (distinct
  //    from `onEvent`, which sees the engine-framed stream incl. lifecycle). Never
  //    sees an injected keepalive; a throw here is swallowed, never fails the turn.
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
