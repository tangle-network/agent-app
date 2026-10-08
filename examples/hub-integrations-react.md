# In-app Hub settings

`./integrations-react` composes the finite server routes from `./platform` with the controlled views in `@tangle-network/sandbox-ui/integrations`.
Install supported Sandbox UI and Hub SDK peers from this package's declared peer ranges.
This subpath's public types use Hub SDK response types.
The Hub SDK remains on the server at runtime and does not enter the browser bundle.
The other Agent App subpaths retain their existing Sandbox UI peer window.

Mount `createHubSettingsRoutes` at `/api/hub/settings` on the app server.
Set `oauthCallbackPath` to the exact path of the page that renders `HubConnectCallbackPage`.
The routes then accept an OAuth start only when it returns to that path with the `provider`, `nonce`, and `context` parameters the panel adds, and nothing else.
Its `authorize` callback must check the signed-in caller, CSRF, workspace role, and the exact `HubSettingsOperation` for every read and write.
Compare the three expected identity headers below with the **server-derived** principal on both authorization calls.
Treat the headers as stale-session checks, never as authentication or grants.
Resolve only that caller's account-bound Hub SDK client after the first grant.
Do not use an admin key, browser Hub token, or brokered execution token.

```tsx
import {
  createHubIntegrationsClient,
  HubConnectCallbackPage,
  HubIntegrationsPanel,
  type HubIntegrationCapabilities,
  type HubIntegrationsIdentity,
} from '@tangle-network/agent-app/integrations-react'
import '@tangle-network/sandbox-ui/styles'

const client = createHubIntegrationsClient(({ identity, path, init }) => {
  const headers = new Headers(init.headers)
  headers.set('X-Requested-With', 'XMLHttpRequest')
  headers.set('X-Expected-User', identity.userId)
  headers.set('X-Expected-Session', identity.sessionId)
  headers.set('X-Expected-Workspace', identity.workspaceId)
  return fetch(path, { ...init, headers, credentials: 'same-origin' })
})

// Obtain identity and display capabilities from the app's own signed-in state.
// The server rechecks both; the callback below only controls visible actions.
function Settings({ identity, can }: { identity: HubIntegrationsIdentity; can: HubIntegrationCapabilities }) {
  return <HubIntegrationsPanel
    identity={identity}
    client={client}
    can={can}
    callbackPath="/integrations/connect-callback"
  />
}

// Mount at the exact callbackPath above in the app's router.
function ConnectCallback() {
  return <HubConnectCallbackPage returnHref="/integrations" />
}
```

The app derives `identity` and `can` from its signed-in state.
The host may render additional API-key metadata fields through `renderApiKeyMetadata`.
Custom signup flows use `onUnsupportedConnect`; the panel does not redirect to Platform management.
For host-owned access, such as which accounts one agent or workspace may use, pass `accounts`.
The panel then lists each connected account once, with the host's `getStatus` and one inline `getPrimaryAction` control, followed by a catalog of providers that have no account yet.
Manage opens the account's permissions, test, Disconnect, and Connect another account, and repeats the host's status and control there.
The host authorizes the control and supplies the new status only after its server confirms the change.
Without `accounts`, `getConnectionContext` and `getConnectionActions` decorate each account inside its catalog card.

OAuth opens a popup during the user gesture.
The callback broadcasts an opaque provider, nonce, and context signal.
The controller then reads the authorized connection list and accepts only a new or changed active connection.
The signal and an older connection alone cannot report success.
Connection detail selection stays in the app URL's `integration` and `connection` query parameters, so Back and reload restore it.

Permission controls show only stored overrides from `GET /policies`.
They do not guess a broker principal's effective policy or treat a connection as a workspace grant.
The server action endpoint returns at most 200 actions; reaching that limit shows an incomplete-catalog warning.
Each write waits for a server receipt and then rereads authoritative state.
An accepted write with a failed reread appears as a distinct refresh warning.
The host must retain `createHubSettingsRoutes`' exact operation allowlist and repeat authorization.
