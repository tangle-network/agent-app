# Connect to ChatGPT

`ChatGPTConnect` is the shared optional setup surface for apps that already expose
`@tangle-network/chatgpt-agents-kit` over their native enrollment. It provides one
primary action, supported setup instructions, endpoint copying, and controlled
connection states. The module uses Tangle UI Button/Input and the app's Brand
light/dark tokens. It does not make network requests or retain credentials.

```tsx
import { ChatGPTConnect } from '@tangle-network/agent-app/chatgpt-react'
import '@tangle-network/agent-app/styles'
import '@tangle-network/agent-app/chatgpt-react/styles'

<ChatGPTConnect
  app={publicAgentAppMetadata}
  endpoint={publicMcpResource}
  enrollment={authorizedEnrollmentIdentity}
  registeredConnection={registeredChatGPTConnection}
  state={connectionState}
  onCheck={refreshConnectionState}
/>
```

- `app` accepts the `name`, `displayName`, and `description` from the kit's
  `AgentAppDescription` or `defineAgentAppMetadata` result. Pass the same public
  metadata used by the endpoint; the browser does not import the server kit.
- `enrollment` is the existing `AgentEnrollmentIdentity`. The UI displays its
  agent and workspace IDs. It never creates an enrollment, changes native
  sessions, selects a workspace, or adds a grant.
- `registeredConnection` is optional `{ id, url }` from a real registration.
  Supply the exact verified HTTPS `chatgpt.com` destination. The UI does not
  derive a deep link from the ID, app name, or endpoint. Missing or invalid
  registered destinations use the setup guide.
- `state` is controlled by the host: `not-connected`, `checking`, `connected`,
  or `error` with a user-facing `message`. Only report `connected` when the host
  can verify the connection for the current authenticated account and workspace.
  Opening a URL, generating plugin files, or possessing public registration
  metadata does not establish this state.
- `onCheck` is optional. Omit it if the host has no reliable existing status
  probe. The host owns async errors and stale-response protection; reset its
  state on user/workspace changes. The component resets expanded setup and copy
  feedback when its enrollment or endpoint changes. It does not implement
  discovery, OAuth, enrollment, routing, billing, or a second connection store.

The stylesheet is optional and separate from the browser JS. Import the existing
`/styles` theme once in the app shell. The component's CSS needs no Tailwind scan
configuration and inherits light/dark/named Brand tokens.

## Supported destination

The [official OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
(as checked 2026-10-02) directs users to developer mode and
[ChatGPT Plugins](https://chatgpt.com/plugins) to add an MCP endpoint. Account and
workspace policy can limit availability. The UI follows that supported guide
when no registered link exists. Plugin packaging is a separate step described in
[OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins).
No generated file, app ID, or public store publication is implied.

## Two installed examples

Run on a Beelink from this checkout:

```sh
pnpm install --frozen-lockfile
node examples/chatgpt-connect/preview.mjs /tmp/chatgpt-connect-proof
# A separate shell while the preview runs:
node examples/chatgpt-connect/proof.mjs /tmp/chatgpt-connect-proof
```

The preview packs the app package with its normal build hook, installs the tarball
in a fresh consumer, and bundles only public browser exports. It installs kit
0.1.0 and uses its metadata factory for GTM and Creative configurations. Each has
its own explicitly fictional `.example.com` endpoint and native enrollment
identity fixture. There is one imported component for both configurations.

Open `http://127.0.0.1:4401/?app=gtm` or `?app=creative`; add `&theme=dark`.
`CONNECT_PORT` changes the preview port and `CONNECT_URL` sets the browser proof's
base URL. Optional `state=checking|connected|error` selects a controlled host
snapshot. `registeredFixture=1` exercises an exact supplied official Plugins URL
with a test ID; it is not a shareable install link or real registration.

The proof validates desktop/mobile, light/dark, keyboard focus, clipboard,
responsive overflow, status callbacks, error recovery, and Axe checks. It retains
screenshots and original-speed videos, installation logs, browser dependency
inputs, and archive hash. It does not perform OAuth, ChatGPT installation, live
status verification, or hosted agent work. Root delivery owns Builder adoption
and the real ChatGPT consumer proof.
