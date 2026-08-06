# Default agent workspace

Chat-first products should start with the shared workspace composition instead
of creating a product-local sidebar.

The browser reference is [desktop](../docs/assets/default-workspace/desktop.png)
and [mobile](../docs/assets/default-workspace/mobile.png).

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
Products that need mobile navigation should add their compact header or menu
around the shared content; that surface needs the product's brand and route
context.

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
      {/* The standard rail is hidden below `lg`; override when mobile navigation
          is a deliberate part of the product shell. */}
      hideBelow="lg"
    >
      {data.children}
    </AgentWorkspaceLayout>
  )
}
```

Pair the layout with `EntryComposer` from
`@tangle-network/agent-app/chat-react` on the new-session route and
`SessionHistoryPanel` from `@tangle-network/agent-app/web-react` on the full
history route.

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
renders its own picker (the `modes` dock or a settings surface).

Omit an unavailable capability and its control stays hidden; do not pass a
placeholder URL, empty catalog, or inert callback just to make the row look
complete.

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

```tsx
import {
  EntryComposer,
  type ComposerPlanModeSelection,
} from '@tangle-network/agent-app/chat-react'

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

Use `ChatMessages` and the shared `AgentComposer` for an existing session,
keeping domain cards and context in the product.

Do not add a second History panel for a chat-first product.

Workflow-first and queue-first products may omit `sessions` when a persistent
thread rail would obscure their primary job.
