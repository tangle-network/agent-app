# Default agent workspace

Chat-first products should start with the shared workspace composition instead
of creating a product-local sidebar.

## Generated starter

The maintained `create-agent-app --chat` template now assembles this layout in
React. See [the scaffold walkthrough](../create-agent-app/README.md) and
[packed consumer proof](../create-agent-app/proof/README.md). Check the selected
published version: source in this checkout does not prove that a registry
release already includes the template.

The starter imports `AgentWorkspaceLayout`, `SessionHistoryPanel`, `ChatMessages`,
and `ChatComposer` through public package paths. It builds standalone browser
assets with the public Tailwind preset and both maintained stylesheets, scanning
installed package distributions rather than repository source. It uses real
same-origin auth, History navigation, and `/?threadId=...` links.

The starter's existing upload API returns inline/sandbox parts. It therefore
uses `ChatComposer.onSendParts`, not `EntryComposer.uploadUrl`, whose upload
contract is for store-backed attachments. Do not change server/storage behavior
to make a UI example fit. Capability controls without real server data remain
absent. No new primitive family or transcript header is required.

## Reference composition

The browser reference is [desktop](../docs/assets/default-workspace/desktop.png)
and [mobile](../docs/assets/default-workspace/mobile.png).
These are the existing reference composition, not screenshots from a generated
consumer run. The packed proof captures its own desktop and mobile evidence.

`AgentWorkspaceLayout` owns the repeated visual and session behavior:

- the standard `SidebarLayout` from `sandbox-ui`;
- the expandable History row;
- the capped rail session list;
- optimistic sessions and unread state;
- active navigation resolution; and
- the product's existing rename, delete, pin, or category actions.

The product still owns its navigation taxonomy, route URLs, session queries,
authentication, and domain content.

The fixed rail is hidden below `lg` so it cannot cover a mobile composer.
The shared shell supplies the mobile header, navigation drawer, and account menu.
Pass product branding and routes through its existing props.
Do not add another mobile navigation bar or a second header inset.

```tsx
import { CirclePlus, FolderOpen, History } from 'lucide-react'
import { AgentWorkspaceLayout } from '@tangle-network/agent-app/workspace-react'

const navItems = [
  { id: 'new', icon: CirclePlus, label: 'New', path: '/chat/new' },
  { id: 'vault', icon: FolderOpen, label: 'Vault', path: '/vault' },
]

export function Workspace({ data, pathname, base, activeSessionId }) {
  return (
    <AgentWorkspaceLayout
      navItems={navItems.map((item) => ({
        ...item,
        href: `${base}${item.path}`,
      }))}
      sessions={{
        icon: History,
        href: `${base}/history`,
        hrefForSession: (id) => `${base}/chat/${id}`,
        sessions: data.sessions,
        totalCount: data.sessionCount,
        activeSessionId,
        respondingSessionIds: data.respondingSessionIds,
        actions: data.sessionActions,
      }}
      activeRoute={{
        pathname,
        base,
        routes: navItems,
        claimsNothing: ['/chat'],
      }}
      logo={data.logo}
      logoHref={base}
      user={data.user}
      onLogout={data.signOut}
      hideBelow="lg"
    >
      {data.children}
    </AgentWorkspaceLayout>
  )
}
```

To show agent-built applications in the rail, pass authorized records through the optional `apps` prop.
See [workspace apps](./workspace-apps.md) for the publish and preview flow.

Pair the layout with `EntryComposer` from
`@tangle-network/agent-app/web-react` on the new-session route and
`SessionHistoryPanel` from `@tangle-network/agent-app/web-react` on the full
history route.

For a lazy route, place `RouteChunkBoundary` outside its `Suspense` fallback.
A stale chunk leaves a visible Reload action instead of an empty page.
Reload requests a fresh document URL so a browser does not reuse the old shell.
The boundary retries automatically at most once in 60 seconds when `autoReloadOnChunkError` is set.
Set that prop only when a full page reload cannot discard unsaved work.

```tsx
import { Suspense, lazy } from 'react'
import { RouteChunkBoundary } from '@tangle-network/agent-app/web-react'

const AppsRoute = lazy(() => import('./AppsRoute'))

<RouteChunkBoundary>
  <Suspense fallback={<p>Loading apps…</p>}>
    <AppsRoute />
  </Suspense>
</RouteChunkBoundary>
```

## Composer capability contract

`EntryComposer` is capability-driven: a control appears only when the product
passes the real data and callback that makes it work.

| Product capability | `EntryComposer` input |
| --- | --- |
| Selectable agent backend | `agent.harness` + `agent.onHarnessChange` (`agent.availableHarnesses` to restrict) |
| Selectable model catalog | `agent.models` + `agent.model` + `agent.onModelChange` (canonical ids) |
| Thinking effort | `agent.effort` + `agent.onEffortChange` |
| Plan-approval mode | `planMode`, only when the selected backend supports it |
| File upload | `uploadUrl`, only when the endpoint accepts the shared attachment contract |
| `@` file mentions | `mentions`, only when a real file index exists |
| Product-specific behavior | `modes` |

`agent` is the canonical `AgentSessionControlsProps` from
`@tangle-network/agent-app/web-react` — the entry composer renders the
canonical `AgentSessionControls` cluster, nothing else. Named-profile picking
is deliberately NOT part of that cluster: a product that offers profiles
renders its own picker beside the composer or on a settings surface — not in
the `modes` dock, where a mode is an on/off switch, not a value picker.

An unavailable capability hides at the granularity the canon gives you: omit
`agent` and the whole row stays hidden; `agent.showHarness={false}` drops the
backend control; the effort pill hides itself when the selected model does not
support reasoning. Do not pass a placeholder URL, empty catalog, or inert
callback just to make the row look complete.

A product-owned profile picker consumes a safe display catalog: a stable `id`,
`name`, description, capability labels, and `builtin` status.
It is not the full runtime `AgentProfile`, and the browser's catalog is never
authority for prompts, tools, permissions, connections, or backend access.
The product resolves the selected id server-side to the actual prompt, model
hints, backend preference, tools, permissions, MCP/integration grants,
resources/skills, subagents, modes, hooks, and confidentiality policy before
creating or continuing a session.
Profile authoring belongs in a settings/profile surface; the composer only
chooses the active profile for this turn.
Use AgentProfileEditor from @tangle-network/agent-app/web-react on that
settings surface.
Pass the complete AgentProfile as its controlled value and persist on Save.
Its onChange callback returns a canonical schema-validated profile.
The product still checks the profile and the caller's authority server-side.
The editor keeps fields without a dedicated control in Advanced JSON instead of
discarding them.
See the rendered editor at docs/assets/profile-editor/complete.png.


```tsx
import {
  EntryComposer,
  type ComposerPlanModeSelection,
} from '@tangle-network/agent-app/web-react'

<EntryComposer
  heading="What do you want to work on?"
  agent={{
    models: data.models,
    model: data.model,
    onModelChange: data.setModel,
    harness: data.harness,
    onHarnessChange: data.setHarness,
    effort: data.effort,
    onEffortChange: data.setEffort,
  }}
  planMode={data.planMode as ComposerPlanModeSelection | undefined}
  uploadUrl={data.uploadUrl}
  mentions={data.mentions}
  modes={data.modes}
  onSubmit={send}
/>
```

Use `ChatMessages` and the shared `ChatComposer` for an existing session,
keeping domain cards and context in the product.

The transcript fills the main column from its top edge.
Do not reserve a title row, prompt strip, or repeated session heading above it.
Keep session titles in History and the browser document title.
Place optional navigation, sharing, and thread actions in a floating overlay.
Show each action only when its real callback exists.
Keep the overlay outside document flow and allow pointer events through its empty area.
Inset transcript content where floating controls could cover the first message.
Do not add placeholder actions or a fabricated connection indicator.
Show execution status from observed runtime events inside the conversation.

## Integration settings

Use `IntegrationsPanel` and `useIntegrations` from `@tangle-network/sandbox-ui/integrations` for the integration catalog.
The shared panel owns provider logos, search, sorting, connection controls, and disconnect confirmation.
Products supply authorized catalog data, connections, and real connect and disconnect callbacks.
Use the shared `ProviderIcon` for product-specific connection rows.
Keep workspace ownership, access checks, and connection bindings in the product.
Do not copy the catalog grid or logo resolution into an agent app.

Do not add a second History panel for a chat-first product.

Workflow-first and queue-first products may omit `sessions` when a persistent
thread rail would obscure their primary job.


## Files and companion tools

Use `AgentWorkspaceCompanion` for tools beside the conversation.
The `tools` prop supplies the default order, names, icons, and panel lifecycle.
Files comes first; omitted capabilities have no tab and never mount.
Visited tools remain mounted through tab switches, pane closure, and responsive changes.
Use the supplied `active` flag to pause background work without losing local state.
A terminal should connect only through the product's explicit connection policy.

```tsx
import { AgentWorkspaceCompanion } from '@tangle-network/agent-app/workspace-react'

<AgentWorkspaceCompanion
  persistenceKey={`workspace:${workspaceId}`}
  tools={{
    files: () => <WorkspaceFiles />,
    agent: () => <AgentSettings />,
    terminal: canUseTerminal
      ? ({ active }) => <WorkspaceTerminal active={active} />
      : undefined,
  }}
>
  <Conversation />
</AgentWorkspaceCompanion>
```

`createAgentWorkspaceCompanionTabs(tools)` exposes the same defaults when custom tabs are necessary.
Use `navigation` for an optional session rail within the same responsive layout.
Products retain data loading, permissions, file previews, agent settings, and terminal connection policy.
Do not nest another workspace layout to add the rail.
