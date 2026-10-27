import { SidebarLayout, type SidebarLayoutNavItem, type SidebarLayoutProps } from '@tangle-network/sandbox-ui/dashboard'
import type { ReactNode } from 'react'

import { useWorkspacePrewarm, WorkspacePrewarmContext, type UseWorkspacePrewarmOptions } from '../web-react/workspace-prewarm'

import type { WorkspaceAppRecord } from '../workspace-apps'
import { AgentRailIdentity, type AgentProductIdentity, type AgentWorkspaceIdentity } from './rail-identity'

import {
  buildSessionNavItem,
  composeSidebarSessions,
  resolveActiveNavId,
  type NavRouteDef,
  type RailPrefetch,
  type SessionRowActions,
  type SessionSummary,
} from '../session-shell'

type WorkspaceIcon = SidebarLayoutNavItem['icon']

function routePathFromHref(href: string, base: string): string | null {
  const path = href.split(/[?#]/, 1)[0] ?? ''
  const root = base.replace(/\/+$/, '')
  if (path === root) return '/'
  if (!path.startsWith(`${root}/`)) return null
  return path.slice(root.length)
}

/**
 * A rail row's href must be a local route path; its query and fragment are
 * allowed (`routePathFromHref` drops them for active matching). A bad href
 * drops that row and reports it, since throwing here renders the product's
 * error page for the whole workspace.
 */
function localRailHref(kind: 'app' | 'agent', id: string, href: string): string | null {
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) return href
  console.error(`Workspace ${kind} href must be a local route path; dropped ${kind} ${id}: ${href}`)
  return null
}

/** The session data and product-owned URLs needed by the default workspace. */
export interface AgentWorkspaceSessionConfig {
  /** Icon shown beside the expandable History row. */
  icon: WorkspaceIcon
  /** Id for the session row; defaults to `history`. */
  id?: string
  /** Product copy for the session row; defaults to `History`. */
  label?: string
  /** Full-history route used by the row and overflow item. */
  href: string
  /** Product-owned URL for an individual session. */
  hrefForSession: (sessionId: string) => string
  /** Server-loaded rows, ordered by the product's query. */
  sessions: SessionSummary[]
  /** Sessions created by another tab before the loader revalidates. */
  optimisticSessions?: SessionSummary[]
  /** Number of rows shown in the rail before the full-history link. */
  limit?: number
  /** Total persisted session count, used to decide whether overflow exists. */
  totalCount?: number
  /** Session currently open in the route. */
  activeSessionId?: string | null
  /** Sessions with a live turn. */
  respondingSessionIds?: ReadonlySet<string>
  /** Live unread ids from the product's event channel. */
  liveUnreadIds?: ReadonlySet<string>
  /** Ids this tab has opened since the loader ran. */
  locallyReadIds?: ReadonlySet<string>
  /** Optional product-owned rename/delete/pin actions. */
  actions?: SessionRowActions<WorkspaceIcon>
  /** Label for the overflow row. Defaults to `View all chats`. */
  overflowLabel?: string
  /** Empty state for the expanded rail row. Defaults to `No chats yet`. */
  emptyLabel?: string
  /** Fallback title for untitled sessions. */
  untitledLabel?: string
  /** Router prefetch behavior for session links. */
  prefetch?: RailPrefetch
  /** Whether History starts expanded. Defaults to `true`. */
  defaultOpen?: boolean
}

/**
 * Registered apps shown under one expandable workspace destination.
 * Products supply authorized rows and their real route; preview URLs never
 * become navigation hrefs.
 */
export interface AgentWorkspaceAppsConfig {
  icon: WorkspaceIcon
  items: readonly Pick<WorkspaceAppRecord, 'id' | 'name'>[]
  hrefForApp: (appId: string) => string
  prefetch?: RailPrefetch
}

/** One agent in the workspace roster the rail lists. */
export interface AgentWorkspaceAgentRow {
  /** The stable profile id. */
  id: string
  name: string
  /** What the composer's `@` carries; shown beside the name. */
  handle?: string
}

/**
 * The workspace's agents under one expandable rail row, like Apps: each row
 * opens the agent's own thread (its direct line and its feed), and an optional
 * create route adds "New agent". Products supply authorized rows and real
 * routes; the roster comes from the product's agent-profile catalog.
 */
export interface AgentWorkspaceAgentsConfig {
  icon: WorkspaceIcon
  items: readonly AgentWorkspaceAgentRow[]
  hrefForAgent: (agentId: string) => string
  /** Row label. Defaults to `Agents`. */
  label?: string
  /** Route that creates an agent; adds a "New agent" row at the end. */
  createHref?: string
  /** Label for the create row. Defaults to `New agent`. */
  createLabel?: string
  prefetch?: RailPrefetch
}

/** Route data for the shared active-nav resolver. */
export interface AgentWorkspaceActiveRoute {
  /** Current browser pathname, including the product's workspace base. */
  pathname: string
  /** Product route root, for example `/app/ws_123`. */
  base: string
  /** Product-owned rail routes, relative to `base`. */
  routes: NavRouteDef[]
  /** Extra route prefixes that should highlight an existing row. */
  aliases?: Record<string, string>
  /** Route prefixes that intentionally highlight no row. */
  claimsNothing?: string[]
}

export interface AgentWorkspaceLayoutProps
  extends Omit<SidebarLayoutProps, 'activeId' | 'children' | 'navItems' | 'hideBelow' | 'railLabels'> {
  children: ReactNode
  /**
   * The product's name, mark, and home. With it the shell draws the canonical
   * rail top — mark, then the open workspace and product name — so products
   * stop hand-building `logo` and `railHeaderContent`.
   */
  product?: AgentProductIdentity
  /** The open workspace and where else this person can go. Omit on the listing. */
  workspace?: AgentWorkspaceIdentity | null
  /** Product-owned destinations. Shared Apps and History rows follow them. */
  navItems: SidebarLayoutNavItem[]
  /** Omit for a workflow-only shell with no conversational session rail. */
  sessions?: AgentWorkspaceSessionConfig
  /** Authorized app destinations, in the product's persisted order. */
  apps?: AgentWorkspaceAppsConfig
  /** The workspace's agents, each opening its own thread. */
  agents?: AgentWorkspaceAgentsConfig
  /** When supplied, active navigation is resolved by the shared route rules. */
  activeRoute?: AgentWorkspaceActiveRoute
  /** Escape hatch for routers that already resolved the active item. */
  activeId?: string
  /** Hide the fixed desktop rail below this breakpoint. Defaults to `lg`. */
  hideBelow?: SidebarLayoutProps['hideBelow']
  /** Show labels beside rail icons. Defaults to `true`. */
  railLabels?: SidebarLayoutProps['railLabels']
  /**
   * Warm the open workspace: the shell posts to the product's prewarm route
   * (`createWorkspacePrewarmRoute`) when the page opens in a visible tab, and
   * every `ChatComposer` inside reasserts on focus. Pass the route's URL and
   * whether this member may chat. Omit on pages with no workspace.
   */
  prewarm?: UseWorkspacePrewarmOptions
}

/**
 * The default agent workspace composition.
 *
 * Products own their navigation taxonomy, routes, and session storage. This
 * component owns the repeated assembly: the standard visual layout, the
 * expandable Apps and History rows, capped session composition, unread state,
 * and active route resolution. The full History route and the empty-state composer stay
 * separate because their data and domain copy belong to the product; pair this
 * with `SessionHistoryPanel` and `EntryComposer` for the complete chat-first
 * structure.
 */
export function AgentWorkspaceLayout({
  children,
  navItems,
  sessions,
  apps,
  agents,
  activeRoute,
  activeId,
  product,
  workspace,
  prewarm,
  ...sidebarProps
}: AgentWorkspaceLayoutProps) {
  const prewarmHandle = useWorkspacePrewarm(prewarm ?? { url: null })
  const sessionNav = sessions
    ? (() => {
        const composed = composeSidebarSessions({
          loaderSessions: sessions.sessions,
          optimisticSessions: sessions.optimisticSessions,
          limit: sessions.limit ?? 20,
          totalCount: sessions.totalCount,
          liveUnreadIds: sessions.liveUnreadIds,
          locallyReadIds: sessions.locallyReadIds,
          currentSessionId: sessions.activeSessionId,
        })

        return buildSessionNavItem<WorkspaceIcon>({
          id: sessions.id,
          label: sessions.label,
          icon: sessions.icon,
          href: sessions.href,
          sessions: composed.sessions,
          hrefForSession: sessions.hrefForSession,
          activeSessionId: sessions.activeSessionId,
          respondingSessionIds: sessions.respondingSessionIds,
          actions: sessions.actions,
          overflow: composed.hasMore
            ? { href: sessions.href, label: sessions.overflowLabel }
            : undefined,
          emptyLabel: sessions.emptyLabel,
          untitledLabel: sessions.untitledLabel,
          prefetch: sessions.prefetch,
          defaultOpen: sessions.defaultOpen,
        })
      })()
    : undefined

  const appNavItems: SidebarLayoutNavItem[] = (apps?.items ?? []).flatMap((app) => {
    const href = localRailHref('app', app.id, apps!.hrefForApp(app.id))
    return href ? [{ id: 'workspace-app:' + app.id, label: app.name, icon: apps!.icon, href, prefetch: apps!.prefetch }] : []
  })
  const agentNavItems: SidebarLayoutNavItem[] = [
    ...(agents?.items ?? []).flatMap((agent) => {
      const href = localRailHref('agent', agent.id, agents!.hrefForAgent(agent.id))
      if (!href) return []
      return [{
        id: 'workspace-agent:' + agent.id,
        label: agent.handle ? `${agent.name} · @${agent.handle}` : agent.name,
        icon: agents!.icon,
        href,
        prefetch: agents!.prefetch,
      }]
    }),
    ...(agents?.createHref
      ? [{ id: 'workspace-agent:new', label: agents.createLabel ?? 'New agent', icon: agents.icon, href: agents.createHref, prefetch: agents.prefetch }]
      : []),
  ]
  const agentRoutes: NavRouteDef[] = activeRoute
    ? agentNavItems.map((item) => {
        const path = routePathFromHref(item.href!, activeRoute.base)
        if (!path) throw new Error('Workspace agent href must be under the active workspace')
        return { id: item.id, path }
      })
    : []
  const appRoutes: NavRouteDef[] = activeRoute
    ? appNavItems.map((item) => {
        const path = routePathFromHref(item.href!, activeRoute.base)
        if (!path) throw new Error('Workspace app href must be under the active workspace')
        return { id: item.id, path }
      })
    : []

  const historyRoutePath = sessions && activeRoute
    ? routePathFromHref(sessions.href, activeRoute.base)
    : null

  const resolvedActiveId = activeRoute
    ? resolveActiveNavId({
        ...activeRoute,
        routes: [
          ...activeRoute.routes,
          ...appRoutes,
          ...agentRoutes,
          ...(sessionNav && historyRoutePath
            ? [{ id: sessions?.id ?? 'history', path: historyRoutePath }]
            : []),
        ],
      })
    : activeId

  const activeAppId = appNavItems.some((item) => item.id === resolvedActiveId)
    ? resolvedActiveId
    : undefined
  const appGroup: SidebarLayoutNavItem | undefined = apps && appNavItems.length > 0
    ? {
        id: 'workspace-apps',
        label: 'Apps',
        icon: apps.icon,
        expandable: true,
        defaultOpen: activeAppId !== undefined,
        subItems: appNavItems.map(({ id, label, icon, href, prefetch }) => ({
          id,
          label,
          icon,
          href: href!,
          prefetch,
        })),
        subActiveIds: activeAppId ? [activeAppId] : undefined,
      }
    : undefined
  const activeAgentId = agentNavItems.some((item) => item.id === resolvedActiveId) ? resolvedActiveId : undefined
  const agentGroup: SidebarLayoutNavItem | undefined = agents && agentNavItems.length > 0
    ? {
        id: 'workspace-agents',
        label: agents.label ?? 'Agents',
        icon: agents.icon,
        expandable: true,
        defaultOpen: true,
        subItems: agentNavItems.map(({ id, label, icon, href, prefetch }) => ({ id, label, icon, href: href!, prefetch })),
        subActiveIds: activeAgentId ? [activeAgentId] : undefined,
      }
    : undefined
  const workspaceNavItems: SidebarLayoutNavItem[] = [
    ...navItems,
    ...(agentGroup ? [agentGroup] : []),
    ...(appGroup ? [appGroup] : []),
    ...(sessionNav ? [sessionNav] : []),
  ]

  const hideBelow = sidebarProps.hideBelow ?? 'lg'
  const identityProps = product
    ? {
        logo: product.mark,
        logoHref: product.href,
        railHeaderContent: (
          <AgentRailIdentity
            product={product}
            workspace={workspace}
            hideBelow={hideBelow}
            LinkComponent={sidebarProps.LinkComponent}
          />
        ),
      }
    : {}
  const layoutProps = {
    hideBelow,
    railLabels: true,
    ...identityProps,
    ...sidebarProps,
  }

  return (
    <WorkspacePrewarmContext.Provider value={prewarm ? prewarmHandle : null}>
      <SidebarLayout
        {...layoutProps}
        navItems={workspaceNavItems}
        activeId={activeAppId ? appGroup?.id : resolvedActiveId}
      >
        {children}
      </SidebarLayout>
    </WorkspacePrewarmContext.Provider>
  )
}

export { AgentWorkspaceCompanion, createAgentWorkspaceCompanionTabs, type AgentWorkspaceCompanionHandle, type AgentWorkspaceCompanionProps, type AgentWorkspaceCompanionTab, type AgentWorkspaceCompanionTool, type AgentWorkspaceCompanionTools, type AgentWorkspaceCompanionNavigation } from './companion'

export { WorkspaceSwitcher, type WorkspaceSwitcherItem, type WorkspaceSwitcherProps } from '../web-react/workspace-switcher'

export { WorkspaceInitial } from '../web-react/workspace-switcher'
export {
  AgentRailIdentity,
  DEFAULT_WORKSPACE_NOUN,
  type AgentProductIdentity,
  type AgentRailIdentityProps,
  type AgentWorkspaceIdentity,
  type AgentWorkspaceNoun,
} from './rail-identity'

export {
  WorkspaceList,
  type WorkspaceListAction,
  type WorkspaceListField,
  type WorkspaceListItem,
  type WorkspaceListProps,
} from './workspace-list'
