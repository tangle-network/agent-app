# Session shell — adopt it, don't copy it

The shell around the chat surface: past sessions in the rail, an entry point for a new one, and a paged history view behind it.

For a standard chat-first workspace, use
`AgentWorkspaceLayout` from `@tangle-network/agent-app/workspace-react`.
The complete starting pattern is in [default-workspace.md](./default-workspace.md).

This lives here because four products each built it by hand and drifted. The rule for adopting it is the point of the whole exercise: **install the package and pass your data in.** Copying these snippets into a fourth `workspace-sidebar.tsx` recreates exactly the problem this replaced.

The lower-level APIs below are for products that need a custom outer layout or a
nonstandard panel arrangement.

Two entries, split on what a route **loader** can import:

| entry | holds | runs where |
| --- | --- | --- |
| `@tangle-network/agent-app/session-shell` | nav items, route resolution, list composition, unread overlay, rail cookie | anywhere — no React, no imports, safe in a Worker loader |
| `@tangle-network/agent-app/web-react` | `SessionHistoryPanel`, `useSessionHistory`, `useSessionActions`, `useInfiniteScroll` | the browser |

## What stays yours

Your nav taxonomy (Vault / Board / Studio, or Entities / Planning / Signatures) is **domain** — the shell never sees it. So is your storage, your routes, and your auth. The shell owns sessions and nothing else.

## 1. The layout: sessions in the rail

`AgentWorkspaceLayout` uses `SidebarLayout` from `@tangle-network/sandbox-ui` and
builds the one nav row that holds sessions.
The product supplies its own rows through `navItems`.

```tsx
import { History, CirclePlus, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { SidebarLayout } from '@tangle-network/sandbox-ui/dashboard'
import {
  activeSessionIdFromPath,
  buildSessionNavItem,
  composeSidebarSessions,
  readRailCollapsedCookie,
  railCollapsedCookie,
  resolveActiveNavId,
} from '@tangle-network/agent-app/session-shell'

const RAIL_LIMIT = 20

// Your rows, in any order. The shell only reads `path` for highlighting.
const NAV = [
  { id: 'new', icon: CirclePlus, label: 'New', path: '/chat/new' },
  { id: 'vault', icon: FolderOpen, label: 'Vault', path: '/vault' },
]

export async function loader({ request, params }) {
  const rows = await listSessions(params.workspaceId, RAIL_LIMIT) // your query
  return {
    rows,
    total: await countSessions(params.workspaceId),
    // No React in this module, so the loader can read the persisted rail state
    // and the first paint matches what the user left.
    railCollapsed: readRailCollapsedCookie(request.headers.get('cookie'), 'my-app-rail'),
  }
}

export default function WorkspaceLayout({ loaderData }) {
  const { pathname } = useLocation()
  const base = `/app/${useParams().workspaceId}`
  const currentSessionId = activeSessionIdFromPath({ pathname, base })

  // `respondingIds` / `liveUnreadIds` come from whatever live channel you
  // already have; omit them and the rows are simply static.
  const { sessions, hasMore } = composeSidebarSessions({
    loaderSessions: loaderData.rows.map(toSessionSummary), // your row -> {id,title,updatedAt}
    optimisticSessions: createdInAnotherTab,
    limit: RAIL_LIMIT,
    totalCount: loaderData.total,
    liveUnreadIds,
    locallyReadIds,
    currentSessionId,
  })

  const sessionActions = useSessionActions({ /* see §3 */ })

  return (
    <SidebarLayout
      navItems={[
        ...NAV.map((n) => ({ ...n, href: `${base}${n.path}` })),
        buildSessionNavItem({
          icon: History,
          label: 'History',
          href: `${base}/history`,
          sessions,
          hrefForSession: (id) => `${base}/chat/${id}`,
          activeSessionId: currentSessionId,
          respondingSessionIds: respondingIds,
          // Only rendered when the list is capped — the full list is on /history.
          overflow: hasMore ? { href: `${base}/history` } : undefined,
          actions: {
            canEdit: role !== 'viewer',
            renameIcon: Pencil,
            deleteIcon: Trash2,
            onRename: sessionActions.openRename,
            onDelete: sessionActions.openDelete,
          },
        }),
      ]}
      activeId={resolveActiveNavId({
        pathname,
        base,
        routes: NAV,
        // An open chat highlights nothing; /chat/new still highlights "New",
        // because resolution is longest-prefix, not first-match.
        claimsNothing: ['/chat'],
      })}
      railCollapsed={railCollapsed}
      onRailCollapsedChange={(c) => {
        setRailCollapsed(c)
        document.cookie = railCollapsedCookie(c, { name: 'my-app-rail' })
      }}
    >
      <Outlet />
      {sessionActions.dialogs}
    </SidebarLayout>
  )
}
```

`buildSessionNavItem` returns a plain object that is structurally a sandbox-ui `SidebarLayoutNavItem` — no import, no adapter. `icon` is required, because sandbox-ui renders it unguarded.

## 2. The history route

The rail is capped on purpose. `/history` is where the rest lives, and it needs a data port rather than a storage assumption.

```tsx
import { SessionHistoryPanel, useSessionHistory } from '@tangle-network/agent-app/web-react'

export default function History({ loaderData }) {
  const [query, setQuery] = useState('')
  // Defer the term that drives fetching so fast typing coalesces into one
  // request; the hook's abort + stale-response guard does the rest.
  const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState('newest')

  const history = useSessionHistory({
    q: deferredQuery.trim(),
    sort,
    initialPage: loaderData.firstPage, // SSR page 1 — the default view costs no request
    fetchPage: async ({ q, sort, cursor, signal }) => {
      const params = new URLSearchParams({ sort })
      if (q) params.set('q', q)
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`/api/sessions?${params}`, { signal })
      if (!res.ok) throw new Error(`History request failed (${res.status})`)
      return res.json() // { items: SessionSummary[], nextCursor?: string | null }
    },
  })

  return (
    <SessionHistoryPanel
      history={history}
      hasAnySessions={loaderData.firstPage.items.length > 0}
      query={query}
      onQueryChange={setQuery}
      sort={sort}
      onSortChange={setSort}
      hrefForSession={(id) => `/app/${workspaceId}/chat/${id}`}
      linkComponent={Link}          // your router's Link; defaults to a plain <a>
      newSessionHref={`/app/${workspaceId}/chat/new`}
      respondingSessionIds={respondingIds}
      onRename={sessionActions.openRename}
      onDelete={sessionActions.openDelete}
    />
  )
}
```

`initialPage` is keyed on its **contents**, not its identity, so rebuilding it on every render is safe — it will not discard pages the reader already scrolled to.

Omit `onRename`/`onDelete` and the row menu disappears entirely; that is how a read-only viewer is expressed.

## 3. Rename and delete, once

Both the rail kebab and the history row drive the same hook, so there is exactly one confirm dialog in the product.

```tsx
const sessionActions = useSessionActions({
  renameSession: (id, title) => api.sessions.rename(id, title), // reject to show the error
  deleteSession: (id) => api.sessions.delete(id),
  currentSessionId,
  onChanged: () => revalidator.revalidate(),
  onDeletedCurrent: () => navigate(`/app/${workspaceId}/chat/new`, { replace: true }),
  notify: (level, message) => toast[level](message),
  labels: { deleteTitle: 'Close matter?' }, // every string is overridable
})
```

Render `sessionActions.dialogs` in the **layout**, not the page, so it survives navigation.

## Route shapes that are not `/chat/:id`

Sessions do not have to live under a segment. When they sit directly under the base, name the sibling routes — otherwise `/app/settings` is indistinguishable from a session called `settings`, and the rail will highlight and prefetch a session that does not exist.

```ts
const RESERVED = ['/entities', '/planning', '/reviews', '/settings', '/billing']

activeSessionIdFromPath({ pathname: '/app/s1',       base: '/app', segment: '', reserved: RESERVED }) // 's1'
activeSessionIdFromPath({ pathname: '/app/settings', base: '/app', segment: '', reserved: RESERVED }) // null
activeSessionIdFromPath({ pathname: '/app/settings', base: '/app', segment: '' })                     // 'settings' — the bug
```

A custom segment works the same way: `segment: 'matters'` resolves `/app/ws_1/matters/m_1`.

## Mapping your row

The shell reads three fields. Everything else is passthrough.

```ts
// gtm / legal: threads
({ id, title, updatedAt: updatedAt.toISOString(), category, isPinned, unread: unread === 1 })
// creative: only createdAt exists
({ id, title, updatedAt: createdAt.toISOString() })
// tax: the column is `name`
({ id, title: name, updatedAt: updatedAt.toISOString(), category: String(taxYear) })
```

`title` may be `null` or blank — it renders as `untitledLabel` rather than an unaimable empty row. `updatedAt` may be `null`.

## Styling

```ts
import '@tangle-network/agent-app/styles'
import agentAppPreset from '@tangle-network/agent-app/tailwind-preset'
```

The panel renders on the shared design tokens and pulls in no `@tangle-network/sandbox-ui` — that peer stays optional for everything on `/web-react`.
