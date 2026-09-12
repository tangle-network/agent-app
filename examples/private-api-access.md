# Private API access with existing owner keys

Use `createApiKeyRequestAuth` from `@tangle-network/agent-app/platform` to authenticate existing keys on private product routes.
Use `ApiAccessPanel` from `@tangle-network/agent-app/web-react` for owner onboarding.
Both reuse the application's existing key store.
They do not issue browser sessions or replace workspace authorization.

## Server integration

Configure the adapter with the existing key verifier, exact method/path scope map, owner lookup, and atomic request quota claim.
Return one scope or an array of all required scopes from `requiredScope`; every listed permission must match exactly.
For example, a run route can require `['records:read', 'records:run']`.
An empty list or `null` denies the route.
Keys need explicit scopes and a finite expiry in Unix epoch milliseconds.
Retain the key ID in trusted run and revision metadata for attribution.
Keep existing workspace membership checks, subscription admission, and execution budgets after authentication.

Only an absent Authorization header permits normal cookie authentication.
Supplied invalid, expired, revoked, or under-scoped credentials must fail without falling back to a cookie.
Keep key management, billing, membership, publishing, and sandbox credential routes outside the allowlist.
A paid public gateway credential does not implicitly grant private workspace access.
Preserve any spending-cap reservation and settlement requirements in the owning gateway.

## Owner page

The shared panel accepts product scope descriptions, default permissions, the API base URL, and existing key-management callbacks.
It creates finite expiries, masks the new secret, supports copying, and clears the secret after acknowledgement or confirmed revocation.
Creation errors and revocation errors remain visible until corrected.
The product route loads the owner's key list and supplies the callbacks:

```tsx
import { ApiAccessPanel } from '@tangle-network/agent-app/web-react'

<ApiAccessPanel
  keys={ownerKeys}
  access={[
    { scope: 'records:read', label: 'Read records', description: 'Read your records.' },
    { scope: 'records:write', label: 'Edit records', description: 'Create and edit your records.' },
  ]}
  defaultScopes={['records:read']}
  expiryDays={[1, 7, 30]}
  defaultExpiryDays={7}
  baseUrl="https://example.test"
  accountHref="/app/account"
  onCreate={createOwnerKey}
  onRevoke={revokeOwnerKey}
  onChanged={refreshOwnerKeys}
/>
```

`expiryDays` and `defaultExpiryDays` configure offered lifetimes in days; the defaults are `[1, 7, 30]` and `7`.
The issuer must enforce its expiry policy independently.
An empty or invalid choices list prevents creation.

`onCreate` receives `{ name, scopes, expiresAt }` and resolves to `{ id, key }` after successful persistence.
`onRevoke` resolves only after the server confirms deletion; reject failures instead of reporting success.
Route both callbacks through existing cookie-only owner endpoints.
For applications using the existing gateway key routes, those are `POST /api/keys` and `DELETE /api/keys/:keyId`.
Load the list through `GET /api/keys` or the same owner-scoped store in a server loader.
Do not introduce a second credential issuer for the panel.
Do not put the raw key into loader data, analytics, logs, URLs, or browser storage.
Copy the one-time value directly into the client application's secret storage.

## Client requests

Send `Authorization: Bearer <key>` to the product's native API base.
List and reuse the same workspace and thread IDs that the browser uses.
Inspect running status before submitting another turn, and reconnect through the existing replay route when a turn is active.
Retain the application's turn ID when retrying; verify its idempotency contract before claiming duplicate execution is prevented.
An accepted request or open stream does not prove completion.
Read the terminal event and retained messages.

GTM's adoption uses `/app/api-access`, `/api/workspaces`, `/api/threads`, `/api/vault/file`, and `/api/chat`.
Its maintained native route and file-precondition contract is in the GTM repository's `docs/operator-api.md`.
Other products define their own route scope map and preserve their own authorization checks.

## Runtime files

Use `isWorkspaceFileExportable` from `/web` at file-list, read, download, and persistence boundaries.
It excludes hidden paths and OpenCode's runtime-only configuration filenames, including old cached copies and case variants.
The shared sandbox file-index route applies this policy to fresh scans and cached indexes.
Keep independent path validation and workspace authorization on each product route.
This is a filename boundary for runtime files; it does not scan business documents for manually pasted secrets.
