# Channels

`@tangle-network/agent-app/channels` is the browser-safe, L3 React surface for
connecting an agent's iMessage, WhatsApp, SMS, and email lines, proving delivery,
reading member conversations, acquiring phone numbers, and presenting a line's
member checkout. It contains no provider HTTP client, credential handling,
webhook router, sandbox provisioning, or payment settlement.

## Mount once below authentication

```tsx
import {
  ChannelsProvider, IMessageChannel, WhatsAppChannel, SMSChannel, EmailChannel,
  ChannelConversations, LinePayPage, type ChannelsClient,
} from '@tangle-network/agent-app/channels'

export function AgentChannels({ client, lineId }: {
  client: ChannelsClient
  lineId: string
}) {
  return (
    <ChannelsProvider client={client}>
      <IMessageChannel />
      <WhatsAppChannel />
      <SMSChannel />
      <EmailChannel />
      <ChannelConversations lineId={lineId} />
      <LinePayPage lineId={lineId} />
    </ChannelsProvider>
  )
}
```

Keep `client` stable and change its `scope` when the authenticated agent/owner
changes. The provider remounts channel state on a scope change. Do not put a root
SDK API key in browser code. Supply an authenticated application client/proxy;
its server derives ownership from the session, never from the scope string.
Components use the existing theme tokens and ordinary labelled HTML controls;
there is no router peer or provider-specific UI dependency.

## One client seam; no second hosted-agent implementation

`ChannelsClient` is the single injected boundary. `lines` retains Sandbox SDK
signatures for `fromConnection`, `get`, and `threads`. Bind `list` to this agent's
lines (for a single sandbox, use its `box.lines.list()`), not the owner's global
line list. The backend must authorize every supplied line, thread, source, and
order identifier. `client.lines.threads(lineId).messages(threadId)` remains the
authoritative channel history; it is not reconstructed from a replay buffer.

Use Sandbox **0.52.1** and Hub SDK **0.19.0** for the complete channels surface.
Sandbox 0.51.0 supplies the original iMessage line API but does not type WhatsApp
connection creation. The package inherits Sandbox 0.52.1 and its compatible
Runtime 0.266.0 from the merged hosted-agent lane. Only type imports from Sandbox
and Hub are emitted in declarations. JavaScript imports React and existing
agent-app async primitives, not either server SDK.

Sandbox `fromConnection` currently accepts shared iMessage and an owned
WhatsApp phone-number ID. It does **not** accept email or SMS. The host's `setup`
methods deliberately supply missing Hub/hosted-agent operations: available
connections/numbers, email creation, managed-order binding, verification, and
activation. They must delegate to the Hub SDK and sandbox.lines, not providers.
The merged `src/hosted-agent` entrypoint exposes `createHostedAgent` and
`HostedAgent.attachLine(connectionId)` for server-side iMessage attachment.
A hosted application should use that existing operation in its authenticated
`setup.activate` implementation, after checking the current test and ownership;
then read and return the attached line through `sandbox.lines.get`. Its existing
per-person sandbox, profile, routing, STOP/START and reply behavior stay there,
not in channels. Other transports remain on the injected host boundary. The
entrypoint does not export a browser line-setup client, so this module does not
bundle its server runtime or change its files. There is no fabricated SDK
method or hardcoded Builder route.

The four Builder reference panels map to `IMessageChannel`, `WhatsAppChannel`,
`EmailChannel`, and `NumberChannel`/`SMSChannel`. Builder replacement and creator
payouts are separate work. `NumberChannel` handles acquisition of SMS/iMessage
phone numbers; buying one does not enable WhatsApp or configure voice calls.

## Verification authority

A connection creates/binds a line, not an active answering agent. Start a test,
observe the inbound TEST message, send the test reply, observe the sender's
CONFIRM reply, then explicitly turn on messaging. The server owns those events
and the proof. `ChannelVerification` contains only public instructions, status,
expiry and errors: never a confirmation secret or sender identity. Acquisition,
a successful send call, and `Line.status === 'active'` do not prove both
communication directions. Activation must recheck proof and ownership before
attaching with sandbox.lines; UI checks are defense in depth, not authorization.

The UI represents configuring, waiting, received, sending, uncertain, sent,
verified, revoked, expired, and needs-review states. An uncertain send offers a
status check, not a second send. Reset and number cancellation require explicit
confirmation. SDK failures remain failures with recovery controls, not empty
lists. Polling starts after each settled read (3 seconds, at least 15 seconds
while hidden); `pollInterval={false}` disables it. Reads are sequence guarded,
abortable where the host supports it, and timers stop at unmount. Writes are
single-flight; changing views does not undo an already dispatched remote write.

## Money and member checkout

Optional `ordering` supplies the existing Hub managed-number client plus stable,
server-validated transport references. Number lists are scoped and paginated;
an older response without an explicit terminal cursor cannot prove absence of
an existing order. A held order blocks another purchase. The UI requires terms
and affirmative consent, keeps the exact signed quote after a lost response,
and retains an acknowledged order even if its follow-up read fails. It never
labels `ready_for_setup` as delivery verified. Cancellation is not a refund.

Optional `payment` supplies authenticated reads of Hub allowance plan/status and
a host-owned checkout operation. The server derives the member and meter from
authentication. `LinePayPage` displays the plan and allowance, requires terms
consent, and links to a credential-free HTTPS (or same-origin relative) checkout.
It does not admit turns, grant a tier, settle payment, or mark a member paid from
a return URL. Only a later confirmed Hub read can show a paid allowance. No
checkout is offered when paying cannot lift the current limit.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test tests/channels
node scripts/test-channels-mutation.mjs
pnpm test
pnpm docs:gen
pnpm knip
```

Hook tests exercise an SDK-shaped fake through rendered React hooks. Component
tests exercise labelled fields, keyboard/pointer actions, proof states, history,
and payment consent. The package test uses a separate Node process to import the
actual built public subpath; absent build output fails, never skips. The mutation
script removes the activation guard, requires the protected test to fail, then
restores the exact source and requires a pass. Storybook's Channels group shares
the same typed fixtures and covers source selection, proof, failure, acquired
numbers, history, and pay-page states. This is UI/control-plane contract coverage,
not a live-provider delivery or payment-settlement claim.
