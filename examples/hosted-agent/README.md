# Juno: a hosted agent people text and call

Juno is an agent that people text on iMessage or call on the phone.
Each person gets their own isolated Tangle sandbox with its own memory.
The app's Tangle API key pays for every sandbox, model turn and reply; the person pays nothing.

The Worker is `src/worker.ts`.
All of the hosted-agent behavior comes from `@tangle-network/agent-app/hosted-agent`.

## How a message flows

1. A person texts `connect @<handle>` to Inkbox's shared iMessage line, then texts Juno.
2. Hub signs the event and calls `POST /hub`. The Worker authenticates it and puts it on a queue.
3. The queue consumer finds the person's sandbox. The first message creates a fresh isolated box from the persona; later messages resume it.
4. The consumer runs one conversation turn in that box and sends the reply through Hub.

A call follows the same path to the same box.
ph0ny answers the phone and calls `POST /voice/hook` to admit the caller.
ph0ny's voice agent then calls `POST /voice/ask` through its `ask_workspace` webhook tool.

## Limits

| What | Default |
|---|---|
| Sandbox per person | 1 CPU, 2 GB memory, 10 GB disk, egress to `router.tangle.tools` only |
| Idle suspend | 10 minutes; the next message resumes the same box |
| Deleted box | the next message gets a fresh box |
| Free answers | 30 per person per UTC day (`freeTurnsPerDay`); `allow` decides after that |
| Turn wall time | 2 minutes |
| STOP / START | STOP silences the line for that person; START resumes it |

## Model and tools

Juno runs `openai/gpt-5.6-luna`, the kit's default for hosted conversations.
The kit turns off the harness tools that a texting assistant does not use: the shell, file search, sub-agents, to-do lists, skills and web fetch.
Juno keeps file read, write and edit for its `memory.md` notes.
Set `model.default` or `tools` in the persona to choose your own.

## Deploy

```sh
pnpm install
wrangler kv namespace create juno-users      # put the id in wrangler.jsonc
wrangler queues create juno-turns
wrangler secret put TANGLE_API_KEY           # the app's Tangle key; it pays for everything
wrangler secret put HUB_CALLBACK_SECRET      # 32+ random bytes
wrangler secret put VOICE_SECRET             # 32+ random bytes
wrangler deploy
```

## Connect an iMessage identity

1. Create an Inkbox identity with iMessage enabled, and an agent-scoped Inkbox key for it.
2. Connect it to Hub under the app's Tangle account: `hub.connections.connectApiKey('inkbox', key)`.
3. Route its messages to the Worker:

```sh
TANGLE_API_KEY=... HUB_CALLBACK_SECRET=... CONNECTION_ID=hubconn_... \
IDENTITY_ID=<inkbox identity uuid> WORKER_URL=https://<worker>.workers.dev pnpm setup
```

## Connect voice (ph0ny)

1. Create a ph0ny agent with a webhook tool named `ask_workspace`:
   `POST https://<worker>/voice/ask`, header `Authorization: Bearer <VOICE_SECRET>`, `forwardCallToken: true`, `timeoutMs: 10000`, parameters `{ utterance, ticket }`.
   Tell the voice agent to call it for every question, and to call it again with the `ticket` when it answers `pending`.
2. Bind a ph0ny number: `PATCH /v1/phone-numbers/:id` with `{ agentId, callHook: { url: "https://<worker>/voice/hook", headers: { Authorization: "Bearer <VOICE_SECRET>" } } }`.

Caller ID identifies a caller but does not authenticate them.
A caller who spoofs a number reaches that person's conversation, so do not give this persona tools with effects on voice.
