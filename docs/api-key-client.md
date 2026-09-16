# Headless application access

## Unreleased addition

`createApiKeyFetch` is exported from `@tangle-network/agent-app/web`. It is a small application-boundary transport for an already-issued operator/API key, not another auth system, SDK for the Platform API, or agent execution loop.

The existing `createApiKeyRequestAuth` authenticates incoming requests. Hub clients address integration endpoints; `createAssistantClient` addresses the assistant's SSE protocol. None is a credential-safe generic client for a product's native workspace REST and NDJSON routes. This helper supplies that missing client half without owning routes, response schemas, secrets storage, or retries.

```ts
import { createApiKeyFetch } from '@tangle-network/agent-app/web'

const request = createApiKeyFetch({
  origin: configuredApplicationOrigin,
  getApiKey: () => secrets.read('test-operator-key'),
})
const response = await request('/api/workspaces', {
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Workspace read failed: HTTP ${response.status}`)
```

The origin and secret resolver are trusted application configuration, never model-supplied values. Only HTTPS origins are accepted; explicitly enabled loopback HTTP is for local tests. Root-relative paths cannot change origins. The resolver runs per request for rotation, authentication/cookie overrides are rejected, browser cookie fallback is disabled, and redirects are refused. HTTP error responses are preserved for the caller. No call is retried automatically. After a lost write response, consult the application's retained turn or provider receipt; a transport failure is not proof that a write did not run.

This is not server-side authorization, tenant isolation, spend enforcement, or a guarantee of delivery. Keep the application's existing scope, expiry, membership, budget and approval checks. A key granting execution may permit workspace mutations even without a direct-write scope; an operator decision is not necessarily a human approval. Use a dedicated test identity with access only to test workspaces when the server's keys inherit account-wide access.

Keep credentials in local secret storage, not chat, prompts, repository files, command-line arguments or report bundles. An execution-machine connector is a separate access grant. Prefer an isolated development machine with no production or personal secrets. The caller remains responsible for bounding/validating responses and redacting sensitive evidence before export.

## Verification boundary

The focused tests include actual loopback HTTP requests, key rotation, an attacker-controlled redirect target, caller overrides, cancellation, malformed configuration and adapter failures. These are transport checks, not live agent or provider tests. No extra peer dependencies or new subpath are introduced.
