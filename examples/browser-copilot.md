# Browser / edge copilot (no sandbox)

agent-app is **sandbox-optional**. A copilot that runs inference directly —
in the browser, an edge function, or a Worker — uses the same `/tools` side
channel, `/billing`, `/crypto`, and `/eval` as a sandboxed agent. The only
difference is the `streamTurn` seam: instead of a container producing the turn,
**you call a model and map its stream to `LoopEvent`s**.

All three transports below speak the OpenAI Chat Completions streaming shape, so
they share ONE copilot. **Only `streamTurn` changes** — the loop, the tools, and
the executor are identical.

## The shared copilot (transport-agnostic)

```ts
import { runAppToolLoop } from '@tangle-network/agent-app/runtime'
import { buildAppToolOpenAITools, createAppToolRuntimeExecutor, type AppToolHandlers, type AppToolTaxonomy } from '@tangle-network/agent-app/tools'

const taxonomy: AppToolTaxonomy = { proposalTypes: ['recommend', 'contact', 'other'], regulatedTypes: ['recommend', 'contact'] }
const handlers: AppToolHandlers = { submitProposal, scheduleFollowup, renderUi, addCitation } // your store ops
const tools = buildAppToolOpenAITools(taxonomy)
const executeToolCall = createAppToolRuntimeExecutor({ handlers, taxonomy, ctx: { userId, workspaceId, threadId } })

async function runCopilot(streamTurn) {
  return runAppToolLoop({
    systemPrompt, userMessage,
    streamTurn,                                   // ← the only thing that varies
    executeToolCall,
    isExecutableTool: (n) => tools.some((t) => t.function.name === n),
  })
}
// (use streamAppToolLoop instead of runAppToolLoop if you stream events to the UI)
```

## Transport A — Tangle Router (zero-dep, browser/edge)

The router is an OpenAI-compat endpoint, so this needs nothing but `fetch`:

```ts
import { createOpenAICompatStreamTurn, resolveTangleModelConfig } from '@tangle-network/agent-app/runtime'

const cfg = resolveTangleModelConfig() // { provider, model, apiKey, baseUrl } from env (or pass literals)
const streamTurn = createOpenAICompatStreamTurn({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, tools })
await runCopilot(streamTurn)
```

> Browser note: don't ship a parent `TANGLE_API_KEY` to the client. Mint a
> per-user budget-capped child key with `@tangle-network/agent-app/billing`
> (`createWorkspaceKeyManager().ensureKey`) server-side and hand the copilot that
> short-lived key — the router enforces the cap at the key.

### Record which model actually answered

The router substitutes models on purpose: ask for `claude-sonnet-4-6` while
Anthropic is quota-walled and you get a `200` answered by `openai/gpt-5`. Without
`onServedModel`, the only model id you hold is the one you *asked* for — so
per-model quality scoring credits the wrong model and cost uses the wrong price
basis.

```ts
let served: OpenAICompatServedModel | undefined
const streamTurn = createOpenAICompatStreamTurn({
  ...cfg, tools,
  onServedModel: (s) => { served = s },   // fires once per TURN; take the last
})
```

Map it onto the shell's existing attribution contract — don't open a second
channel. On a `ChatTurnRouteProducer` (`/chat-routes`):

```ts
modelAttribution: () => ({
  requestedModel: served?.requestedModel,
  servedModel: served?.servedModel,
  echoReceived: served !== undefined,
})
```

Leave that contract's `servedSource` unset: its union is sandbox
profile-resolution vocabulary with no router analogue.

Two things worth knowing:

- **`substituted` is folded, not a raw compare.** The router reports the dated
  upstream id (`gpt-5-2025-08-07`) in the response body for a request of
  `openai/gpt-5` on *every* turn, substituted or not.
- **In a browser, `source` tells you which signal survived.** `'router_header'`
  is the router's own substitution flag; `'response_body'` is the backstop for
  when CORS strips the header. Silence means neither was available — "learned
  nothing", not "nothing was substituted".

## Transport B — tcloud SDK

tcloud also speaks OpenAI-compat; point the same helper at its base URL:

```ts
const streamTurn = createOpenAICompatStreamTurn({ baseUrl: TCLOUD_OPENAI_BASE_URL, apiKey: childKey, model, tools })
await runCopilot(streamTurn)
```

(Or, if you hold a tcloud client that yields OpenAI-compat chunks, pipe them
through `toLoopEvents(chunks)` and use that as the `streamTurn`.)

## Transport C — Vercel AI SDK

The AI SDK has its own stream shape, so map its `fullStream` parts to
`LoopEvent`s (a ~10-line adapter — the AI SDK already owns the HTTP/streaming):

```ts
import { streamText } from 'ai'
import type { LoopEvent } from '@tangle-network/agent-app/runtime'

const streamTurn = (messages) => (async function* (): AsyncIterable<LoopEvent> {
  const res = streamText({ model: yourAiSdkModel, messages, tools: yourAiSdkTools })
  for await (const part of res.fullStream) {
    if (part.type === 'text-delta') yield { type: 'text', text: part.textDelta }
    else if (part.type === 'tool-call') yield { type: 'tool_call', call: { toolCallId: part.toolCallId, toolName: part.toolName, args: part.args as Record<string, unknown> } }
  }
})()
await runCopilot(streamTurn)
```

## Why this is the right factoring

The reusable, get-it-wrong-by-hand part is **assembling a streamed OpenAI-compat
response — including tool-call arguments that arrive in fragments across chunks —
into `LoopEvent`s**. That's `toLoopEvents` / `createOpenAICompatStreamTurn`
(`/runtime`). agent-app does **not** ship its own HTTP/streaming client: the
Tangle Router is reached with plain `fetch`, and tcloud / the AI SDK own their
own transport — agent-app only translates their stream shape into the loop's.
Transports A and B are literally the same helper with a different `baseUrl`; only
C needs its own tiny adapter because the AI SDK's stream isn't OpenAI-compat.
