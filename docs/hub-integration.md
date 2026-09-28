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

## Verify a consumer

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
