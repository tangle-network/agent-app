import {
  AgentWorkspaceLayout,
  WorkspaceList,
  type AgentProductIdentity,
  type AgentWorkspaceNoun,
  type WorkspaceListItem,
} from '@tangle-network/agent-app/workspace-react'
import type { SessionSummary } from '@tangle-network/agent-app/session-shell'
import type { ComponentType, SVGProps } from 'react'

// The canonical shell under mock products. Query parameters pick the case so a
// screenshot script can walk every product × page × data shape:
//   /shell?product=legal&page=list|workspace&data=normal|worst|empty|one

type Icon = ComponentType<SVGProps<SVGSVGElement>>

function icon(path: string): Icon {
  return function ShellIcon({ className, ...props }) {
    return (
      <svg {...props} aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
        <path d={path} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
}

const NewIcon = icon('M12 5v14M5 12h14')
const HomeIcon = icon('M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z')
const FolderIcon = icon('M3.75 7.25h5l1.75 2h9.75v8.5a1 1 0 0 1-1 1h-14.5a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1Z')
const HistoryIcon = icon('M3.75 12a8.25 8.25 0 1 0 2.42-5.83M3.75 4.75v4.5h4.5M12 7.75v4.75l3 1.75')
const GridIcon = icon('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z')
const SettingsIcon = icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z')

function Knot() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-primary" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 4c4 0 4 16 12 16M18 4C14 4 14 20 6 20" strokeLinecap="round" />
    </svg>
  )
}

interface MockProduct {
  product: AgentProductIdentity
  noun: AgentWorkspaceNoun
  layout: 'list' | 'grid'
  nav: { id: string; label: string; icon: Icon; path: string }[]
  fields?: { id: string; label: string }[]
  emptyDescription: string
}

const PRODUCTS: Record<string, MockProduct> = {
  legal: {
    product: { name: 'Legal', mark: <Knot />, href: '/shell?product=legal&page=list' },
    noun: { singular: 'client', plural: 'clients' },
    layout: 'list',
    nav: [
      { id: 'new', label: 'New chat', icon: NewIcon, path: '/chat/new' },
      { id: 'work', label: 'Work', icon: HomeIcon, path: '/work' },
      { id: 'documents', label: 'Documents', icon: FolderIcon, path: '/documents' },
    ],
    fields: [{ id: 'matters', label: 'Open matters' }],
    emptyDescription: 'Each client keeps its own documents, deadlines, and conversations.',
  },
  tax: {
    product: { name: 'Tax', mark: <Knot />, href: '/shell?product=tax&page=list' },
    noun: { singular: 'client', plural: 'clients' },
    layout: 'list',
    nav: [
      { id: 'new', label: 'Ask the agent', icon: NewIcon, path: '/chat/new' },
      { id: 'return', label: 'Return', icon: HomeIcon, path: '/return' },
      { id: 'documents', label: 'Documents', icon: FolderIcon, path: '/documents' },
    ],
    fields: [{ id: 'year', label: 'Tax year' }, { id: 'status', label: 'Status' }],
    emptyDescription: 'Add a client to start their return.',
  },
  gtm: {
    product: { name: 'GTM', mark: <Knot />, href: '/shell?product=gtm&page=list' },
    noun: { singular: 'project', plural: 'projects' },
    layout: 'grid',
    nav: [
      { id: 'new', label: 'New chat', icon: NewIcon, path: '/chat/new' },
      { id: 'home', label: 'Home', icon: HomeIcon, path: '/home' },
      { id: 'vault', label: 'Vault', icon: FolderIcon, path: '/vault' },
    ],
    fields: [{ id: 'domain', label: 'Domain' }],
    emptyDescription: 'A project holds one company’s positioning, campaigns, and research.',
  },
}

const LONG = 'Synthetic profile verification 2026-09-11 for the Northern District consolidated matter'

function items(kind: string, product: string): WorkspaceListItem[] {
  const base = (id: string, name: string, extra: Partial<WorkspaceListItem> = {}): WorkspaceListItem => ({
    id,
    name,
    href: `/shell?product=${product}&page=workspace&data=${kind}`,
    updatedAt: '2026-09-27T12:00:00Z',
    ...extra,
  })
  if (kind === 'empty') return []
  if (kind === 'one') return [base('a', 'Acme Corporation', { description: 'acme.com', values: { matters: '3', year: '2025', status: 'In review', domain: 'acme.com' } })]
  if (kind === 'worst') {
    return [
      base('long', LONG, { description: `${LONG} — description that keeps going past any reasonable width`, values: { matters: '1,204', year: '2025', status: 'Waiting on documents from the client', domain: 'a-very-long-subdomain.example-company-name.co.uk' } }),
      base('dup', 'GTM Agent', { description: 'GTM Agent', values: { domain: 'tangle.tools' } }),
      base('one', 'X', { values: { matters: '0' } }),
      base('email', 'averyveryveryverylongunbrokenemailaddress@subdomain.example.com'),
      base('cjk', '株式会社タングル・ネットワーク東京本社', { description: 'نص عربي طويل للاختبار', updatedAt: '2024-01-03T00:00:00Z' }),
      base('emoji', '🚀 Launch 🚀 team 👩🏽‍💻', { updatedAt: null }),
      ...Array.from({ length: 8 }, (_, i) => base(`n${i}`, `Client ${i + 1}`, { values: { matters: String(i), year: '2025', status: 'Draft' } })),
    ]
  }
  return [
    base('a', 'Acme Corporation', { description: 'acme.com', values: { matters: '3', year: '2025', status: 'In review', domain: 'acme.com' } }),
    base('b', 'Globex', { description: 'Delaware C-corp', values: { matters: '1', year: '2025', status: 'Filed', domain: 'globex.io' } }),
    base('c', 'Initech LLC', { values: { matters: '0', year: '2024', status: 'Draft', domain: 'initech.dev' } }),
  ]
}

const SESSIONS: SessionSummary[] = [
  { id: 's1', title: LONG, updatedAt: '2026-09-27T12:00:00Z' },
  { id: 's2', title: 'California foreign qualification and annual report', updatedAt: '2026-09-26T12:00:00Z' },
]

export function ShellRoute() {
  const params = new URLSearchParams(window.location.search)
  const key = params.get('product') ?? 'legal'
  const mock = PRODUCTS[key] ?? PRODUCTS.legal!
  const page = params.get('page') ?? 'list'
  const data = params.get('data') ?? 'normal'
  const list = items(data, key)
  const listHref = mock.product.href
  const workspaceName = data === 'worst' ? LONG : 'Acme Corporation'
  const base = `/shell?product=${key}`

  if (page === 'list') {
    return (
      <AgentWorkspaceLayout
        product={mock.product}
        navItems={[
          { id: 'all', label: `All ${mock.noun.plural}`, icon: GridIcon, href: listHref },
          { id: 'settings', label: 'Settings', icon: SettingsIcon, href: `${base}&page=settings` },
        ]}
        activeId="all"
        user={{ name: 'Platform Deploy Smoke', email: 'smoke@tangle.tools' }}
        contentClassName="min-h-screen"
      >
        <WorkspaceList
          items={list}
          noun={mock.noun}
          layout={params.get('layout') === 'list' ? 'list' : params.get('layout') === 'grid' ? 'grid' : mock.layout}
          fields={mock.fields}
          create={{ href: `${base}&page=new` }}
          empty={{ description: mock.emptyDescription }}
          rename={async () => {}}
          remove={async () => {
            throw new Error('Deleting is disabled in the playground.')
          }}
        />
      </AgentWorkspaceLayout>
    )
  }

  return (
    <AgentWorkspaceLayout
      product={mock.product}
      workspace={{
        id: data === 'worst' ? 'long' : 'a',
        name: workspaceName,
        noun: mock.noun,
        options: data === 'one' ? undefined : list.length ? list.map(({ id, name }) => ({ id, name })) : [{ id: 'a', name: workspaceName }],
        hrefForWorkspace: (id) => `${base}&page=workspace&data=${data}&ws=${id}`,
        listHref: data === 'one' ? undefined : listHref,
        createHref: data === 'one' ? undefined : `${base}&page=new`,
      }}
      navItems={mock.nav.map((item) => ({ id: item.id, label: item.label, icon: item.icon, href: `${base}&page=workspace&at=${item.path}` }))}
      activeId={mock.nav[1]?.id}
      sessions={{
        icon: HistoryIcon,
        href: `${base}&page=history`,
        hrefForSession: (id) => `${base}&page=workspace&session=${id}`,
        sessions: SESSIONS,
      }}
      user={{ name: 'Platform Deploy Smoke', email: 'smoke@tangle.tools' }}
      contentClassName="min-h-screen"
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">The product’s own home content renders here.</p>
      </div>
    </AgentWorkspaceLayout>
  )
}
