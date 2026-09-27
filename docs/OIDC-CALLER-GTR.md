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

## Installable runtime pin

Agent-app Actions run 36296798328 observed npm latest 0.277.0 without either
OIDC export, and 404 for 0.278.1. This branch instead pins
`github:tangle-network/agent-runtime#a3d2eb6a2d523caec56edb438be026339b8b5b27`.
That immutable Git commit contains the built runtime package from source
`68532c2c76e6dea3c3d66c5977a9c269fef5b3f5`, prepared in runtime Actions run
36297073605. It reuses #1410. No client implementation is copied into this
repository. The package has resolved catalog dependencies and no install
scripts. Its `tangleBuild` metadata records the source and run. The prepared
build branch must not be merged into runtime main. Replace the pin only after
verifying the corresponding npm package exports and integrity.

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

## Evidence status

No staging browser login, client registration, refresh, disconnect, or revoked
refresh success is claimed in this document. Build results belong to the linked
Actions receipts. The proof listener below uses the built library and real HTTP
to the provider. Its in-memory store is a single-process proof fixture, not a
production persistence recommendation. This does not prove an unmigrated
vertical agent. Do not mark the proof passed without the actual receipts.

## Exact GTR procedure

Use Node 22.13 or newer, Git, Corepack, a browser, a disposable verified staging
account, and two existing-provider client registrations. The Platform operator
must supply `STAGING_ID_ORIGIN`, `FIRST_PARTY_CLIENT_ID` and
`THIRD_PARTY_CLIENT_ID`, plus a secret for each confidential client. Record the
registration IDs and method in the receipt, never the secrets.

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
export TANGLE_OIDC_ISSUER="$STAGING_ID_ORIGIN"
export TANGLE_OIDC_CLIENT_ID="$FIRST_PARTY_CLIENT_ID"
export TANGLE_OIDC_CLIENT_SECRET="${FIRST_PARTY_CLIENT_SECRET:-}"
node scripts/oidc-live-proof.mjs | tee /tmp/tangle-oidc-gtr/first-party.jsonl
```

For a public client, unset `TANGLE_OIDC_CLIENT_SECRET`. For an HTTPS sandbox,
set `GTR_ORIGIN` to that exact public origin, expose port 8789 through the
operator's sandbox routing, and set `HOST=0.0.0.0`.

Open `GTR_ORIGIN` with browser Network preservation enabled. Click Sign in.
Capture the authorize origin, path, client_id, redirect_uri, response_type,
scope and code_challenge_method. Complete the actual staging sign-in and
consent. Capture the consent screenshot and final application URL. Redact
codes, state, verifier, cookies and Authorization headers from shared evidence.

Click Session. Require HTTP 200, the expected subject, and
`refreshAvailable=true`. Click Refresh twice. Require HTTP 200 each time,
`subjectUnchanged=true`, `accessChanged=true`, and `refreshRotated=true`.
Record the token hashes and `provider_http` records. The second refresh must
use the stored replacement credential rather than the original one.

Click Disconnect. This revokes both tokens and then submits the revoked refresh
token to the real token endpoint. Require HTTP 200 from the caller,
`revokedRefreshRejected=true`, and `revokedRefreshStatus=400`. The probe accepts
only `invalid_grant`, not a network failure or `invalid_client`. Click Session
again. Require HTTP 401. Record the response and the provider HTTP records.

Stop the listener. Set the third-party client ID and secret. Run the listener
with `/tmp/tangle-oidc-gtr/third-party.jsonl` as its log file. Repeat sign-in,
consent, both refreshes, disconnect, and the rejected revoked refresh. All
provider authorization, token, userinfo and revoke requests must use the same
staging server under `/api/auth/oauth2/*`. There must be no request to
`/cross-site/authorize`, `/cross-site/exchange`, or `/v1/apps/oauth/token`.

Finally start another login and change one character of state in the returned
callback URL. Require `tangle_state_mismatch`, a cleared state cookie, and no
token request. Repeat by changing the verifier in the state cookie without
changing its MAC. Require the same outcome. These negative checks do not replace
the positive sign-in receipt.

Attach the source commit, install/build exit codes, registration IDs, app and
issuer URLs, sanitized HTTP records, screenshots, and both JSONL files. Do not
attach secrets or token values. Retain actual failures as failures.
