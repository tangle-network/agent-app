# Published packages, sweep 1

## What landed on this branch

Baseline: `e8854f80b97e55b4a1fa07d7efe30afb0b829961`.
Migration: `650b485ee7dab1bb816ea083b3c73e8ab4828cf8`.

[The source change](https://github.com/tangle-network/agent-app/blob/650b485ee7dab1bb816ea083b3c73e8ab4828cf8/src/integrations/index.ts) deletes App's handwritten Hub HTTP client and envelope parser. `HubExecClient` is now a product-outcome adapter around `HubClient.tools.invoke` from published `@tangle-network/hub-sdk@0.19.2`. It keeps the public result union and route outcomes. It never requests approval automatically.

[The migration execution](https://github.com/tangle-network/agent-app/actions/runs/36299740338) passed frozen installation and the real `tsup && tsc -p tsconfig.build.json` build. Its artifact's `commit.txt` identifies the built commit. The bootstrap job committed the migration before building, so its initial checkout SHA is different. The bootstrap workflow is deleted from the final tree. The retained proof workflow is read-only.

The first isolated consumer install exposed pnpm's dependency-script approval gate for `cpu-features` and `ssh2`. The consumer recipe now explicitly refuses those optional native builds, matching this repository's existing `pnpm-workspace.yaml`. It does not disable peer validation or automatically approve dependency scripts. The retained workflow runs the same packed consumer install and checks the installed entrypoints.

No real Hub action or consuming application's main user flow was run by the author. Those acceptance results are operator-pending. A successful library build is not a live-flow pass.

## Inventory and boundaries

Source, manifests, lockfiles, vendored fixtures, and platform HTTP/lifecycle call sites were inspected. The table lists identified copies and candidates. It does not prove the absence of every semantic duplicate.

| Baseline path | Disposition |
| --- | --- |
| `src/integrations/index.ts:74-140` | Migrated. Deleted `HubEnvelope`, local `/v1/hub/exec` fetch, and response parser. Published Hub SDK owns transport and errors. App retains only MCP action-name resolution, the per-user key resolver, and its route outcome. |
| `src/peer-floors/fixtures/vendored-tarball/vendor/agent-app/tangle-network-agent-app-0.45.33.tgz` | Retained negative fixture for the dependency-source gate. It is not a production vendored dependency. Deleting it would remove the bad-input example, not migrate the application. |
| `src/runtime/openai-stream.ts` | OPEN. Raw model/SSE transport remains. Preserve served-model attribution and request controls before replacing it. A private Runtime class is not a supported package import. |
| `src/sandbox/index.ts`, `src/sandbox/recovery.ts` | OPEN. Sandbox lifecycle/reconciliation remains. Its explicit approval before unsnapshotted recovery is not equivalent to unconditionally ensuring or recreating an instance. |
| `src/sandbox/workspace-sandbox-manager.ts` | OPEN. Name-based workspace discovery/provisioning remains a candidate for published named-instance identity. |
| `src/platform/sso.ts` | App state/account-link orchestration remains around platform auth calls. This PR is not an authorization-server consolidation. |
| `src/platform/billing.ts` | OPEN. Service/user authorization boundaries, HTTP, and entitlement parsing remain. Replacing service-admin operations with a user-key SDK would change authority. |
| `src/platform/hub.ts` | App bearer selection and proxy wiring remain around the platform client. Not the raw client removed from `src/integrations/index.ts`. |
| `src/runtime/protected-model.ts` | Product-facing model protection and accounting adapter remains. |
| `src/alerting/slack.ts` | OPEN. A direct Slack alert sink remains. It is not migrated by changing the integration invocation path. |
| `src/crypto/index.ts`, `src/missions/`, `src/hosted-agent/`, `src/spend/` | Shared App-owned capabilities, not copied implementations of this same package. Lower-package equivalence must be established per operation. App cannot remove its own implementation by depending on itself. |
| `src/tools/openai.ts`, `src/tools/http.ts` | Required `description` and `parameters` contracts stay intact. The weak Runtime type alias from closed PR #645 is not carried forward. |

This PR is a Hub transport migration, not a claim that the sandbox, model, billing, or scheduling sweep is complete.

## Published dependency selection

`hub-sdk` is pinned to `0.19.2` for development, and its peer floor is now `>=0.19.2 <0.20.0`. Interface development moves to `2.13.0`. Sandbox development moves to `0.54.2`, with the tested `^0.54.0` peer band added.

Regenerating the real lockfile exposed incompatible existing evaluation peers. Runtime `0.277.0` requires Eval `>=0.191.0 <0.194.0`. Knowledge `17.1.5` excluded that range. The branch uses published Knowledge `17.1.8` and Eval `0.193.2`, which share a compatible range. It does not turn off strict peer checks. Eval `0.193.2` is deliberately not npm's latest Eval release.

This branch is not a published App release. The other sweep repositories install published App `0.49.26`; they do not silently consume this branch through a workspace or vendored tarball. A throwaway packed artifact below is only a prepublication acceptance environment.

## Approval compatibility

Hub SDK invocation may attempt to mint a capability token after an approval-required response. This is different from the former single HTTP call. The adapter never sets `approve: true`, and Hub remains the policy authority. Do not infer that every deployment refuses the mint from a passing TypeScript build. The live denial and no-effect checks below are mandatory.

Typed SDK errors are adapted back to the public result union. Unknown transport failures are not disguised as successful tool results. Raw malformed responses now follow the SDK's error handling rather than App's deleted parser.

## GTR proof

### 1. Clean install and real build

Use Node `24.18.0` and pnpm `11.24.0` in a clean checkout of this PR.

```sh
set -euo pipefail
umask 077
mkdir -p .gtr-private
git rev-parse HEAD | tee .gtr-private/commit.txt
node --version | tee .gtr-private/node.txt
pnpm --version | tee .gtr-private/pnpm.txt
pnpm install --frozen-lockfile 2>&1 | tee .gtr-private/install.log
pnpm build 2>&1 | tee .gtr-private/build.log
node --check scripts/prove-published-hub.mjs
git diff --exit-code -- package.json pnpm-lock.yaml
pnpm why @tangle-network/hub-sdk @tangle-network/agent-runtime @tangle-network/agent-eval \
  > .gtr-private/packages.txt
```

Retain the exact source SHA, dependency versions, lockfile, and build log. Do not run an unrelated coverage suite as a substitute for the next steps.

### 2. Install the built package in a disposable consumer

The consumer intentionally installs the PR artifact, not the old npm App release. The artifact is never committed to a product's `vendor/` directory.

```sh
repo="$PWD"
pnpm pack --pack-destination .gtr-private
package_file=$(node -p "require('node:path').resolve('.gtr-private/tangle-network-agent-app-' + require('./package.json').version + '.tgz')")
test -f "$package_file"
consumer=$(mktemp -d)
printf '{"name":"gtr-app-consumer","private":true,"type":"module"}\n' > "$consumer/package.json"
printf 'allowBuilds:\n  cpu-features: false\n  ssh2: false\n' > "$consumer/pnpm-workspace.yaml"
cp scripts/prove-published-hub.mjs "$consumer/"
cd "$consumer"
pnpm add "$package_file" @tangle-network/hub-sdk@0.19.2 @tangle-network/agent-integrations@0.55.0 \
  2>&1 | tee "$repo/.gtr-private/consumer-install.log"
```

Use a disposable Hub account and an operator-controlled connected provider. Select a real, non-mutating action from that account's published connector catalogue. Set the provider, connector, and action IDs, rather than assuming a tool name exists. Set `PROOF_INPUT_FILE` to an absolute path containing that action's schema-valid JSON input. Keep it outside shared evidence when it contains personal data.

```sh
export PROOF_ACK_DISPOSABLE_ACCOUNT=yes
export PROOF_HUB_URL='https://id.tangle.tools'
: "${PROOF_HUB_API_KEY:?scoped test-account key required}"
: "${PROOF_USER_ID:?test account identity required}"
: "${PROOF_PROVIDER:?published provider id required}"
: "${PROOF_CONNECTOR:?published connector id required}"
: "${PROOF_ACTION:?published read action required}"
: "${PROOF_INPUT_FILE:?absolute JSON input path required}"
PROOF_EXPECT_STATUS=200 PROOF_OUTPUT="$repo/.gtr-private/hub-read.json" \
  node prove-published-hub.mjs
```

Pass requires a real provider result, status 200, `success: true`, and nonempty HTTP receipts. The script records method, path, status, and request ID. It never records authorization headers, input bodies, capability tokens, or provider output. Verify the read result in the restricted provider UI or application logs, not by publishing its contents.

### 3. Real policy refusal without an effect

Choose a harmless, disposable write target. Before invoking it, set its Hub policy to require owner approval using the normal Hub owner interface. Record the provider's initial state. Set `PROOF_ACTION` and `PROOF_INPUT_FILE` to the schema-valid write request.

```sh
PROOF_EXPECT_STATUS=409 PROOF_OUTPUT="$repo/.gtr-private/hub-approval.json" \
  node prove-published-hub.mjs
```

Pass requires `HUB_APPROVAL_REQUIRED`, no `/approve` request, no successful write, and no new provider-side effect. Inspect Hub audit records for the exact action and request IDs. A capability-token attempt is not approval evidence. If the SDK returns another code or executes the write, this gate fails and the migration must not be released.

Set the same action to explicit deny and repeat with `PROOF_EXPECT_STATUS=502`. The script additionally requires `HUB_POLICY_DENIED`. The provider must still show no effect. Restore only the disposable account's original policy after recording the result. Never relax a production policy to obtain a pass.

### 4. Main consuming-app flow

Install the same packed candidate in an isolated reference application's staging checkout. Build and deploy that application through its existing staging workflow. Record its lockfile, deployment SHA, and the exact packed App artifact hash. Sign in as the linked test account, send a normal agent message that requests the chosen read action, and verify its answer uses the provider result. Repeat the gated write from the app and verify that its approval UI appears, no provider effect occurs, and an unrelated user cannot resolve that approval.

Record the real request URL, status, session/run ID, sanitized browser screenshot, Hub audit request IDs, and provider observation. This repository is a library and has no independent sign-in deployment. A CLI call alone is not proof of every consuming application's UI.

### 5. Evidence and rollback

Attach the source/build/install records and secret-safe JSON receipts. Keep cookies, keys, raw HAR files, and provider data private. Live proof stays pending until these records exist.

Rollback the isolated consumer to its previous package lockfile and deployment. Do not publish, merge, or modify production policies as part of this proof. Delete only the temporary local consumer and revoke only disposable test credentials when finished.
