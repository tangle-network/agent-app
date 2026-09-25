# Braid: a hosted agent people text and call

Braid is an agent that people text on iMessage or call on the phone.
Each person gets their own isolated Tangle sandbox with its own memory.
The app's Tangle API key pays for every sandbox, model turn and reply; the person pays nothing.

The Worker is `src/worker.ts`.
All of the hosted-agent behavior comes from `@tangle-network/agent-app/hosted-agent`.

## How a message flows

1. A person texts Braid's line (an Inkbox iMessage identity).
2. Tangle Hub receives it, finds the sender's member and thread, and runs the turn in the sender's own sandbox: the app's named instance `hosted:` plus a hash of their number.
   The first message creates a fresh isolated box from the persona; later messages resume it.
3. Hub sends the reply on the same line.

A call to the line reaches the same box and the same thread.
Hub admits the caller as a member of the line, ph0ny voices the call, and each question the voice agent asks with its `ask_workspace` tool runs as a turn in the caller's thread.
Hub admits only members, so a person texts Braid once before they call.

Texts and calls never reach the Worker.

## Limits

| What | Default |
|---|---|
| Sandbox per person | 1 CPU, 2 GB memory, 10 GB disk, egress to `router.tangle.tools` only, none of the app's secrets |
| Idle suspend | 10 minutes; the next message resumes the same box |
| Deleted box, or one that fails to start for 60 s | the Platform gives the next message a fresh box |
| Texts | 30 per person per UTC day (`freeTurnsPerDay`), counted by Hub |
| Turn wall time | 10 minutes for a text; a spoken question answers within ph0ny's tool budget |
| STOP / START | STOP silences the line for that person; START resumes it (Hub) |
| New `TANGLE_API_KEY` | the Platform refuses to resume a box under another key and never replaces it for that; use a key from the same account lineage |

## Model and tools

Braid runs `openai/gpt-5.6-luna`, the kit's default for hosted conversations.
The kit turns off the harness tools that a texting assistant does not use: the shell, file search, sub-agents, to-do lists, skills and web fetch.
Braid keeps file read, write and edit for its `memory.md` notes, in its own box per person.
Set `model.default` or `tools` in the persona to choose your own.

## Deploy

```sh
pnpm install
wrangler secret put TANGLE_API_KEY           # the app's Tangle key; it pays for everything
wrangler secret put OWNER_PHONE              # your own phone, E.164: the line's owner
wrangler secret put SETUP_SECRET             # 32+ random bytes; delete it after setup
wrangler deploy
```

## Connect an iMessage identity

1. Create an Inkbox identity with iMessage enabled, and an agent-scoped Inkbox key for it.
2. Connect it to Hub under the app's Tangle account: `hub.connections.connectApiKey('inkbox', key)`.
3. Attach it as Braid's line. The Worker does this with the app's key.
   An app that ran an earlier version of this example can omit `connectionId`: the Worker moves the connection it routed before.

```sh
curl -X POST https://<worker>/setup -H "authorization: Bearer $SETUP_SECRET" \
  -H 'content-type: application/json' -d '{"connectionId":"hubconn_..."}'
wrangler secret delete SETUP_SECRET
```

Hub's line timeline (`client.lines.threads(lineId).messages(threadId)`) records when each text arrived, was answered and was sent.

To change the persona, box or daily limit later, detach the line, deploy, and run setup again.
Hub refuses a changed attachment on an attached line with 409 `Line is attached; detach it before attaching it differently`.
Each person keeps their box and its `memory.md`; their thread starts over.

```sh
curl -X DELETE https://sandbox.tangle.tools/v1/lines/<line id>/attachment -H "authorization: Bearer $TANGLE_API_KEY"
```

## Connect voice (ph0ny)

1. Create a ph0ny agent for the line's calls.
   Tell it to answer general questions itself and to call `ask_workspace` for anything about the caller or what they told Braid before.
   Hub adds the `ask_workspace` tool to the agent.
2. Connect your ph0ny key to Hub under the app's Tangle account: `POST https://id.tangle.tools/v1/hub/connections/phony/connect-key` with `{ "apiKey": "..." }`.
3. Run setup again with the voice fields:

```sh
curl -X POST https://<worker>/setup -H "authorization: Bearer $SETUP_SECRET" \
  -H 'content-type: application/json' \
  -d '{"connectionId":"hubconn_inkbox_...","voice":{"ph0nyConnectionId":"hubconn_phony_...","ph0nyAgentId":"..."}}'
```

Caller ID identifies a caller but does not authenticate them.
A caller who spoofs a number reaches that person's conversation, so do not give this persona tools with effects on voice.
