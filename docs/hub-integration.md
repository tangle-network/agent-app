# Hub integration

`HubExecClient` adapts the published Hub SDK to Agent App outcomes.
The SDK owns HTTP requests, credentials in headers, response parsing, and typed errors.
Agent App retains tool-name resolution, per-user key selection, and its result union.
Keep user keys on the server.

```ts
import { invokeIntegrationHub } from '@tangle-network/agent-app/integrations'

const outcome = await invokeIntegrationHub({ userId, toolName, args }, {
  baseUrl: 'https://id.tangle.tools',
  apiKeyResolver: resolveLinkedUserKey,
})
```

An explicit `baseUrl` works in Workers without a Node `process` global.
Otherwise, supply `env.TANGLE_PLATFORM_URL` or configure that environment variable in Node.
Missing account linkage returns 401 before contacting Hub.

Hub remains the policy authority.
The adapter never requests approval automatically.
The SDK can request a capability token after an approval-required response.
That request must preserve the server's approval and denial decisions.

## Authorized Hub settings

`createHubSettingsRoutes` is a separate server boundary, exported from
`@tangle-network/agent-app/platform`. It uses the existing methods of
`@tangle-network/hub-sdk` (exercised with pinned 0.22.1 and oldest admitted 0.19.3), not a
second HTTP client. The SDK seam is structural, so existing platform imports do
not acquire a new required Hub SDK runtime or declaration dependency. `createHubProxyRoutes` and its existing convenience API are unchanged.
Do not mount an unrestricted `/v1/*` proxy to implement a settings screen.

The factory returns `{ handle(request): Promise<Response> }`. Its application-owned
`basePath` defaults to `/api/hub/settings`; it must be an absolute path without a
trailing slash. The complete allowlist, relative to that mount, is:

| Method | Path | Input | Existing SDK method |
| --- | --- | --- | --- |
| GET | `/providers` | None | `connections.providers()` |
| GET | `/connections` | None | `connections.list()` |
| POST | `/connections/:provider/start` | `{ returnUrl, connectionParameters? }` | `connections.start(provider, input)` |
| POST | `/connections/:provider/connect-key` | `{ apiKey, metadata? }` | `connections.connectApiKey(provider, apiKey, metadata)` |
| DELETE | `/connections/:connectionId` | None | `connections.revoke(connectionId)` |
| POST | `/connections/:connectionId/health` | None | `connections.health(connectionId)` |
| GET | `/providers/:provider/actions` | Optional `query`, `limit` query parameters | `tools.search(query, { provider, limit })` |
| GET | `/policies` | Required `connectionId` query parameter | `permissions.list(connectionId)` |
| PUT | `/policies` | `{ connectionId, actionPath, decision }` | `permissions.set(input)` |
| DELETE | `/policies` | `{ connectionId, actionPath }` | `permissions.delete(input)` |

No execution, token minting, app administration, consent mutation, approvals,
workflow management, or bulk allow/revert-writes method is reachable. Discovery
is provider-scoped and bounded to 200 results (default 200, `limit` 1–200); it is not
an assertion that all provider actions were returned. Policy changes target one
exact dotted action, never a wildcard, pattern, array, or provider-wide grant.

JSON bodies require `Content-Type: application/json` and are capped at 64 KiB
using the maintained web body parser. Unknown fields, unexpected bodies/query
parameters, repeated query keys, encoded/path-like identifiers, and ambiguous
policy targets are rejected before credential resolution. Provider and connection
IDs use 1–128 ASCII letters/digits/underscores/hyphens, starting with a letter or
digit. Action paths are 2+ dot-separated letter/digit/underscore/hyphen segments,
up to 256 characters. The SDK and Hub still own provider-specific validation.
OAuth `returnUrl` is required and must be an absolute, credential-free HTTP(S) URL
on the request origin. `connectionParameters` are bounded non-secret string
values; identity/credential override keys are rejected.
`requestedScopes` is rejected because admitted Hub SDK 0.19.3 silently omits it from the OAuth request.
This boundary does not expose CLI OAuth mode.
API-key metadata supports the SDK's property/currency and
listing ID/PMS shapes, not arbitrary identity or credential dictionaries.

### The application must authorize account management

Supply both callbacks. `authorize(request, intent)` runs for **every valid
operation, including reads**, before `resolveClient`. It receives the exact
validated operation and target, including a policy decision or OAuth setup input.
The request body has already been consumed; inspect `intent`, not `request.json()`.
The provider API key is deliberately omitted from the intent. Do not log the
request, credentials, OAuth parameters, or upstream response bodies.

The host must check its current session, mutation CSRF protection, current
workspace membership/role, and authority over the exact connection/action.
The router calls `authorize` again after credential resolution and immediately before the SDK operation.
The second grant must name the same principal, so a revoked or changed session makes no Hub call.
The callback must be safe to call twice with the same immutable intent.
Return `{ authorized: true, principal: { userId, sessionId, workspaceId } }` only
after those checks. A generic user ID, cached earlier grant, OAuth success, or
brokered execution permission is insufficient. Return a denial `Response` or
throw the host's auth `Response`; neither performs client resolution or Hub calls.
The router itself is not the application's session, CSRF, membership or consent store.

`resolveClient(principal)` receives only that server-derived principal, not browser
headers or a browser-selected owner. It must resolve the caller's own linked
account credential and return `{ principal, credentialSource: 'caller-account', client }`.
The returned principal must describe the lookup actually performed. A mismatch in
user, session, workspace, or credential provenance is rejected before any SDK call.
A provenance label cannot inspect an SDK's private authentication configuration:
the host must verify credential ownership rather than merely copying the requested
principal onto an owner/admin client. No environment fallback is provided.

The following is application wiring, not a supplied session/authorization backend.
`appAuth`, `settingsPolicy`, and `linkedAccounts` represent the host's authoritative
implementations; do not replace their checks with a user-ID lookup:

```ts
import { HubClient } from '@tangle-network/hub-sdk'
import { createHubSettingsRoutes } from '@tangle-network/agent-app/platform'

const settings = createHubSettingsRoutes({
  async authorize(request, intent) {
    const session = await appAuth.requireCurrentSession(request)
    // Includes CSRF for mutations, current role, exact ownership/target and
    // workspace binding. List operations must explicitly allow account viewing.
    await settingsPolicy.requireAccess({ request, session, intent })
    return {
      authorized: true,
      principal: {
        userId: session.userId,
        sessionId: session.id,
        workspaceId: session.activeWorkspaceId,
      },
    }
  },
  async resolveClient(principal) {
    // Recheck the session binding and resolve ONLY this caller's platform link.
    // Refuse missing links; never use another owner's key to make a call work.
    const link = await linkedAccounts.requireOwnedSettingsCredential(principal)
    return {
      principal: link.principal,
      credentialSource: 'caller-account',
      client: new HubClient({ baseUrl: platformUrl, apiKey: link.apiKey }),
    }
  },
})

// Mount only on the server; the same handler covers its finite method/path set.
export const handleHubSettings = (request: Request) => settings.handle(request)
```

Connection ownership, connection policy, app consent and workspace binding remain
separate authorities. An owned connection does not automatically grant workspace
management rights; being a workspace administrator does not authorize borrowing
another owner's credentials. Listing returns the caller's account connections,
not a synthesized workspace grant list. OAuth or API-key connection success creates
no app consent/workspace binding in this adapter. Reset deletes one policy override;
it restores Hub defaults and is not necessarily a permission reduction, so it
requires its own explicit authorization.

Browser `Authorization`, cookies, user/workspace headers, and arbitrary bodies are
never forwarded to the SDK. The intentionally submitted **provider** API key is
used only as `connectApiKey` input, never as Hub authentication. Successful responses
return the SDK data with HTTP 200 and `Cache-Control: no-store`. SDK errors retain
their 4xx/5xx status and code; status-less SDK input/auth failures map to 400/401/403,
other status-less or invalid-status SDK failures to 502. Error messages/details are
not reflected because they may contain credentials. Auth responses/throws remain
host-owned; unrelated exceptions are not disguised as successful SDK responses.

### Settings verification

Use the repository's Vitest runner and the existing package build/export gates:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/hub-settings-routes.test.ts tests/platform.test.ts
pnpm typecheck
pnpm build
pnpm docs:gen
git diff --exit-code -- docs
pnpm test:gates
pnpm knip
```

The settings suite imports the public platform barrel and real `HubClient`, with a
fake HTTP transport. It covers every allowed method/operation, exact SDK arguments,
authorization-before-resolution, zero upstream calls on denial, session/role
rejection fixtures, post-resolution binding mismatch, rejected identity overrides,
provider-key versus Hub-key isolation, bounded discovery, and upstream status/code.
These are contract tests, not deployed-provider or host-session proof.

Before adopting in a host, exercise its actual logged-in and signed-out routes,
expired/replaced sessions, denied roles, cross-workspace connection attempts, CSRF
rejection, and a caller-owned disposable provider connection. Observe no upstream
request on denied operations. Verify connection success does not create a workspace
binding or app consent; verify per-action set/reset through Hub. Do not use a
customer account or widen policy to make a proof pass. Record missing observations
as missing, not as authorization or provider success.

## Verify a consumer

For an in-app connection and permission settings UI, use the `./integrations-react` controller with the finite `./platform` server routes.
See [the in-app Hub settings example](../examples/hub-integrations-react.md) for the identity-bound host request and local OAuth callback.
The settings controller never runs an integration action or grants a workspace connection.

Build the candidate and install its tarball in an isolated consumer with its declared peers.
Use `pnpm pack --pack-destination .gtr-private` to retain the candidate artifact.
Record the source revision, tarball hash, consumer lockfile, and installed SDK version.
The normal package checks cover installation and exports; they do not prove a provider action.

Run `scripts/prove-published-hub.mjs` from the installed consumer.
Set `PROOF_HUB_URL`, `PROOF_HUB_API_KEY`, and `PROOF_USER_ID` for an owned disposable account.
Set `PROOF_ACK_DISPOSABLE_ACCOUNT=yes` after verifying that ownership.
Select `PROOF_PROVIDER`, `PROOF_CONNECTOR`, and `PROOF_ACTION` from the account's actual catalogue.
Set `PROOF_INPUT_FILE` to an absolute path containing schema-valid action input.
Set `PROOF_OUTPUT` to a private receipt path.

| `PROOF_EXPECT_STATUS` | Required outcome | Independent observation |
| --- | --- | --- |
| 200 | Successful read result | Match the result against the connected provider. |
| 409 | `HUB_APPROVAL_REQUIRED` | Verify no approval decision or provider effect occurred. |
| 502 | `HUB_POLICY_DENIED` | Verify the denied action produced no provider effect. |

Use an existing disposable policy boundary; do not change a customer's policy for verification.
Retain every HTTP method, path, status, request ID, and final outcome.
The helper excludes keys, tokens, action input, and provider response bodies from its receipt.
A failed or missing observation remains a failed or incomplete verification.

Exercise the same read and gated action through the consuming application's normal auth and persistence path.
Confirm that its durable history and approval interface preserve the outcome.
Restore the consumer's prior package lockfile after verification when the candidate is not being retained.
Attach exact acceptance receipts to the migration pull request.
[PR #661](https://github.com/tangle-network/agent-app/pull/661) tracks this migration's source and live evidence.
