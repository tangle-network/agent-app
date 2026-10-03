import { SidebarLayout, type SidebarLayoutNavItem, type SidebarLayoutProps } from '@tangle-network/sandbox-ui/dashboard'
import type { ReactNode } from 'react'

import type { WorkspaceAppRecord } from '../workspace-apps'

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
  /** Product-owned destinations. Shared Apps and History rows follow them. */
  navItems: SidebarLayoutNavItem[]
  /** Omit for a workflow-only shell with no conversational session rail. */
  sessions?: AgentWorkspaceSessionConfig
  /** Authorized app destinations, in the product's persisted order. */
  apps?: AgentWorkspaceAppsConfig
  /** When supplied, active navigation is resolved by the shared route rules. */
  activeRoute?: AgentWorkspaceActiveRoute
  /** Escape hatch for routers that already resolved the active item. */
  activeId?: string
  /** Hide the fixed desktop rail below this breakpoint. Defaults to `lg`. */
  hideBelow?: SidebarLayoutProps['hideBelow']
  /** Show labels beside rail icons. Defaults to `true`. */
  railLabels?: SidebarLayoutProps['railLabels']
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
  activeRoute,
  activeId,
  ...sidebarProps
}: AgentWorkspaceLayoutProps) {
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

  const appNavItems: SidebarLayoutNavItem[] = (apps?.items ?? []).map((app) => {
    const href = apps!.hrefForApp(app.id)
    if (!href.startsWith('/') || href.startsWith('//') || /[?#\\]/.test(href)) {
      throw new Error('Workspace app href must be a local route path')
    }
    return {
      id: 'workspace-app:' + app.id,
      label: app.name,
      icon: apps!.icon,
      href,
      prefetch: apps!.prefetch,
    }
  })
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
  const workspaceNavItems: SidebarLayoutNavItem[] = [
    ...navItems,
    ...(appGroup ? [appGroup] : []),
    ...(sessionNav ? [sessionNav] : []),
  ]

  const layoutProps = {
    hideBelow: 'lg' as const,
    railLabels: true,
    ...sidebarProps,
  }

  return (
    <SidebarLayout
      {...layoutProps}
      navItems={workspaceNavItems}
      activeId={activeAppId ? appGroup?.id : resolvedActiveId}
    >
      {children}
    </SidebarLayout>
  )
}

export { AgentWorkspaceCompanion, createAgentWorkspaceCompanionTabs, type AgentWorkspaceCompanionHandle, type AgentWorkspaceCompanionProps, type AgentWorkspaceCompanionTab, type AgentWorkspaceCompanionTool, type AgentWorkspaceCompanionTools, type AgentWorkspaceCompanionNavigation } from './companion'
