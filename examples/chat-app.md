# Assemble a multimodal chat app

Use `create-agent-app --chat` for a runnable application. Its maintained
[chat assembly](../create-agent-app/template-chat/src/chat.ts),
[backend selection and provisioning](../create-agent-app/template-chat/src/sandbox.ts),
[Worker routes](../create-agent-app/template-chat/src/worker.ts), and
[client conversation](../create-agent-app/template-chat/web/Conversation.tsx)
are the executable reference. Extend those product files rather than copying a
second authentication, provisioning, stream, or persistence loop from this guide.

| Responsibility | Owner |
| --- | --- |
| Session authentication | `/app-auth`, with product workspace and thread access checks |
| Tables, canonical parts, messages and usage | `/chat-store` |
| Admission, retry identity, replay and completion | `/chat-routes`, using Runtime's `handleChatTurn` |
| Router tools and escalation through `sandbox_run` | Router/Hybrid producer configuration |
| Sandbox events and persisted projection | `createSandboxChatProducer` |
| Questions and plans | `/interactions`, `/plans`, and Sandbox's plan authority |
| Composer, reconnect, reasoning and cards | `/web-react` |

## One route assembly

The product supplies the authenticated `authorize`, scoped `store`, backend
options, and optional domain seams below. They are product callbacks, not SDK
exports. The scaffold supplies runnable single-user wiring and migrations;
products add their operation-specific authorization and billing policy.

```ts
import { createChatTurnRoutes } from '@tangle-network/agent-app/chat-routes'

const routes = createChatTurnRoutes({
  projectId: 'acme-agent',
  env,
  authorize,
  store,
  turnStore: {
    db: env.DB,
    lock: {
      namespace: env.TURN_STREAM,
      auth: { secret: env.TURN_STREAM_AUTH_SECRET },
    },
  },
  produce: {
    model: config.model.default,
    systemPrompt: config.systemPrompt,
    harness: config.harness,
  },
})

// POST /api/chat. Keep the host continuation bound to its ExecutionContext.
return routes.turn(request, { waitUntil: work => ctx.waitUntil(work) })
```

`turnStore` accepts these bindings or an existing `TurnEventStore`. Bindings
assemble D1 replay and an authenticated workspace lock. With `env`, the same
lock is inherited even when the product supplies its own event store. Native
producers keep the lock until backend termination is observed; lost observation
never permits another dispatch. `turnLock: false` is the explicit opt-out.
The buffer serves live reconnect; message storage serves durable history.

### Prewarm the same lock before send

Mount `routes.prewarm(request)` at the existing POST prewarm route. It uses the
same bindings and lock as send. The existing `running` authorizer verifies
access and supplies the workspace identity. It also receives page-open calls
without a thread: the product may authorize its verified workspace or refuse.
Any named thread still needs an access check. The inherited handler never provisions paid compute.
`prewarm: false` disables it. The descriptor's `region` controls first placement
of lock channels; it cannot move an existing object.

Products needing authenticated workspace-level or paid preparation retain
`createWorkspacePrewarmRoute` from `/sandbox` with their existing spend authority.

The prewarm authorizer returns `workspaceId` only after verifying the member can
start a turn in that workspace. Request-body identity is ignored. The route adds
`turn_lock` as a keyed step on page-open, composer-focus and heartbeat; products
supply no local lock-warm step. The step calls the same lock factory's `warm`,
never acquires or releases a lock, and runs alongside existing catalog, billing
and box work. A box failure does not discard a successful lock receipt.

```ts
const prewarm = createWorkspacePrewarmRoute({
  turnStore, // the descriptor also passed to createChatTurnRoutes
  authorize: authorizeWorkspaceWarm,
})
// An allowed authorization includes { workspaceId, key, warm } or { workspaceId, steps }.
```

Apply `WARM_RECEIPT_TABLE_DDL` from `/sandbox` through the product migration runner
before adoption. Receipts default to the descriptor's D1 binding; an explicit
`receipts` store still wins. An unexpired receipt avoids another DO request;
`warm.turn_lock` in `Server-Timing` reports hit/miss/joined/failed. Its short TTL
keeps the readiness claim below the DO idle-eviction window. This is an
optimization: send still performs the authenticated single-flight acquire.


Mount `routes.replay(request, {turnId})`, `routes.running(request)`, and configured
`routes.interactions.list/answer` handlers as in the scaffold Worker. Replay
handles are separate from client message identifiers. A deliberate retry keeps
`turnId` and supplies a new `retryAttemptId`; transport retries reuse both.
See [turn observation](../docs/turn-observation.md) for cursor and terminal rules.

### Backend defaults and overrides

With `env.TANGLE_API_KEY`, the default lane answers through the Router and adds
`sandbox_run`. Files and deployments without that key use the sandbox lane.
`produce` can be omitted when `env.MODEL_NAME` supplies the model; a data object
supplies the product model, prompt, harness, effort, interactions and optional
existing sandbox `shell`. Provisioning uses the D1 claim store, requiring its
migration. `produce: { router: false }` explicitly keeps the sandbox lane.

Existing `produce(args)` functions and Router/Sandbox callback declarations
remain authoritative: a package bump never substitutes a deployment key for a
product's workspace child key or discards its domain tools. Those consumers
inherit binding-backed locks and prewarm; migration to backend data is explicit.

### Authorization remains product policy

Authenticate the caller and check the requested workspace, thread, and operation
before returning success. Teams use the shared role rules; pending invitations
grant no access. Verify replay ownership too: an unguessable handle is not an
access check. Derive tenant, member, model-key and tool authority from trusted
server state. A request body cannot grant a user, workspace, role, or payer.

A normal turn returns `{ok: true, tenantId, userId, context}`. Reads can return
`{ok: true, intent: 'replay', tenantId, userId}` or matching `running` after the
same access checks. Identity-only success cannot authorize a turn. Existing
full successes without an intent remain valid for reads. Return
`{ok: false, response}` for an expected refusal.

A server-authorized plan follow-up can set `insertUserMessage: false` to attach
to work its decision already dispatched. This only suppresses an insert; it
does not override retry deduplication. A client `planFollowUp` field alone
cannot authorize the dispatch or skip its user row.

### Router first; Sandbox after admission

The descriptor starts the Router model call after authorization, overlapping the
lock, user insert and gates. The model service enforces spend. Output stays
buffered until admission commits; refusal aborts the call and discards it.
Reused user rows complete admission before another model call, so a refused
answered retry does not buy another answer.

`when` declares backend eligibility; omit it for Router-only products. The
scaffold uses `turnCarriesFiles` to keep files on the Sandbox lane. Sandbox
callbacks and ordinary `produce(args)` functions start after admission.
Declare only per-request Router execution in `router`; a backend sharing a
thread's native execution identity belongs in `sandbox`.

Callbacks may return Router, Hybrid or Sandbox options, or a custom producer
with an asynchronous `stream`. Options bind the request's trace, cancellation
and admission fence automatically. Router defaults `userMessage` to prompt
text and `history` to prior user/assistant text; explicit product values win.
Custom producers await `args.admitted` before tools, durable effects, or reading
`beforeTurn` context changes, and forward `args.admissionSignal` to transport.
An options object's existing `admitted` promise adds its domain prerequisite to
the route fence. `beforeTurn` cannot patch a prompt already sent to the model.

Keep stable prompt bytes ahead of current-turn context:

```ts
systemPrompt: {
  profile: effectiveProfile,
  toolNames: tools.map(tool => tool.name),
  stable: [workspaceInstructions],
  context: [turnContext],
},
```

A Hybrid `box` supplies product-owned acquisition and task execution. The shared
producer starts it once, speculates when execution is likely, and exposes
`sandbox_run`; `startHybridBox` can overlap an authorized early start through
`box.started`. The scaffold keeps cross-isolate provisioning single-flight and
warms open workspaces through `createWorkspacePrewarmRoute`.

For reopenable Sandbox sources, use `openEvents({model, attempt, signal})` and
product-selected `fallbackModels`. Failover occurs before visible output and
retains served-model attribution and a transcript notice. A failover dispatch
needs a distinct attempt identity. An already-open `events` source cannot
reopen. Detached execution may still run after transport loss: retain its
completion owner and disable dispatch failover when another attempt could
repeat hidden work. Source-open and first-response deadlines are separate;
read their current defaults in [producer options](../src/chat-routes/sandbox-producer.ts).

## Resources, hooks and durable ownership

Request seams receive the bound `args.waitUntil`. Transfer opaque acquisition
and disposal to the route instead of maintaining a take/release holder:

```ts
afterAuthorize: args => ({
  resource: acquireTurnResource(args),
  dispose: resource => resource.close(),
}),
produce: async args => buildProducer(await args.earlyResource),
```

The second route generic names the resource type. Disposal runs once on
refusal, completion, stream failure, cancellation or handoff, even when
acquisition finishes after refusal. Acquisition cleans partial resources before
rejecting. A legacy release function still runs only when the turn ends before
the producer takes ownership. Start billable work only after the product's
required authorization and paid-access gates.

| Existing seam | Product responsibility |
| --- | --- |
| `contextGate` | Refuse on domain readiness; the user row already exists |
| `beforeTurn` | Pin or prepare domain context before committed execution |
| `lifecycle` | Start and exactly one complete/error receipt; `afterSettle` runs after lock release |
| `onTurnComplete` | Product settlement using authoritative usage/model attribution |
| `heartbeat` | Product keepalive event while the producer is quiet |
| `onRawEvent` | Best-effort producer telemetry before framing; excludes injected heartbeat |

The route records shared trace spans and first-visible/first-text timing.
`createD1TurnTimingStore(...).lifecycle(...)` supplies rollout persistence without
another timing adapter. Product labels, cohort arms and domain settlement stay
explicit. See [turn tracing](../docs/turn-trace.md) and
[lifecycle ownership](../docs/turn-lifecycle-owner.md).

`waitUntil`, a stream buffer, and projection EOF do not establish a durable
execution owner. Native execution transfers its original identities, timing,
transcript and fenced lock to the existing completion owner. Observation loss
must not redispatch work or release that owner's lock. Preserve product
reconciliation and idempotent settlement before terminal release.

## Composer, stream and reconnect

```tsx
import {
  ChatComposer, chatTurnRequestInit, streamChatTurn, useComposerAttachments,
} from '@tangle-network/agent-app/web-react'

const attachments = useComposerAttachments({
  uploadUrl: '/api/chat/attachments',
  onReject: reason => toast(reason),
})

<ChatComposer
  pendingFiles={attachments.composerFiles}
  onAttach={files => attachments.addFiles(files)}
  onSend={content => streamChatTurn({
    start: () => fetch('/api/chat', chatTurnRequestInit({
      threadId, content, attachments: attachments.references,
    })),
    resume: (turnId, fromSeq) => fetch(`/api/chat/replay/${turnId}?fromSeq=${fromSeq}`),
    callbacks: { onText: appendDelta, onReasoningState: setReasoning },
  })}
/>
```

`streamChatTurn` consumes text, tools, usage, interactions, notices and structured
errors. `onNotice` renders warning/auto-decline notices; `onErrorEventDetail`
retains code/details alongside the existing `onErrorEvent(message)` path.
Question cards use `InteractionQuestionCard` and `useChatInteractions`.

Both producers persist reasoning parts with run timing. `onReasoningState`
feeds `ReasoningRow`; `chatReasoningFromParts(message.parts)` reconstructs saved
state for `ChatMessages`. Reconnect retains one reasoning state and clock.
Other transports use `trackChatReasoning`, feed reasoning/text/tool callbacks,
and call `end()` on close. OpenAI reasoning depends on the selected model's
supported reasoning effort. Read the [client implementation](../src/web-react/chat-stream.ts)
when adapting callbacks or resume behavior.

## Uploads, stored attachments and mentions

Choose the existing storage boundary:

- `createUploadRoute` returns inline parts or writes larger files to an
  authorized Sandbox filesystem. The scaffold supplies its scoped sink.
- `createAttachmentUploadRoute` saves bytes to a durable product store and
  returns `ChatAttachmentInput` references. Pair it with `ReadAttachmentFn`
  and `AtomicAttachmentWriter`; `/object-store` supplies an R2 backend.
- Mentions reference paths already available on the workspace box.

Authenticate and rate-limit uploads and downloads, derive scope from authorized
identity, validate every path, sniff actual bytes, and rederive size from stored
content. Read current limits in the
[upload owner](../src/chat-routes/upload.ts) and
[attachment validation](../src/chat-routes/attachment-validation.ts), rather
than copying them into product configuration.

Use `createAtomicAttachmentWriter` for new durable adapters. Each successful
write returns its ownership receipt and rollback; `abort` must compare ownership
or delete an immutable unique key. A reused path alone is insufficient authority
to delete a concurrent writer's object. Legacy `WriteAttachmentFn` remains
available but does not promise atomic batch rollback. See the
[writer contract](../src/chat-routes/attachment-store.ts).

```ts
const upload = createAttachmentUploadRoute({
  authorize: async ({ request }) => {
    const auth = await authorizeAttachmentWrite(request)
    return auth.ok ? { ok: true, scopeId: auth.workspaceId } : auth
  },
  attachmentWriter,
})
```

Before dispatch, `resolveChatAttachments` validates references with
`{scopeId, readAttachment}`. Carry earlier files with
`historyAttachmentsFromMessages(currentAttachments, priorMessages)`.
Await `prepareDispatchAttachments` before building prompt/history/profile-size
arguments; it materializes files sequentially, deduplicates target paths and
checks uploaded byte counts. The product supplies path roots, `upload` and its
missing-bytes error. Retain the existing trace around preparation.

Pass prepared files and `projectDispatchHistory(priorMessages)` to
`buildDispatchParts` with product prompt, mention paths and profile wire size.
It enforces the dispatch budget without writing to storage. Persisted assistant
roles survive history projection; other roles become user with existing file
pointers retained. On failure, return the helper's typed failure before dispatch.

`promoteAgentFilePart` in the Sandbox producer's `promoteFilePart` callback
copies harness files into that same durable store before persisting their
reference. `ChatMessages.resolveAttachmentUrl` maps stored parts to an
authenticated raw-bytes download route; `MessageAttachments` is available
standalone. See [attachment preparation](../src/chat-routes/attachment-store.ts)
and the [composer hook](../src/web-react/use-composer-attachments.ts).

### Address agents by mention

A thread's own agent answers by default. To let a person pull any workspace
agent into any thread with `@`, give the composer the roster and the route a
resolver; nothing else changes, and the thread's binding never moves.

```ts
// Composer: agents come first in the same @ popover, then the box's files.
const mentions = useFileMentions({ indexUrl, agents: roster }) // { id, handle, name, description? }[]

// Route: mentions resolve to the profiles they run as, from the product's catalog.
createChatTurnRoutes({
  agents: {
    resolve: async ({ context, mentions }) => rosterFor(context.workspaceId, mentions.map((m) => m.agentId)),
  },
  produce: (args) => createSandboxChatProducer({ ...base, profile: args.agent?.profile ?? base.profile }),
})
```

The handle is the agent's normalized name (`normalizeProfileName` in
`/agent-profiles`); the persisted mention part carries the stable
`agentId`, so a rename never breaks an old message. A turn addressed to
several agents calls `produce` once per agent, all at the same time, each
with the thread's history and none seeing another's answer, and persists one
assistant row with a `speaker` part before each answer in the order typed. `ChatMessages` splits that row and labels each answer with its
author (`expandSpeakerRows` in `/web`). Live, every responder is announced
first as a `speaker` event (`onSpeaker`), then every event carries
`speaker`, the responder's agent id (`onSpeakerEvent`, or `event.speaker`
for a raw-event consumer), so a viewer keeps one live block per responder
and draws them answering at the same time. A responder that fails leaves a
`notice` under its own name; the turn fails only when every responder did.
Each responder's `prompt` and `body.content` arrive addressed
(`addressedTurnText`): the `@handles` are gone and one line names who it
answers as and who else is answering, so it does its part and not every role. When a product projects history for a
mentioned agent, it passes the point of view: `projectDispatchHistory(prior,
{ pov: args.agent?.id, owner })` keeps that agent's own answers as
`assistant` turns and turns every other agent's answer, including the
thread's owner, into a `user` turn tagged `[Name] …`, the same rule
agent-runtime's conversations use. Without a point of view, a multi-speaker
row projects as tagged `assistant` turns, so the owner still sees who said
what. Reasoning and tool parts never project. A mention of an agent the
resolver does not return is refused as `unknown_agent`; a route without
`agents` refuses any agent mention as `agents_unsupported`. The rail lists
the roster through `AgentWorkspaceLayout`'s `agents` config, one row per
agent opening its own thread, plus "New agent" when `createHref` is set.

## Questions, plans and approvals

Sandbox's `SandboxSession.plan()` owns durable plan authority. `/plans` owns
browser-safe lifecycle projection, persisted plan parts and revision-aware
transcript keys. `withDurableChatProjection` accepts the product's structural
`{observe, materialize}` source; `createInteractionAnswerRoute` retains its
`durable` persistence seam.

`isRenderableInteraction` determines which question/plan cards the product can
render. Supply `declineInteraction` for unsupported asks so execution does not
wait indefinitely on an invisible card. Interaction list reads must not
provision a paid box; the scaffold resolves an existing session for reads.
Decision endpoints check the caller's role and action sensitivity, and every
effect capability still enforces approval and finite budget. Automatic mission
start does not bypass those downstream checks.

## Provider-enforced budgets and tools

`createProtectedRuntimeChatProducer` composes Runtime's protected grant,
Router executor and shared event projection. Use `createRouterProtectedModelPort`
from `/runtime`; supply the authenticated product key, exact profile and turn
digest, deadline, and authorized tools. The supported path uses Anthropic
without reasoning or provider-hosted tools. Tool callbacks validate arguments,
recheck access and honor their abort signal before effects.

Retain the validated Router settlement through `onSettlement` in the product's
durable audit store. Router settles that authorization; do not deduct its cost
again in post-processing. Failure or cancellation can still incur provider
charges. `ProtectedModelSettlementError` retains validated settlement when the
audit callback fails; an invalid receipt proves neither a charge nor enforcement.
The producer executes once without retrying uncertain work. Admission, history,
replay and completion records remain with the normal route; prove live product
tools and provider billing separately.

## Stop uses the original authorized target

Configure `cancel: {target: args => readOwnedStopTarget(args)}` and route POSTs
to `routes.cancel(request)`. Without configuration it returns 405 before
parsing or authorization. Its `authorize` intent is `cancel`; matching
identity-only success is sufficient and `target` receives optional `context`.
The product authenticates an editor and checks workspace/thread/turn access.

Project the captured metadata, dispatch token and original native receipt into
`ChatTurnCancelTarget`. Resolve only that receipt's authorized box through
`source()`. `markStopped` atomically compares the whole captured metadata before
merging Stop fields. A changed attempt or unconfirmed interruption leaves the
turn unchanged. OAuth actor/source-key checks remain product policy.

The running route observes this target with its server-committed message ID,
including a fresh read before accepting EOF. Confirmed stopped/superseded state
aborts transport and retracts its draft. Observation performs no native
interrupt or Stop write; the durable completion owner retains transcript and
lock authority. See [Stop's contract](../src/chat-routes/cancellation.ts).

## Effective Sandbox profiles and credentials

After authorizing the workspace and user selections, pass the complete
`effectiveProfile` into `streamSandboxPrompt` or `driveSandboxTurn`:

```ts
streamSandboxPrompt(shell, box, prompt, {
  profile: effectiveProfile,
  modelApiKey: executionKey.apiKey,
  sessionId: thread.id,
  executionId: turn.id,
  turnId: turn.id,
  detach: true,
})
```

Both entrypoints share harness/model/effort, permissions, resource, compatibility
and request-limit resolution plus `onProfileResolved`. The supplied profile
bypasses `shell.profile`; compose product resources first. Explicit selections
override profile defaults, then shell provider defaults. Credentials, session
identity, cancellation and interaction policy remain separate options; the
effective dispatched profile contains no secret values. Custom SDK transports
can reuse `resolveSandboxPromptBackend` for the same backend in size checks and
dispatch. Read [profile authority](../docs/agent-profiles.md) before changing
text versus harness/tool/secret authority or OAuth execution identity.

Put expiring workspace-wide application credentials in
`SandboxRuntimeConfig.runtimeEnv`, rather than creation-only `env`:

```ts
runtimeEnv: async ({ workspaceId }) => ({
  APP_TOOL_BEARER: await mintWorkspaceToolToken(workspaceId),
}),
```

The shell resolves this on creation and before reuse, resume or recovery,
even when liveness is cached. Profiles reference the variable name; values stay
outside profile material. This callback has workspace-wide authority and cannot
carry per-user/request secrets. Keep static process configuration in `env`;
Sandbox owns managed model and Hub credentials. Throw when required credentials
cannot resolve. Existing boxes await `setRuntimeEnv` acknowledgement before
bootstrap/dispatch; failure preserves the box and refuses the turn. Deploy a
matching Sandbox runtime before adoption: upgrading the package does not update
already-running sidecars.
