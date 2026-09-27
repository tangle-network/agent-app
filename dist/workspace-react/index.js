import {
  buildSessionNavItem,
  composeSidebarSessions,
  resolveActiveNavId
} from "../chunk-SJWIZT7B.js";

// src/workspace-react/index.tsx
import { SidebarLayout } from "@tangle-network/sandbox-ui/dashboard";
import { jsx } from "react/jsx-runtime";
function routePathFromHref(href, base) {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  const root = base.replace(/\/+$/, "");
  if (path === root) return "/";
  if (!path.startsWith(`${root}/`)) return null;
  return path.slice(root.length);
}
function AgentWorkspaceLayout({
  children,
  navItems,
  sessions,
  activeRoute,
  activeId,
  ...sidebarProps
}) {
  const sessionNav = sessions ? (() => {
    const composed = composeSidebarSessions({
      loaderSessions: sessions.sessions,
      optimisticSessions: sessions.optimisticSessions,
      limit: sessions.limit ?? 20,
      totalCount: sessions.totalCount,
      liveUnreadIds: sessions.liveUnreadIds,
      locallyReadIds: sessions.locallyReadIds,
      currentSessionId: sessions.activeSessionId
    });
    return buildSessionNavItem({
      id: sessions.id,
      label: sessions.label,
      icon: sessions.icon,
      href: sessions.href,
      sessions: composed.sessions,
      hrefForSession: sessions.hrefForSession,
      activeSessionId: sessions.activeSessionId,
      respondingSessionIds: sessions.respondingSessionIds,
      actions: sessions.actions,
      overflow: composed.hasMore ? { href: sessions.href, label: sessions.overflowLabel } : void 0,
      emptyLabel: sessions.emptyLabel,
      untitledLabel: sessions.untitledLabel,
      prefetch: sessions.prefetch,
      defaultOpen: sessions.defaultOpen
    });
  })() : void 0;
  const workspaceNavItems = sessionNav ? [...navItems, sessionNav] : navItems;
  const historyRoutePath = sessions && activeRoute ? routePathFromHref(sessions.href, activeRoute.base) : null;
  const resolvedActiveId = activeRoute ? resolveActiveNavId({
    ...activeRoute,
    routes: sessionNav && historyRoutePath ? [
      ...activeRoute.routes,
      {
        id: sessions?.id ?? "history",
        path: historyRoutePath
      }
    ] : activeRoute.routes
  }) : activeId;
  const layoutProps = {
    hideBelow: "lg",
    railLabels: true,
    ...sidebarProps
  };
  return /* @__PURE__ */ jsx(
    SidebarLayout,
    {
      ...layoutProps,
      navItems: workspaceNavItems,
      activeId: resolvedActiveId,
      children
    }
  );
}
export {
  AgentWorkspaceLayout
};
//# sourceMappingURL=index.js.map