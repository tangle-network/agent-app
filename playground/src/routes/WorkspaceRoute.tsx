import { AgentWorkspaceLayout } from '@tangle-network/agent-app/workspace-react'
import { EntryComposer } from '@tangle-network/agent-app/chat-react'
import type { CatalogModel } from '@tangle-network/agent-app/web-react'
import type { Harness } from '@tangle-network/agent-app/harness'
import { useState, type ComponentType, type SVGProps } from 'react'
import type { SessionSummary } from '@tangle-network/agent-app/session-shell'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

function icon(path: string): Icon {
  return function WorkspaceIcon({ className, ...props }) {
    return (
      <svg
        {...props}
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d={path} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
}

const NewIcon = icon('M12 5v14M5 12h14')
const FolderIcon = icon('M3.75 7.25h5l1.75 2h9.75v8.5a1 1 0 0 1-1 1h-14.5a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1ZM3.75 7.25v-1a1 1 0 0 1 1-1h4l1.5 2h7.5a1 1 0 0 1 1 1v1')
const HistoryIcon = icon('M3.75 12a8.25 8.25 0 1 0 2.42-5.83M3.75 4.75v4.5h4.5M12 7.75v4.75l3 1.75')

const sessions: SessionSummary[] = [
  { id: 'launch-plan', title: 'Launch plan for the new workspace', updatedAt: '2026-08-01T12:00:00.000Z' },
  { id: 'customer-brief', title: 'Customer brief and next steps', updatedAt: '2026-08-01T11:30:00.000Z', unread: true },
  { id: 'pricing-review', title: 'Pricing review', updatedAt: '2026-07-31T16:00:00.000Z' },
]

const models: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextLength: 200_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextLength: 200_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: false,
  },
]

export function WorkspaceRoute() {
  const [model, setModel] = useState('anthropic/claude-opus-4-8')
  const [harness, setHarness] = useState<Harness>('claude-code')
  const [effort, setEffort] = useState('medium')
  const [planMode, setPlanMode] = useState(false)

  const navItems = [
    { id: 'new', label: 'New', icon: NewIcon, href: '/workspace/chat/new', variant: 'primary' as const },
    { id: 'vault', label: 'Vault', icon: FolderIcon, href: '/workspace/vault' },
  ]

  return (
    <AgentWorkspaceLayout
      navItems={navItems}
      sessions={{
        icon: HistoryIcon,
        href: '/workspace/history',
        hrefForSession: (id) => `/workspace/chat/${id}`,
        sessions,
        totalCount: 4,
        activeSessionId: null,
      }}
      activeRoute={{
        pathname: '/workspace/chat/new',
        base: '/workspace',
        routes: [
          { id: 'new', path: '/chat/new' },
          { id: 'vault', path: '/vault' },
        ],
      }}
      logo={<span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">A</span>}
      logoHref="/workspace/chat/new"
      defaultRailCollapsed={false}
      contentClassName="h-screen"
    >
      <EntryComposer
        heading="What can we work on?"
        subheading="Start a conversation, review a document, or turn an idea into a plan."
        placeholder="Ask the agent anything…"
        onSubmit={() => {}}
        agent={{
          models,
          model,
          onModelChange: setModel,
          harness,
          onHarnessChange: setHarness,
          availableHarnesses: ['claude-code', 'opencode', 'codex'],
          effort,
          onEffortChange: setEffort,
        }}
        planMode={{ enabled: planMode, setEnabled: setPlanMode }}
        footer={<p className="text-center text-xs text-muted-foreground">Your workspace keeps every conversation in History.</p>}
      />
    </AgentWorkspaceLayout>
  )
}
