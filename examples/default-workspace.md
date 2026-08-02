# Default agent workspace

Chat-first products should start with the shared workspace composition instead
of creating a product-local sidebar.

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

Use `ChatMessages` and the shared `AgentComposer` for an existing session,
keeping domain cards and context in the product.

Do not add a second History panel for a chat-first product.

Workflow-first and queue-first products may omit `sessions` when a persistent
thread rail would obscure their primary job.
