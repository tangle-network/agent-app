/**
 * App-shell composition pieces for the app-shell stories. The package ships NO
 * generic app-shell component on purpose — a product composes its own shell
 * from package primitives (`ChatMessages`, `ChatComposer`, `../../brand`) plus
 * its own sidebar. These are the story-local building blocks for that
 * composition: a session sidebar (recency sections, active item, status
 * affordances, new-chat button), a thread header, and the `AppShell` layout
 * that wires them together with a mobile drawer below `md`.
 *
 * Everything is Tailwind over the shared tokens (`bg-card`, `border-border`,
 * `text-muted-foreground`, `bg-primary`, …) so the global theme toolbar
 * restyles it, exactly like the `web-react` styling contract.
 */
import { useState, type ReactNode } from 'react'
import {
  ChevronsUpDown,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SquarePen,
} from 'lucide-react'
import { TangleKnot } from '../../brand'

// ── data shapes ───────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'approval'

interface ShellSession {
  id: string
  title: string
  /** `running` shows a spinner, `approval` an amber dot — the two states a
   *  background agent session can be in while you're looking at another one. */
  status?: SessionStatus
}

export interface ShellSessionSection {
  id: string
  label: string
  sessions: ShellSession[]
}

interface ShellUser {
  name: string
  email: string
}

// ── small pieces ──────────────────────────────────────────────────────────────

const iconButtonClass =
  'rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function StatusAffordance({ status }: { status?: SessionStatus }) {
  if (status === 'running')
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label="Turn in progress" />
  if (status === 'approval')
    return <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-label="Awaiting approval" />
  return null
}

// ── sidebar ───────────────────────────────────────────────────────────────────

export interface AppSidebarProps {
  sections: ShellSessionSection[]
  activeId?: string | null
  /** Rail mode: icons only, 52px. */
  collapsed?: boolean
  /** Row rhythm: `comfortable` is the default reading density, `compact` the
   *  power-user density for long histories. */
  density?: 'comfortable' | 'compact'
  pendingApprovals?: number
  user?: ShellUser | null
  onNewChat?: () => void
  onSelectSession?: (id: string) => void
  onToggleCollapse?: () => void
  onOpenApprovals?: () => void
  onOpenSettings?: () => void
  onOpenAccount?: () => void
  className?: string
}

function SessionRow({
  session,
  active,
  density,
  onSelect,
}: {
  session: ShellSession
  active: boolean
  density: 'comfortable' | 'compact'
  onSelect?: (id: string) => void
}) {
  const rhythm = density === 'compact' ? 'px-2 py-1 text-[13px]' : 'px-2.5 py-[7px] text-sm'
  return (
    <button
      type="button"
      onClick={() => onSelect?.(session.id)}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2 rounded-md text-left transition ${rhythm} ${
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <StatusAffordance status={session.status} />
    </button>
  )
}

function CollapsedRail(props: AppSidebarProps) {
  const { sections, activeId, pendingApprovals = 0, user, onNewChat, onSelectSession, onToggleCollapse, onOpenApprovals, onOpenAccount, className } = props
  const recent = sections.flatMap((s) => s.sessions).slice(0, 6)
  return (
    <aside className={`flex h-full w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2 ${className ?? ''}`}>
      <span className="flex h-8 w-8 items-center justify-center">
        <TangleKnot size={20} />
      </span>
      <button type="button" onClick={onToggleCollapse} aria-label="Expand sidebar" className={iconButtonClass}>
        <PanelLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onNewChat}
        aria-label="New chat"
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SquarePen className="h-4 w-4" />
      </button>
      <div className="mt-1 flex w-full flex-col items-center gap-0.5 overflow-y-auto">
        {recent.map((s) => (
          <button
            key={s.id}
            type="button"
            title={s.title}
            aria-current={s.id === activeId ? 'page' : undefined}
            onClick={() => onSelectSession?.(s.id)}
            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
              s.id === activeId
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <MessageSquare className="h-4 w-4" />
            {s.status === 'running' && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
            {s.status === 'approval' && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" />}
          </button>
        ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        <button type="button" onClick={onOpenApprovals} aria-label="Approvals" className={`relative ${iconButtonClass}`}>
          <ShieldCheck className="h-4 w-4" />
          {pendingApprovals > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning" />}
        </button>
        {user && (
          <button
            type="button"
            onClick={onOpenAccount}
            aria-label={user.name}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary transition hover:bg-primary/25"
          >
            {initialsOf(user.name)}
          </button>
        )}
      </div>
    </aside>
  )
}

export function AppSidebar(props: AppSidebarProps) {
  const {
    sections,
    activeId,
    collapsed = false,
    density = 'comfortable',
    pendingApprovals = 0,
    user,
    onNewChat,
    onSelectSession,
    onToggleCollapse,
    onOpenApprovals,
    onOpenSettings,
    onOpenAccount,
    className,
  } = props

  if (collapsed) return <CollapsedRail {...props} />

  return (
    <aside className={`flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-card ${className ?? ''}`}>
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <TangleKnot size={22} className="shrink-0" />
        <span className="text-sm font-semibold text-foreground">Agent</span>
        <button type="button" onClick={onToggleCollapse} aria-label="Collapse sidebar" className={`ml-auto ${iconButtonClass}`}>
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-lg bg-primary px-2.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SquarePen className="h-4 w-4" />
          New chat
          <kbd className="ml-auto rounded border border-primary-foreground/25 px-1 py-px text-[10px] font-normal opacity-80">⌘N</kbd>
        </button>
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-[7px] text-muted-foreground">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-[13px]">Search chats…</span>
          <kbd className="ml-auto rounded border border-border bg-card px-1 py-px text-[10px]">⌘K</kbd>
        </div>
      </div>

      <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-2" aria-label="Chat sessions">
        {sections.map((section) => (
          <div key={section.id} className="pt-3">
            <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
              {section.label}
            </p>
            <div className="flex flex-col gap-px">
              {section.sessions.map((s) => (
                <SessionRow key={s.id} session={s} active={s.id === activeId} density={density} onSelect={onSelectSession} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={onOpenApprovals}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Approvals</span>
          {pendingApprovals > 0 && (
            <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-warning">
              {pendingApprovals}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Settings</span>
        </button>
      </div>

      {user && (
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={onOpenAccount}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition hover:bg-accent"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {initialsOf(user.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-4 text-foreground">{user.name}</span>
              <span className="block truncate text-xs leading-4 text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </div>
      )}
    </aside>
  )
}

// ── thread header ─────────────────────────────────────────────────────────────

interface ShellHeaderProps {
  title: string
  subtitle?: string
  pendingApprovals?: number
  /** Hamburger — only visible below `md`, where the sidebar is a drawer. */
  onOpenMobileNav?: () => void
  onShare?: () => void
  onOpenThreadMenu?: () => void
}

function ShellHeader({
  title,
  subtitle,
  pendingApprovals = 0,
  onOpenMobileNav,
  onShare,
  onOpenThreadMenu,
}: ShellHeaderProps) {
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5 sm:px-3">
      <button type="button" onClick={onOpenMobileNav} aria-label="Open navigation" className={`${iconButtonClass} md:hidden`}>
        <PanelLeft className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1 px-1">
        <p className="truncate text-sm font-semibold leading-5 text-foreground">{title}</p>
        {subtitle && (
          <p className="flex items-center gap-1.5 truncate text-xs leading-4 text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-label="Sandbox connected" />
            {subtitle}
          </p>
        )}
      </div>
      {pendingApprovals > 0 && (
        <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning sm:inline-flex">
          <ShieldCheck className="h-3.5 w-3.5" />
          {pendingApprovals} awaiting approval
        </span>
      )}
      <button type="button" onClick={onShare} aria-label="Share chat" className={iconButtonClass}>
        <Share2 className="h-4 w-4" />
      </button>
      <button type="button" onClick={onOpenThreadMenu} aria-label="Chat actions" className={iconButtonClass}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </header>
  )
}

// ── the composed shell ────────────────────────────────────────────────────────

export interface AppShellProps {
  sections: ShellSessionSection[]
  activeSessionId?: string | null
  sidebarCollapsed?: boolean
  sidebarDensity?: 'comfortable' | 'compact'
  pendingApprovals?: number
  user?: ShellUser | null
  headerTitle: string
  headerSubtitle?: string
  onNewChat?: () => void
  onSelectSession?: (id: string) => void
  onToggleCollapse?: () => void
  onOpenApprovals?: () => void
  onOpenSettings?: () => void
  onOpenAccount?: () => void
  onShare?: () => void
  onOpenThreadMenu?: () => void
  /** The thread — typically `<ChatMessages/>`. Rendered in the scroll area. */
  children?: ReactNode
  /** Typically `<ChatComposer/>`; pinned to the bottom of the main column and
   *  aligned to the same `max-w-3xl` reading column `ChatMessages` uses. */
  composer?: ReactNode
}

/**
 * The production agent-app layout: sidebar (fixed on desktop, drawer below
 * `md`), header row, scrolling thread, pinned composer. Presentational only —
 * all behavior arrives via props, so stories drive it with fixtures and
 * console.log callbacks.
 */
export function AppShell({
  sections,
  activeSessionId,
  sidebarCollapsed = false,
  sidebarDensity = 'comfortable',
  pendingApprovals = 0,
  user,
  headerTitle,
  headerSubtitle,
  onNewChat,
  onSelectSession,
  onToggleCollapse,
  onOpenApprovals,
  onOpenSettings,
  onOpenAccount,
  onShare,
  onOpenThreadMenu,
  children,
  composer,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const handleSelectSession = (id: string) => {
    onSelectSession?.(id)
    setMobileNavOpen(false)
  }

  const sidebarProps: AppSidebarProps = {
    sections,
    activeId: activeSessionId ?? null,
    collapsed: sidebarCollapsed,
    density: sidebarDensity,
    pendingApprovals,
    user,
    onNewChat,
    onSelectSession: handleSelectSession,
    onToggleCollapse,
    onOpenApprovals,
    onOpenSettings,
    onOpenAccount,
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <div className="hidden h-full md:block">
        <AppSidebar {...sidebarProps} />
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-2xl">
            <AppSidebar {...sidebarProps} collapsed={false} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ShellHeader
          title={headerTitle}
          subtitle={headerSubtitle}
          pendingApprovals={pendingApprovals}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onShare={onShare}
          onOpenThreadMenu={onOpenThreadMenu}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        {composer && (
          <div className="shrink-0 px-3 pb-3 pt-2 sm:px-4">
            <div className="mx-auto max-w-3xl">{composer}</div>
          </div>
        )}
      </div>
    </div>
  )
}
