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

## Verify the handset and attach an existing workspace

The owner server creates or finds the selected owned Inkbox iMessage line.
It calls `ownerLines.startSenderVerification(lineId)` with the owner API key.
Only the returned TEST text, test ID, state and expiry go to the browser.
The owner texts TEST to the line and follows the private confirmation reply on the handset.
The private confirmation and `approvedSender` stay off the browser.
For status responses, the server calls `ownerLines.getSenderVerification(lineId, testId)` with that same key and projects the public fields with `publicApplicationSenderVerification`.
The Platform accepts only a verified, unexpired, one-use proof during attach.

```ts
import {
  attachWorkspaceLine,
  publicApplicationSenderVerification,
} from '@tangle-network/agent-app/hosted-agent/application'

const status = await ownerLines.getSenderVerification(ownedLine.id, testId)
return Response.json(publicApplicationSenderVerification(status))
```

After the public status reports `verified`, the authenticated owner route calls:

```ts
await attachWorkspaceLine({
  box: authorizedPreparedWorkspace,
  ownerLines,
  lineId: ownedLine.id,
  senderVerificationId: testId,
  turnsPerDay: 20,
  application: { url: trustedCallbackUrl, binding: immutableBinding, secret: callbackSecret },
})
```

The helper reads `approvedSender` from the owner SDK, then passes that member and `senderVerificationId` to `box.lines.attach`.
The owner read, box attach and TEST start must use the same owner API key.
The Platform checks the proof, sender, key and attachment together; a stale or reused test cannot attach.
The helper keeps one declared owner, own-context act authority and unknown senders rejected.
It adds no persona, model, namespace, payer override or second sandbox.

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

The browser client supplies `load`, `startSenderVerification`, `getSenderVerification`, `connect` and `disconnect` through authenticated host routes.
The active setup offers only owned Inkbox iMessage identities.
`startSenderVerification` receives the selected connection and target; the host creates or finds that owned line before starting TEST.
`getSenderVerification` returns only the public projection shown above.
`connect` receives the selected target, `senderVerificationId` and daily message limit; it does not receive a sender address.
The host rechecks owner authority and calls the attach helper with the same owner key.
Changing the selected line prevents the previous test from connecting the new selection.
Include each line's `attachmentId` in the snapshot.
Disconnect receives that viewed identity, which the host passes to the native conditional detach.
Never replace it with a newer attachment read at mutation time.
Disabling new grants leaves disconnection available.
The existing `LineSetup` owns loading, selection, errors and disconnect confirmation.

A message limit is not a dollar cap. Enforce compute spend at the service paying for work. STOP suppresses replies; it does not cancel an accepted application task. Use the application's explicit cancellation control for that task.

## Release and proof

The `hosted-agent/application` sender-proof helper requires a Sandbox SDK release containing agent-dev-container #8614.
Sandbox 0.58.8 does not provide its verification methods or attach token type.
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
