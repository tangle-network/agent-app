import { type SidebarLayoutNavItem, type SidebarLayoutProps } from '@tangle-network/sandbox-ui/dashboard';
import type { ReactNode } from 'react';
import { type NavRouteDef, type RailPrefetch, type SessionRowActions, type SessionSummary } from '../session-shell';
type WorkspaceIcon = SidebarLayoutNavItem['icon'];
/** The session data and product-owned URLs needed by the default workspace. */
export interface AgentWorkspaceSessionConfig {
    /** Icon shown beside the expandable History row. */
    icon: WorkspaceIcon;
    /** Id for the session row; defaults to `history`. */
    id?: string;
    /** Product copy for the session row; defaults to `History`. */
    label?: string;
    /** Full-history route used by the row and overflow item. */
    href: string;
    /** Product-owned URL for an individual session. */
    hrefForSession: (sessionId: string) => string;
    /** Server-loaded rows, ordered by the product's query. */
    sessions: SessionSummary[];
    /** Sessions created by another tab before the loader revalidates. */
    optimisticSessions?: SessionSummary[];
    /** Number of rows shown in the rail before the full-history link. */
    limit?: number;
    /** Total persisted session count, used to decide whether overflow exists. */
    totalCount?: number;
    /** Session currently open in the route. */
    activeSessionId?: string | null;
    /** Sessions with a live turn. */
    respondingSessionIds?: ReadonlySet<string>;
    /** Live unread ids from the product's event channel. */
    liveUnreadIds?: ReadonlySet<string>;
    /** Ids this tab has opened since the loader ran. */
    locallyReadIds?: ReadonlySet<string>;
    /** Optional product-owned rename/delete/pin actions. */
    actions?: SessionRowActions<WorkspaceIcon>;
    /** Label for the overflow row. Defaults to `View all chats`. */
    overflowLabel?: string;
    /** Empty state for the expanded rail row. Defaults to `No chats yet`. */
    emptyLabel?: string;
    /** Fallback title for untitled sessions. */
    untitledLabel?: string;
    /** Router prefetch behavior for session links. */
    prefetch?: RailPrefetch;
    /** Whether History starts expanded. Defaults to `true`. */
    defaultOpen?: boolean;
}
/** Route data for the shared active-nav resolver. */
export interface AgentWorkspaceActiveRoute {
    /** Current browser pathname, including the product's workspace base. */
    pathname: string;
    /** Product route root, for example `/app/ws_123`. */
    base: string;
    /** Product-owned rail routes, relative to `base`. */
    routes: NavRouteDef[];
    /** Extra route prefixes that should highlight an existing row. */
    aliases?: Record<string, string>;
    /** Route prefixes that intentionally highlight no row. */
    claimsNothing?: string[];
}
export interface AgentWorkspaceLayoutProps extends Omit<SidebarLayoutProps, 'activeId' | 'children' | 'navItems' | 'hideBelow' | 'railLabels'> {
    children: ReactNode;
    /** Product-owned destinations. The shared History row is appended after them. */
    navItems: SidebarLayoutNavItem[];
    /** Omit for a workflow-only shell with no conversational session rail. */
    sessions?: AgentWorkspaceSessionConfig;
    /** When supplied, active navigation is resolved by the shared route rules. */
    activeRoute?: AgentWorkspaceActiveRoute;
    /** Escape hatch for routers that already resolved the active item. */
    activeId?: string;
    /** Hide the fixed desktop rail below this breakpoint. Defaults to `lg`. */
    hideBelow?: SidebarLayoutProps['hideBelow'];
    /** Show labels beside rail icons. Defaults to `true`. */
    railLabels?: SidebarLayoutProps['railLabels'];
}
/**
 * The default agent workspace composition.
 *
 * Products own their navigation taxonomy, routes, and session storage. This
 * component owns the repeated assembly: the standard visual layout, the
 * expandable History row, capped session composition, unread state, and active
 * route resolution. The full History route and the empty-state composer stay
 * separate because their data and domain copy belong to the product; pair this
 * with `SessionHistoryPanel` and `EntryComposer` for the complete chat-first
 * structure.
 */
export declare function AgentWorkspaceLayout({ children, navItems, sessions, activeRoute, activeId, ...sidebarProps }: AgentWorkspaceLayoutProps): import("react").JSX.Element;
export {};
