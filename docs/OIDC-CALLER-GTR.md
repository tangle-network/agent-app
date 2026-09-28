# OIDC caller migration and real-path proof

## Scope

`src/platform/sso.ts` accepts `protocol: 'oidc'`, the runtime's registered
`PlatformOidcClient`, and `TangleOidcSsoAccountStore`. `createAppAuth` forwards
that discriminated configuration. Legacy API-key callers remain compatible
until their paid-service credentials migrate. OIDC failure never falls back
to `/cross-site/*`. This PR does not change an authorization-server route.

The rejected alternative was to put `accessToken` into `apiKey`. That would
misrepresent authorization. At agent-dev-container commit
`7c3bef974c6e005771223b421383d919ffe39679`,
`products/platform/api/src/lib/control-plane-scopes.ts` excludes `admin` and
`sandbox:*` from `OAUTH_GRANTABLE_SCOPES`. At runtime merge
`8f55447acc236f046ff18f7c1c54a59fd0029818`, `src/platform/oidc.ts` returns OIDC
tokens and verified userinfo, not a funded API key.

## Published dependencies

The caller uses Runtime 0.282.2 from npm, with Eval 0.199.1 and Interface 2.13.0.
Knowledge 17.1.10 satisfies that tuple.
Both scaffolds use the same published Runtime and Eval versions.
The OIDC configuration receives the maintained Runtime client and PKCE generator.
Legacy SSO imports remain independent of the optional Runtime package.

## Invariants

The state cookie binds state, redirect, PKCE verifier and callback URI with an
HMAC. The verifier remains HttpOnly. The callback requires the matching browser
state, an unexpired signature, and verified userinfo. Account matching and the
native session-cookie minter remain the existing implementations. The callback
does not trust an unverified ID-token payload.

Persist tokens, granted scopes and access-token expiry on the exact local
session. Encrypt tokens at rest. Never put them in browser responses,
localStorage, logs, or an API-key column. Save rotated refresh credentials before
responding. Serialize refresh and disconnect for the same grant. On disconnect,
block local authentication first. Revoke refresh and access tokens, then remove
the session. A failed revoke must leave a retryable blocked grant, not a success.
These storage and lifecycle operations belong to each product's existing store.

Callback failures attempt grant revocation and call `deleteSession` for an
unpublished session. Cleanup errors are logged without credentials. A provider
outage, crash, or error inside the runtime exchange can leave an unrevoked grant.
There is no claim of atomic cleanup across the application and provider.

## Proof boundary

The listener uses the installed library and real HTTP requests to the configured issuer.
Its local SQLite store encrypts account details and grants through the maintained field-crypto module.
Only hashed session handles reach the database.
A separate private key file preserves encryption and signed-state keys across process restarts.
Each database is bound to one issuer, client, and callback.
Use one listener process per database.

The listener persists rotated credentials before checking userinfo or responding.
Refresh and disconnect share a per-session operation lock.
A failed lifecycle operation leaves the grant blocked on disk, including after a restart.
This local proof store does not replace a product's production storage.

A local issuer proves the actual local Platform service, not a staging or production deployment.
Record the issuer source, registered clients, package artifact, and final HTTP outcomes with the demonstration.
Preserve failures and distinguish source checks from completed browser flows.

## Exact GTR procedure

Use Node 22.13 or newer, Git, Corepack, a browser, and an authorized disposable account.
Create two client registrations through the existing provider.
The Platform operator supplies the issuer origin, both client IDs, and confidential-client secrets.
Record registration IDs and methods in the receipt.
Keep secrets in private files.

Register both clients in the existing `oauthClient` registry. Allow
`authorization_code` and `refresh_token`, require S256 PKCE, and grant
`openid profile email offline_access`. Register the exact callback
`http://127.0.0.1:8789/auth/tangle/callback`, or the sandbox HTTPS public origin
plus `/auth/tangle/callback`. Use `client_secret_basic` with a secret, or `none`
without one. Do not create a trusted-app entry or a Hub broker app. Use fresh
registrations to make the consent step observable.

```bash
set -euo pipefail
git clone https://github.com/tangle-network/agent-app.git
cd agent-app
git checkout feat/oidc-caller-migration
mkdir -p /tmp/tangle-oidc-gtr
corepack pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tee /tmp/tangle-oidc-gtr/install.log
corepack pnpm build 2>&1 | tee /tmp/tangle-oidc-gtr/build.log
git rev-parse HEAD | tee /tmp/tangle-oidc-gtr/commit.txt
export GTR_ORIGIN=http://127.0.0.1:8789
export TANGLE_OIDC_ISSUER="$OIDC_ISSUER_ORIGIN"
export TANGLE_OIDC_CLIENT_ID="$FIRST_PARTY_CLIENT_ID"
export TANGLE_OIDC_CLIENT_SECRET="${FIRST_PARTY_CLIENT_SECRET:-}"
export GTR_OIDC_STORE_PATH=/tmp/tangle-oidc-gtr/first-party.sqlite
node scripts/oidc-live-proof.mjs | tee /tmp/tangle-oidc-gtr/first-party.jsonl
```

For a public client, unset `TANGLE_OIDC_CLIENT_SECRET`. For an HTTPS sandbox,
set `GTR_ORIGIN` to that exact public origin, expose port 8789 through the
operator's sandbox routing, and set `HOST=0.0.0.0`.

Open `GTR_ORIGIN` with browser Network preservation enabled. Click Sign in.
Capture the authorize origin, path, client_id, redirect_uri, response_type,
scope and code_challenge_method. Complete the configured provider sign-in and
consent. Capture the consent screenshot and final application URL. Redact
codes, state, verifier, cookies and Authorization headers from shared evidence.

Click Session. Require HTTP 200, the expected subject, and
`refreshAvailable=true`. Stop and restart the listener with the same database, issuer, client, and callback.
Reopen the application and require the same authenticated session.
Click Refresh twice. Require HTTP 200 each time,
`subjectUnchanged=true`, `accessChanged=true`, and `refreshRotated=true`.
Record the token hashes and `provider_http` records. The second refresh must
use the stored replacement credential rather than the original one.

Click Disconnect. This revokes both tokens and then submits the revoked refresh
token to the real token endpoint. Require HTTP 200 from the caller,
`revokedRefreshRejected=true`, and `revokedRefreshStatus=400`. The probe accepts
only `invalid_grant`, not a network failure or `invalid_client`. Click Session
again. Require HTTP 401. Record the response and the provider HTTP records.

Stop the listener.
Set the third-party client ID, secret, and a separate third-party.sqlite store path.
Use a separate third-party JSONL log.
Repeat sign-in, consent, restart, both refreshes, disconnect, and the rejected revoked refresh.
All
provider authorization, token, userinfo and revoke requests must use the same
configured issuer under `/api/auth/oauth2/*`. There must be no request to
`/cross-site/authorize`, `/cross-site/exchange`, or `/v1/apps/oauth/token`.

Attach the source commit, install/build exit codes, registration IDs, app and
issuer URLs, sanitized HTTP records, screenshots, and both JSONL files. Do not
attach secrets or token values. Retain actual failures as failures.
