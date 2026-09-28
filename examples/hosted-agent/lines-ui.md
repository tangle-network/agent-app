# Line management UI

Mount `LineSetup`, `LineMembers`, and `LineBilling` from `@tangle-network/agent-app/hosted-agent/react`.
Import `@tangle-network/agent-app/hosted-agent/react/styles` once in the app's client entry.
The components call an authenticated product route; API keys stay on the server.
This subpath needs `@tangle-network/sandbox` 0.55.2 or newer for its line types and methods.

`LineSetupClient.load()` returns every line in the current workspace, owned Hub connections with their available identities, and the agents or boxes that can answer.
Set `answering` from an active SDK line attachment, not from `line.status` alone.
Set `lastTurn` to `latest`, `none`, or `unavailable` so a failed history read never looks like an empty conversation.
Set `canDisconnect` only for lines this viewer may detach.
Pass the SDK's `providerNumberId` on every line, including `null` for transports without one.
For a WhatsApp connection with several numbers, expose each owned number as a separate identity with its provider number ID.
When Hub requires manual entry, set `requiresPhoneNumberId`; reconnect enables only when the entered ID matches the disconnected line.
The UI allows one non-released line per transport in that workspace.
The server must enforce the same rule because two browser requests can race.

The server uses the published clients:

- `sandbox.lines.list()` and `sandbox.lines.get()` read lines and attachments.
- `sandbox.lines.fromConnection()` creates or finds a line from an owned connection.
- `sandbox.lines.attach()` assigns one sandbox instance per member.
- `box.lines.attach()` assigns a shared box.
- `sandbox.lines.members(lineId)` lists, adds, changes, and removes members.
- `sandbox.lines.threads(lineId)` supplies the latest turn status and timestamp.
- `hub.connections.list()` supplies owned connections.
- `hub.allowances.plan()` and `hub.allowances.status()` supply allowance facts when configured.

The currently published Sandbox SDK supports iMessage, WhatsApp, and email in `fromConnection()`.
Offer a transport only when the owned connection and deployed Hub can serve it.
An Inkbox handle line returns `routerAddress` and `connect`; show both so a member knows to text `connect @handle`.
A dedicated number uses its existing owned connection.
This UI does not order or buy a number.

`LineMembers` uses the line attachment's role map.
Pass a `scopeKey` that changes with the authenticated viewer or workspace.
For a one-member product, pass `maxMembers={1}` and `allowRemoveLastOwner` only when the server permits freeing the line.
If owner enrollment differs from a normal invitation, set `canAdd={false}` and keep that enrollment in a verified product action.
Hub marks a newly invited address as `invited` until its first message; STOP changes the state to `stopped`.
The member must send START to resume replies.
The server must enforce member caps and last-owner rules because another client can change membership between reads.

`LineBilling` displays the payer and daily allowance supplied by the server.
Set `linePayer.kind` or `turnPayer.kind` to `unverified` when the billed identity cannot be confirmed.
Member-paid turns need the platform's member-pay API; a label in this component does not change payment routing.

Storybook contains connected, disconnected, empty, loading, error, and reconnect states under `Hosted agent/Lines`.
The interactive setup and member stories run in both agent-app light and dark themes.
Hosts overriding `--line-kit-accent` should set `--line-kit-accent-foreground` to a readable text color for that accent.
