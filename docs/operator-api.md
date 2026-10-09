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

`keys` uses the same callbacks as `createApiKeyRequestAuth`, so an app reuses its key store, revocation, expiry, and request limits.
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

A conductor workspace coordinates product workspaces through this API.
GTM implements it as `gtm fleet`; see GTM's `docs/fleet.md`.

- **Register.** The conductor holds one key per product workspace, restricted to that workspace with read and run scopes, stored encrypted on the server.
  The conductor's agent refers to members by label and never sees a key.
- **Dispatch.** The conductor starts one turn per product workspace with the week's objective and the draft contract.
- **Submit, never post.** Product agents write drafts to their own files; they hold no shared publishing account.
  The app refuses to bind a reserved publishing account, such as the company X account, to a product workspace.
- **Collect.** The conductor reads each product's drafts into one editorial queue in its own files, with provenance.
- **Deduplicate.** The conductor keeps a keyword-to-canonical-page map, so two of the company's pages never compete for one query; a colliding draft is marked, not queued as a second candidate.
- **Publish.** Only the conductor owns the shared accounts, and posting goes through its approval flow.
- **Measure.** The conductor reads each product's scorecard and approvals.

## Adoption

| App | Before this API | Status |
| --- | --- | --- |
| gtm-agent | Private API with `gak_` keys and the ChatGPT agents surface | Mounts `/api/operator/v1`; first adopter |
| legal-agent | Private API with `lak_` keys | Not yet mounted |
| creative-agent | Private API and the ChatGPT agents surface | Not yet mounted |
| tax-agent, insurance-agent, hospitality-agent, agent-builder | None | Not yet mounted |

To adopt: mount the splat route, implement the adapter over the app's existing turn admission and storage, and build the API access page from `OPERATOR_ACCESS`.
Keep older private routes until their consumers move.

## Not in v1

Answering questions or approvals, interrupting a turn, and writing files stay on each app's own routes.
Cross-app identity is not shared: each app issues its own keys for its own users.
