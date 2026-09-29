# Text the agent application you already have

A messaging line enters the application's existing conversation and accepted task. Native Lines retains its consent, inbox, retries and outbox. The application retains its preparation, permissions, selected profile, transcript, files and usage settlement.

## Four host operations

```ts
import { createApplicationLineHandler } from '@tangle-network/agent-app/hosted-agent/application'

export const POST = createApplicationLineHandler({
  authenticate: lineAuthority.authenticate,
  authorize: lineAuthority.recheck,
  read: applicationTurns.readSettled,
  admit: applicationChat.admit,
})
```

The named objects denote the host's existing services, not additional exports. `ApplicationLineOptions<T>` is the full contract:

| Operation | Required behavior |
| --- | --- |
| authenticate | Verify the callback credential before consuming its body. Return the exact opaque binding and server-resolved target. Credentials stay in server secret storage, not the sandbox. |
| authorize | Recheck account/workspace ownership, selected conversation, current attachment, admitted member and original message. Read the retained bytes with `client.lines.message(lineId, messageId)` rather than trusting supplied text. |
| read | Observe the same accepted execution and settled transcript/files/usage. `missing` means affirmative absence, never a failed read. |
| admit | Enter the normal authenticated chat path with `input.messageId` as the stable client-turn key. Reuse its locks, preparation and durable completion. Deduplicate concurrent requests and retries in that existing path. |

Hub retains the returned execution ID. Thereafter `acceptedExecutionId` pins recovery; missing state causes a read retry, never another admission. The handler rechecks authority after reads/admission and rejects a changed result identity. It does not propagate the HTTP viewer's cancellation to accepted work.

`pending` with `admitted: false` is not completion; another conversation turn may hold the existing lock. A pending human decision should produce a permission-checked pointer to the application's normal decision UI, not implicit approval by text.

## Attach an existing workspace

```ts
import { attachWorkspaceLine } from '@tangle-network/agent-app/hosted-agent/application'

await attachWorkspaceLine({
  box: authorizedPreparedWorkspace,
  lineId: ownedLine.id,
  ownerAddress: explicitlyDelegatedSender,
  turnsPerDay: 20,
  application: { url: trustedCallbackUrl, binding: immutableBinding, secret: callbackSecret },
})
```

Values come from an authenticated owner operation. The helper calls `box.lines.attach` with one declared owner, own-context act authority and unknown senders rejected. It adds no persona, model, namespace, payer override or second sandbox. The first inbound message establishes messaging consent; the host separately verifies the owner's explicit delegation of that sender.

The application mode refuses native voice, public/shared members, instance creation and native backend/allowance overrides. Those paths must not bypass application admission or billing. Public buyers require restricted or isolated execution, never the private owner's workspace.

## Reuse connection UI

```tsx
import { ApplicationLineSetup } from '@tangle-network/agent-app/hosted-agent/react'
import '@tangle-network/agent-app/hosted-agent/react/styles'

<ApplicationLineSetup
  client={ownerAuthenticatedLineClient}
  scopeKey={`${user.id}:${workspace.id}`}
  canManage={isExplicitOwner}
  enabled={applicationMessagingEnabled}
/>
```

The client supplies load/connect/disconnect through normal host authorization. Include each line's attachmentId in the snapshot; disconnect receives that viewed identity, which the host passes to the native conditional detach. Never replace it with a newer attachment read at mutation time. Connect receives the existing target, nominated operatorAddress and turnsPerDay. Changing sender, limit or scope clears confirmation. Disabling new grants leaves disconnection available. The existing LineSetup owns channel selection, loading, errors and disconnect confirmation.

A message limit is not a dollar cap. Enforce compute spend at the service paying for work. STOP suppresses replies; it does not cancel an accepted application task. Use the application's explicit cancellation control for that task.

## Release and proof

The `hosted-agent/application` server entrypoint requires Sandbox 0.58.1 or later in the 0.58 series.
The existing `hosted-agent` entrypoint remains importable with older Sandbox versions in the package's peer range.
This addition depends on the native application-backed Lines SDK and server change in agent-dev-container #8499.
Pin published SDK, Runtime and Agent App archives before consumer lock generation.

Deploy native callback support before enabling the host flag. Use a disposable owned test line and consenting sender. Do not reattach an existing assistant's production line. The management client must use existing authorized application access, not a short-lived compute child: Lines retains that caller's key ID. Expiry/revocation ends the grant; do not extend a compute token indefinitely or expose application keys to the agent.

Required journey: text an existing conversation, close the browser, inspect the settled output in that same conversation, then correct it. Join native applicationExecutionId to the application's completion record. Repeat after callback-process death, concurrent messages, revoked authority, STOP/START and stale disconnect. Provider acceptance is not proof that the handset received the answer.

The read-only inspector saves hashed message evidence without attaching, sending, approving or starting compute:

```bash
umask 077
export TANGLE_API_KEY_FILE="$HOME/.config/tangle-test/owner.key"
export SANDBOX_URL=https://sandbox.tangle.tools
export LINE_ID=YOUR_DEDICATED_TEST_LINE
node examples/workspace-line/inspect.mjs /private/path/line-evidence
```

Keep the credential file private; share only its path, never its value. Evidence can still reveal identities and must be reviewed before sharing. Native scheduled prompts are not treated as owner-written commands; scheduled application work remains on the host's existing admission path.
