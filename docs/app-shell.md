# One app shell for every product

Every Tangle agent product wears the same shell. The rail's top line, the workspace switcher, the listing page, and the destructive-action pattern come from `@tangle-network/agent-app/workspace-react`. A product configures only these:

| Product supplies | Example |
| --- | --- |
| `product.name`, `product.mark`, `product.href` | `Legal`, `<Logo variant="icon" />`, `/app` |
| the workspace noun | `{ singular: 'client', plural: 'clients' }` |
| its rail destinations | Work, Documents, Company |
| listing fields and layout | `fields: [{ id: 'year', label: 'Tax year' }]`, `layout: 'list'` |
| home content | the product's own dashboard inside the workspace |
| accent | the product's `--brand-primary` / `--primary` token |

Everything else is shared. Do not hand-build a `logo` plus `railHeaderContent` pair, a top bar, a listing page, an initial avatar, or a delete confirmation.

## The rail top

```tsx
<AgentWorkspaceLayout
  product={{ name: 'Legal', mark: <Logo variant="icon" size="sm" />, href: '/app' }}
  workspace={{
    id: client.id,
    name: client.name,
    noun: { singular: 'client', plural: 'clients' },
    options: clients,                         // every client this person can open
    hrefForWorkspace: (id) => `/app/${id}/work`,
    listHref: '/app',                         // adds "All clients"
    createHref: '/app/new',                   // adds "New client"
  }}
  navItems={workspaceNavItems(base)}
  sessions={workspaceSessionConfig(...)}
  LinkComponent={Link}
>
```

The mark sits in the rail's brand slot and becomes the expand control when the rail collapses. Beside it, the identity shows two lines: the workspace name, then the product name. Both truncate inside the rail and keep the full text as a tooltip. A long client name cannot run into the collapse button or the page. It is a switcher only when there is somewhere to go. A workspace with no other options, no listing and no create route renders as plain text, not as a one-item menu.

Below the rail breakpoint the same identity heads the mobile bar and the navigation drawer, with the mark included, so no product adds a second mobile strip.

## The listing

Render the listing inside the same layout with no `workspace`, so it has the same rail as the workspace it opens:

```tsx
<AgentWorkspaceLayout
  product={product}
  navItems={[{ id: 'all', label: 'All clients', icon: LayoutGrid, href: '/app' }]}
  activeId="all"
  LinkComponent={Link}
>
  <WorkspaceList
    noun={{ singular: 'client', plural: 'clients' }}
    items={clients.map((c) => ({
      id: c.id,
      name: c.name,
      href: `/app/${c.id}/work`,
      description: c.summary,
      updatedAt: c.lastActivityAt,
      values: { year: c.taxYear, status: <StatusPill state={c.state} /> },
    }))}
    fields={[{ id: 'year', label: 'Tax year' }, { id: 'status', label: 'Status' }]}
    create={{ href: '/app/new' }}
    empty={{ description: 'Each client keeps its own documents, deadlines, and conversations.' }}
    rename={(item, name) => renameWorkspace(item.id, name)}
    remove={(item) => deleteWorkspace(item.id)}
    LinkComponent={Link}
  />
</AgentWorkspaceLayout>
```

The listing's rules are built in:

- One title and one primary action. The title is the plural noun unless `title` overrides it.
- No counting copy. Totals and per-item counts belong in `fields` only when the user compares them.
- A `description` that repeats the name is dropped.
- Rename, delete and product actions live in each item's overflow menu. Delete always asks for confirmation, and a refusal shows its message inside the dialog. No row carries a red icon.
- The listing offers search past eight items. A search with no matches says so and offers to clear it.
- The empty state names the noun and offers the same create action.
- Use `layout: 'list'` for records people compare, such as clients, matters and returns, with `fields` as aligned columns. Use `layout: 'grid'` for a handful of rich projects. The grid card carries the product accent.

## Home

A workspace's first destination is the product's own home content (for example, Relationships' Home: a decision queue, movement and recent evidence). Compose it from `PageShell`, `PageHeader` and `MetricStrip` in `@tangle-network/ui/primitives` inside the layout, as [product surfaces](./product-surfaces.md#operational-pages) describes. The shell owns the frame around it. The product owns what it says.

## Migrating a product

1. Pass `product` (and `workspace` inside a workspace) to `AgentWorkspaceLayout`. Delete the product's `logo`, `railHeaderContent`, `ClientSwitcher`/`WorkspaceSelector`, and any `lg:hidden` mobile brand strip.
2. Replace the listing route's markup with `WorkspaceList` inside the layout. Delete the local top bar, avatar helpers, delete dialog and counting copy.
3. Keep the product's loader, routes and mutations. `WorkspaceList` takes them as `create`, `rename` and `remove`. A product that creates from a name alone passes `create.onCreate(name)` and navigates from inside it; a richer creation flow keeps its own dialog behind `create.onSelect` or route behind `create.href`.
4. Check 1440×1000 and 390×844 with an 80-character workspace name, one item, many items and none. The playground route `/shell?product=legal&page=workspace&data=worst` shows the target.
