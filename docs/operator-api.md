# Operator API

One versioned HTTP surface that every agent app mounts the same way, so an outside agent can drive a fleet of agent-app workspaces.
The outside agent can be a Claude Code or Codex session, or another app's agent, such as GTM's fleet conductor.
The shared handler owns routes, scopes, workspace restriction, input validation, and response shapes.
The app supplies only storage and execution through `OperatorAdapter`.

Import from `@tangle-network/agent-app/operator`.
It uses only web-standard `Request` and `Response`.

## Mount it

```ts
import { createOperatorApi } from '@tangle-network/agent-app/operator'

const api = createOperatorApi({
  app: { id: 'gtm', name: 'GTM Agent' },
  keys: { verify, resolveIdentity, claimRequest }, // the app's existing key store
  adapter,                                         // the app's workspaces, turns, files, approvals, scorecard
})

// One splat route: /api/operator/v1/*
export const loader = ({ request }) => api.handle(request)
export const action = ({ request }) => api.handle(request)
```

An app built on agent-app's chat stack does not write an adapter: `createChatOperatorAdapter` reads threads and messages from its chat store and runs turns through its own chat route.
The app supplies its workspace roles, a `runTurn` that calls its chat route as the caller, and, optionally, running-turn discovery, files, journal, approvals, assets, and a scorecard.
Thread reads receive the caller too, so an app whose conversations belong to one user rather than the whole workspace returns null for anyone else's.
Its turns are driven exactly as a browser drives them, so the start request returns once the turn settles; apps whose turns are owned by a durable worker, such as GTM's completion Workflow, return as soon as the turn is admitted.

`keys` uses the same callbacks as `createApiKeyRequestAuth`, so an app reuses its key store, revocation, expiry, and request limits.

### Accept Tangle agent keys

One owner approval on id.tangle.tools gives an agent one key for every product it asked for.
Wrap the app's key store so that key works here too:

```ts
import { withPlatformAgentKeys } from '@tangle-network/agent-app/operator'
import { createPlatformAgentKeyVerifier } from '@tangle-network/agent-app/platform'

const keys = withPlatformAgentKeys(appKeys, {
  verifier: createPlatformAgentKeyVerifier({
    platformUrl: 'https://id.tangle.tools', serviceName: 'gtm-agent', serviceToken, product: 'gtm-agent',
  }),
  product: 'gtm-agent',
  accounts: tangleSsoAccountStore, // the store browser SSO uses
  // Act with the agent key for this request, so its work spends the key's cap.
  loadIdentity: async (userId, { platformApiKey }) => {
    const user = await loadUser(userId)
    return user ? { user, platformApiKey } : null
  },
})
```

A Bearer key starting `sk-tan-` is verified at Platform for the app's product on each request, cached for at most two minutes, and refused with a typed status: 401 `agent_key.invalid` when revoked or expired, 402 `agent_key.payment_required` or `agent_key.budget_exhausted` when the owner has no credit or the shared cap is spent, and 403 `agent_key.product_not_granted` when the owner did not approve this app.
Platform being unreachable answers 503; an unverified key is never admitted.
Only the key's `<product>:operator:read|write|run` scopes (or `*`) become operator scopes.
The key names no user: its owner's Tangle identity resolves through the app's SSO account store, and the first call creates that user exactly as a first browser sign-in would.
A store that keeps the Platform link per user also links it, with the agent key as the link's credential; a store that keeps the key on the session row omits `saveTangleLink`.
A user already linked to that identity is used as it is.
`loadIdentity` receives the agent key as `platformApiKey` for the request: put it on the identity and act with it, so the work spends the key's one cap, whether or not the owner has signed in. It is never on the key object; never store or log it.
Workspace access still comes from `authorizeWorkspace`; every other key goes to the app's own store unchanged.

### Bill agent-key work to its cap

Work an app runs for an agent key must spend that key's one cap, even for an owner whose own credential already pays the app.
`createPlatformAgentSpend` (`/platform`) does both halves:

- `modelKey({ agentKey, name, expiresAt })` delegates a Router key from the agent key whose charges spend its cap directly. Give the turn that key for its model calls; Router refuses each call once the cap is spent.
- `hold({ keyId, amountUsd, referenceId, expiresAt })` reserves the most the work can cost elsewhere, such as compute in the owner's sandbox, before it starts. `consume({ authorizationId, amountUsd })` spends what it measured, up to the hold, without charging the wallet again. `release` returns a hold whose work never ran.

A spent or insufficient cap answers 402 `agent_key.budget_exhausted`, so refuse the work before it starts.
An owner whose app credential is the agent key itself (an account the key created) already spends its cap and needs neither.
`resolveIdentity` can refuse a class of key by throwing a `Response`, such as a key with a spending cap that must use the paid gateway.
`adapter.authorizeWorkspace` applies the app's roles: `read` needs viewer access and `run` needs the role that may start agent work.
A workspace the caller cannot reach answers 404, so a key cannot probe other owners' workspaces.
Adapters throw `OperatorError(code, status)` for expected refusals; any other failure answers a generic 500 and reaches `onError`.

## Routes

All routes live under `/api/operator/v1` and require `Authorization: Bearer <key>`.
There is no browser-cookie fallback.

| Method | Path | Scopes | Returns |
| --- | --- | --- | --- |
| GET | `` | read | `{ app, principal }`: app id, implemented capabilities, the key's scopes and workspace restriction |
| GET | `/workspaces` | read | `{ workspaces }` the key can reach |
| POST | `/workspaces` | write | `{ workspace }`; body `{ name }`; refused for workspace-restricted keys |
| GET | `/workspaces/:id` | read | `{ workspace }` |
| POST | `/workspaces/:id/turns` | read, run | 202 `{ turn }`; body `{ turnId, content, threadId?, title?, model? }` |
| GET | `/workspaces/:id/threads` | read | `{ threads, nextCursor }` |
| GET | `/workspaces/:id/threads/:thread` | read | `{ thread, latestTurn }` |
| GET | `/workspaces/:id/threads/:thread/turns/:turn?wait=<s>` | read | `{ turn }`, held up to `wait` seconds (at most 25) |
| GET | `/workspaces/:id/approvals` | read | `{ approvals }` open in the workspace |
| GET | `/workspaces/:id/journal?days=<n>` | read | `{ entries }`: dated journal files |
| GET | `/workspaces/:id/files?prefix=<p>` | read | `{ files }` |
| GET | `/workspaces/:id/file?path=<p>` | read | `{ file }` with content and revision |
| GET | `/workspaces/:id/assets/:asset` | read | the asset bytes |
| GET | `/workspaces/:id/scorecard?days=<n>` | read | `{ scorecard }`: work metrics, business outcomes, and how they are measured |

Optional operations an app does not implement answer 501 `operator.unsupported`; `GET /api/operator/v1` lists the implemented ones.
Errors are `{ error, code, retryable? }`.

### Turn lifecycle

1. The caller generates a UUID `turnId` and posts the turn.
   Omitting `threadId` starts a new conversation; the response names it.
   The response arrives once the app has admitted the turn, or, for an app whose turns are owned by the request, once the turn settles.
   A retry with the same `turnId` returns the same turn and never starts a second one.
2. The caller reads the turn with `?wait=25`.
   The server holds the read until the turn settles, waits on a decision, or the hold ends.
3. `succeeded` and `failed` are settled and carry `reply` or `failure`, plus referenced `assets`, changed `files`, and open `approvals`.
   `input-required`, or a nonempty `approvals` list, waits on someone in `approvals[].decidedBy`.
   `unknown` means the app cannot establish the state; it is never evidence of success.

An accepted turn or an open connection does not establish completion; read the settled turn.

## Authority model

**Whose identity acts.**
The key's owner, resolved from the app's key store.
The request body and path cannot select another identity: unknown body fields are refused, and the workspace comes from the path and passes the owner's role check.
Work runs on the owner's plan and model budget, under the app's normal product policy.

**Scopes.**

| Scope | Allows |
| --- | --- |
| `operator:read` | Read workspaces, conversations, files, journal, assets, approvals, scorecards, and turn status. |
| `operator:write` | Create workspaces; an app's older private routes may also use it for conversations and files. |
| `operator:run` | Start and continue agent turns; requires `operator:read`. The agent can change workspace files and take actions the product allows. An app's older private routes may also use it to answer questions and tool-permission requests, or to interrupt a turn. |
| `operator:workspace:<id>` | Restricts the key to the named workspaces. A restricted key cannot create workspaces, and apps refuse it on their older private routes. |

`OPERATOR_ACCESS` carries the labels an app's API access page shows; `OPERATOR_SCOPE_DEPENDENCIES` carries the run-requires-read rule for the key issuer.
Keys need a finite expiry.
Every request, including a held turn read, claims one request from the key's allowance.

**Approvals.**
An operator key never decides a held external effect: sends, publishing, spending, credential changes, and Hub writes wait for the person named in `decidedBy`.
The approvals list tells the caller what is waiting and links to where it is decided.
An operator decision, where an app allows one, is a delegated decision, not human approval.

**Secrets.**
Keys live in the caller's secret storage: a local secrets file for a CLI, an encrypted server-side record for an app.
They never enter prompts, chat messages, vault files, command-line arguments, or logs.
`createOperatorClient` resolves the key per request through `getApiKey` and inherits `createApiKeyFetch`'s refusals: HTTPS only, no redirects, no cookies, no caller-supplied authentication headers.

## Use it from outside

**A Claude Code or Codex session** uses the `agent-ask` CLI from Drew's dotfiles:

```bash
agent-ask --app gtm "<outcome-level ask>"
agent-ask --app tax --workspace <id> status <threadId> --wait 30m
```

**Another app's agent** holds a key server-side and uses the typed client:

```ts
import { createOperatorClient } from '@tangle-network/agent-app/operator'

const client = createOperatorClient({ origin: 'https://tax.tangle.tools', getApiKey: () => secrets.read(memberId) })
const started = await client.startTurn(workspaceId, { content: objective })
if (started.succeeded) {
  const turn = await client.waitForTurn(workspaceId, started.value.threadId, started.value.turnId, { timeoutMs: 600_000 })
}
```

Every client call returns `{ succeeded, value }` or `{ succeeded: false, status, code, error, retryable }`.
A transport failure on a turn start does not establish that the turn did not start; retry with the same `turnId`.

## Fleet pattern

A conductor workspace runs GTM, or any app's work, for several products.
GTM implements it as `gtm fleet`; see GTM's `docs/fleet.md`.
A product is described only by inputs any customer already has: its public site, docs, and repositories, and the conductor's standard connectors.
The product itself changes nothing and serves nothing to the conductor; this API is how the conductor reaches its own app's workspaces, never the product's systems.

- **Register.** Each product runs in the conductor's own workspace or in a workspace of its own in the same app. The conductor holds one key per product, restricted to the workspace it runs in, with read and run scopes, stored encrypted on the server. The conductor's agent refers to products by label and never sees a key.
- **Dispatch.** The conductor starts one turn per product with the week's objective, the product's public sources, and the draft contract.
- **Submit, never post.** Each product's agent writes drafts to its own folder and holds no shared publishing account.
  The app refuses to bind a reserved publishing account, such as the company X account, to a product workspace.
- **Collect.** The conductor reads each product's drafts into one editorial queue in its own files, with provenance.
- **Deduplicate.** The conductor keeps a keyword-to-canonical-page map, so two of the company's pages never compete for one query; a colliding draft is marked, not queued as a second candidate.
- **Publish.** Only the conductor owns the shared accounts, and posting goes through its approval flow.
- **Measure.** The conductor reads the scorecard and approvals of each workspace a product runs in.

## Adoption

| App | Before this API | Status |
| --- | --- | --- |
| gtm-agent | Private API with `gak_` keys and the ChatGPT agents surface | Mounts `/api/operator/v1`; first adopter |
| legal-agent | Private API with `lak_` keys | Mounts `/api/operator/v1` (legal-agent#438) |
| creative-agent | Private API and the ChatGPT agents surface | Mounts `/api/operator/v1` (creative-agent#558) |
| insurance-agent | None | Mounts `/api/operator/v1` (insurance-agent#114) |
| tax-agent | OpenAI-compatible gateway with `tak_` keys | Mounts `/api/operator/v1` (tax-agent#574); refuses agent-key turns until they bill the key's cap |
| physim | OpenAI-compatible gateway with `sk_physim_` keys | Mounts `/api/operator/v1` (physim#170); refuses agent-key turns until they bill the key's cap |
| hospitality-agent, agent-builder | None | Not yet mounted |

An app mounts this API so outside agents, such as a Claude Code session, can operate its own workspaces.
No app needs it so that GTM can market that app's product: GTM works from public inputs only.
To adopt: mount the splat route, implement the adapter over the app's existing turn admission and storage, and build the API access page from `OPERATOR_ACCESS`.
Keep older private routes until their consumers move.

## Not in v1

Answering questions or approvals, interrupting a turn, and writing files stay on each app's own routes.
Apps still issue their own keys for their own users; a Tangle agent key is the one credential every app accepts.
