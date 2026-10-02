# Connect an existing Agent App to ChatGPT

`ConnectToChatGPT` is a small **read-only product surface**, exported from the
existing `@tangle-network/agent-app/integrations-react` entry point. It does not
register, install, publish, grant access, enroll an agent, or send a message.
Opening ChatGPT is a navigation, not a successful connection receipt.
Use the reviewed package built from this PR until the release owner publishes
an approved version; this document does not claim the current registry archive
already contains the new export.

## Mount once in the existing settings page

```tsx
import { ConnectToChatGPT } from '@tangle-network/agent-app/integrations-react'

<ConnectToChatGPT
  app={config.identity}
  enrollment={authorizedEnrollmentIdentity}
  endpoint={agentsMcpEndpoint}
  connection={loader.chatGPTConnection}
/>
```

These are existing app values, not new services to implement:

- `app` takes the existing `AgentAppConfig.identity` (only `name` is read). Use
  that same name for `createAgentsHandler`'s display metadata.
- `enrollment` is the existing `AgentEnrollmentIdentity`: enrollment, agent,
  workspace and thread IDs from an authenticated loader. Do not call `enroll`
  or create a replacement session just to populate this panel.
- `endpoint` is the same reviewed MCP resource advertised by the existing
  handler. This public-endpoint surface accepts HTTPS without user information,
  query parameters or fragments. It does not check reachability or authenticate.
- `connection` is optional, controlled display data from the host's existing
  authorized observation. Omit it when connection state is unknown. No transport,
  storage adapter, theme provider or new OAuth service is required.

[`Connections.tsx`](./Connections.tsx) is an installed-package example: Builder
and GTM supply two configurations to the same component. It uses only public
package imports, no repository-source aliases. A new app mounts one instance
with its own existing values. The two-app example does not authorize reading
another app's or customer's data.

## Report evidence, not guesses

| Host observation | Presentation | Required basis |
| --- | --- | --- |
| Omitted or `setup` | Connect to ChatGPT | Unknown; first look for an existing connection. |
| `checking` | Checking connection | The host is performing its existing read; the primary action is disabled. The component does not start that read. |
| `registered` | Use existing connection | An actual registered ID and its associated endpoint, known to the host for this account/workspace. |
| `connected` | Open ChatGPT | Existing authorized host evidence confirms access to the exact enrolled agent and conversation, in addition to registration. |
| `error` | Review in ChatGPT | The host could not confirm the connection. Raw OAuth/token error bodies are not accepted or reflected. |

The registration data shape is `{ connectionId, endpoint }`. A connected
observation also contains `enrollment`. The component refuses stale connected
display when **any** of enrollment ID, agent ID, workspace ID or thread ID differs,
and refuses a registration for another resource. These comparisons are display
safeguards, not authorization. The host still owns live user/workspace checks,
OAuth scopes, native profile/session continuity and all permission changes.

ID syntax is not proof of registration. In particular, the Agents kit's
`developer-supplied-unverified` result must not be mapped to `registered` or
`connected` without independent host evidence. Package generation, importing a
package, an anonymous discovery response, clicking a link, browser storage and
window messages must never promote the state. Replace a previous success with
`checking`/`error` while rechecking or after failure. Do not retain a success
across an account switch; the authenticated host must replace its props.

When there is no suitable read-side connection observation, leave this in setup
or registered state. This change intentionally does not build an observation
service or store to manufacture a green status.

## The supported ChatGPT path

Host guidance was checked against OpenAI's [connection and testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [packaging guide](https://developers.openai.com/plugins/build/plugins) on
**October 2, 2026**. The primary link is the documented Plugins destination, not
an invented per-app install URL. No native IDs are added to its URL or referrer.

Reuse a registered connection first. Otherwise, the current developer flow is
Settings → Security and login → Developer mode, then the plus action in Plugins
with the exact public MCP endpoint. Account/workspace policy can require an
administrator. Sign in and review permissions through the existing consent
flow. In a new conversation, select the connection from the tools menu.

Generating files is separate. The maintained
[Agents kit setup guide](https://github.com/tangle-network/chatgpt-plugins/blob/main/plugins/agents/SETUP.md)
from merged [source PR25](https://github.com/tangle-network/chatgpt-plugins/pull/25)
owns endpoint checking, accepting a **real** registered connection ID, package
generation and recovery. Keep using its reviewed installed release or tarball;
this module does not assume a new npm release. Complete plugin installation uses
the supported local marketplace/Plugins Directory path. Public submission and
review remain separate, owner-controlled operations. Secure MCP Tunnel is an
OpenAI development option documented upstream; this panel does not invent a
tunnel registration or bypass the app's existing public endpoint contract.

## Styling and accessibility

Use the app's existing Agent App stylesheet and Tailwind preset. The component
reuses published Brand/UI `Button`, `Input`, `cn` and `focusRing`, rather than
copying generic controls or changing theme tokens. It needs no new CSS file.
For Tailwind 4 hosts, include the package's runtime classes in the normal build:

```css
@import 'tailwindcss';
@config './tailwind.config.mjs';
@source './node_modules/@tangle-network/agent-app/dist';
@source './node_modules/@tangle-network/ui/dist';
```

```js
// tailwind.config.mjs — use the host's existing config when it already has this.
import preset from '@tangle-network/agent-app/tailwind-preset'
export default { presets: [preset] }
```

Import `@tangle-network/agent-app/styles` once in the app shell as usual. Theme
scope remains with the host; do not introduce another ThemeProvider or palette.
The public integrations entry retains its existing optional UI/Hub peer cohort;
this addition changes no dependency or peer floor.

Native links and details/summary support keyboard navigation. Landmarks include
the app name; generated IDs are unique across simultaneous instances. The
read-only endpoint selects its contents on focus without a clipboard permission.
Loading and errors are announced; disabled actions cannot submit a surrounding
form. Links disclose their new tab, omit the referrer, and never include agent
or workspace identifiers. Controls have a 44px minimum target, text can wrap,
and the component adds no animation beyond maintained controls' reduced-motion
behavior. Actual layout and keyboard proof must come from the browser check,
not these source descriptions.

## Validation and evidence

From a complete, clean checkout with the repository's pinned Node/pnpm:

```sh
nvm use
pnpm install --frozen-lockfile --ignore-scripts=false
node --experimental-strip-types --test tests/integrations-react/chatgpt-state.node.mjs
pnpm exec vitest run tests/integrations-react/chatgpt.test.tsx
node tests/integrations-react/packed-chatgpt-consumer.mjs /tmp/connect-chatgpt-proof-NEW
pnpm signoff --source head
```

Use a **new** evidence directory outside the checkout. The packed probe runs the
canonical build, packs once, installs outside the source tree with scripts
disabled, repeats a strict-peer frozen-lock install, and typechecks the two-app
consumer plus negative type cases. Consumer checking uses `strict: true` and
`skipLibCheck: true`; it is not package-wide declaration validation. Full
repository signoff remains the merge gate.

The probe bundles the actual installed export and public styles with the
existing build engines, then checks Chromium at 390px/1280px in light/dark:
keyboard activation without automatic connection, native disclosure and endpoint
selection, all states, stale scope, long names/URLs, control heights, no horizontal
overflow, theme differentiation, reduced-motion animation suppression, and no
unexpected external requests or browser errors. It writes real PNG captures and
a JSON report with commit/archive/lock/CSS hashes. Fixture data is explicitly
synthetic, and navigation is intercepted; none of this proves hosted registration.

The initial local evidence is in
[`projection-proof.json`](./projection-proof.json): 19 passing native Node
assertions, with failing identity, endpoint and false-connected mutations before
restoration. This is **source projection evidence only**, run on Node 22.16.0,
not the repository's Node 24 signoff. React/Vitest, package installation, full
typechecking, browser screenshots, docs generation and signoff were not run in
the delivery environment (no complete checkout/dependency access). Screenshot
paths from the capture script are not evidence until that script actually runs.

## Ownership and release

Only this presentation, its export, example, stories and focused validation are
added. Existing Hub consent/mutation surfaces, enrollment/runtime/auth, shared
phone, workspace UI, embedded ChatGPT task cards, Brand tokens, package versions,
lockfile and publishers are unchanged. No deployment, publication, hosted Codex
review, permission change or live message is part of this PR. Hosted adoption,
final review and merge remain with the app/release owner.
