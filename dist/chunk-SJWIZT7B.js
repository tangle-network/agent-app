// src/session-shell/path.ts
function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}
function stripSlashes(value) {
  return value.replace(/^\/+|\/+$/g, "");
}
function normalizePath(pathname) {
  const withoutHash = pathname.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  return stripTrailingSlashes(withoutQuery);
}
function isUnderPrefix(path, prefix) {
  const p = stripTrailingSlashes(prefix);
  if (p === "") return true;
  return path === p || path.startsWith(`${p}/`);
}
function toSegments(value) {
  return value.split("/").filter((segment) => segment.length > 0);
}
function toRootedPath(value) {
  return `/${toSegments(value).join("/")}`;
}

// src/session-shell/nav-guard.ts
function resolveNavHref(destination, bases) {
  const base = bases[destination.scope];
  if (typeof base !== "string") {
    throw new Error(
      `Nav destination '${destination.id}' uses scope '${destination.scope}', which has no configured base`
    );
  }
  if (destination.path !== "" && !destination.path.startsWith("/")) {
    throw new Error(
      `Nav destination '${destination.id}' path must be empty or start with '/' (got '${destination.path}')`
    );
  }
  const rooted = `${stripTrailingSlashes(base)}${destination.path}`;
  return rooted === "" ? "/" : stripTrailingSlashes(rooted);
}
function resolveNavDestinations(destinations, bases) {
  return destinations.map((destination) => ({
    id: destination.id,
    href: resolveNavHref(destination, bases),
    scope: destination.scope
  }));
}
function resolveScopedActiveNavId({
  pathname,
  destinations,
  bases,
  aliases,
  claimsNothing
}) {
  const path = normalizePath(pathname);
  let bestLength = -1;
  let bestId;
  const consider = (candidate, id, winsTies = false) => {
    const full = stripTrailingSlashes(candidate);
    if (!isUnderPrefix(path, full)) return;
    if (full.length > bestLength || winsTies && full.length === bestLength) {
      bestLength = full.length;
      bestId = id;
    }
  };
  for (const resolved of resolveNavDestinations(destinations, bases)) consider(resolved.href, resolved.id);
  for (const [prefix, id] of Object.entries(aliases ?? {})) consider(prefix, id);
  for (const prefix of claimsNothing ?? []) consider(prefix, void 0, true);
  return bestId;
}
function joinPattern(parent, child) {
  if (child.startsWith("/")) return child;
  if (child === "") return parent;
  return `${parent}/${child}`;
}
function flattenRouteTable(table) {
  const patterns = [];
  const walk = (entries, parent) => {
    for (const entry of entries) {
      if (typeof entry === "string") {
        patterns.push(toRootedPath(joinPattern(parent, entry)));
        continue;
      }
      const own = entry.path === void 0 ? parent : joinPattern(parent, entry.path);
      patterns.push(toRootedPath(own));
      if (entry.children) walk(entry.children, own);
    }
  };
  walk(table, "");
  return [...new Set(patterns)];
}
function matchesPattern(pathSegments, patternSegments, caseSensitive) {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const head = patternSegments[0] ?? "";
  if (head === "*") return true;
  const rest = patternSegments.slice(1);
  const optional = head.endsWith("?");
  const core = optional ? head.slice(0, -1) : head;
  const first = pathSegments[0];
  if (first !== void 0) {
    const hit = core.startsWith(":") ? first.length > 0 : caseSensitive ? core === first : core.toLowerCase() === first.toLowerCase();
    if (hit && matchesPattern(pathSegments.slice(1), rest, caseSensitive)) return true;
  }
  return optional ? matchesPattern(pathSegments, rest, caseSensitive) : false;
}
var OFF_ROUTER_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
function flattenItems(items, out = []) {
  for (const item of items) {
    out.push(item);
    if (item.subItems) flattenItems(item.subItems, out);
  }
  return out;
}
function checkNavHrefs(items, routes, options = {}) {
  const { ignore, allowExternal = true, caseSensitive = true } = options;
  const patterns = flattenRouteTable(routes);
  const patternSegments = patterns.map((pattern) => ({ pattern, segments: toSegments(pattern) }));
  const ignored = new Set((ignore ?? []).map((href) => normalizePath(href)));
  const problems = [];
  const external = [];
  const flat = flattenItems(items);
  let checked = 0;
  for (const item of flat) {
    const raw = item.href;
    const path = normalizePath(raw);
    if (ignored.has(path)) continue;
    if (OFF_ROUTER_HREF.test(raw)) {
      if (allowExternal) {
        external.push(raw);
        continue;
      }
      checked += 1;
      problems.push({
        id: item.id,
        href: raw,
        reason: "external",
        nearest: [],
        message: `Nav item '${item.id}' href '${raw}' leaves the router, and external destinations are rejected`
      });
      continue;
    }
    checked += 1;
    if (raw === "" || raw.startsWith("#") || !raw.startsWith("/")) {
      problems.push({
        id: item.id,
        href: raw,
        reason: "not-a-path",
        nearest: [],
        message: `Nav item '${item.id}' href '${raw}' is not a rooted path \u2014 it cannot resolve to a registered route`
      });
      continue;
    }
    const segments = toSegments(path);
    if (patternSegments.some((candidate) => matchesPattern(segments, candidate.segments, caseSensitive))) continue;
    const nearest = nearestPatterns(segments, patternSegments.map((candidate) => candidate.pattern), caseSensitive);
    problems.push({
      id: item.id,
      href: raw,
      reason: "unregistered",
      nearest,
      message: `Nav item '${item.id}' href '${raw}' matches no registered route` + (nearest.length ? ` \u2014 nearest registered: ${nearest.join(", ")}` : "")
    });
  }
  return { checked, problems, external, patterns };
}
function nearestPatterns(segments, patterns, caseSensitive) {
  const tail = segments[segments.length - 1];
  if (tail === void 0) return [];
  const same = (a, b) => caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
  return patterns.filter((pattern) => {
    const patternTail = toSegments(pattern).at(-1);
    return patternTail !== void 0 && same(patternTail, tail);
  }).slice(0, 5);
}
function assertNavHrefsRegistered(items, routes, options = {}) {
  if (items.length === 0) {
    throw new Error("assertNavHrefsRegistered received no nav items \u2014 the check would pass without examining anything");
  }
  const report = checkNavHrefs(items, routes, options);
  if (report.patterns.length === 0) {
    throw new Error("assertNavHrefsRegistered received an empty route table \u2014 every href would fail or nothing would be proven");
  }
  if (report.problems.length > 0) {
    const detail = report.problems.map((problem) => `  - ${problem.message}`).join("\n");
    throw new Error(
      `${report.problems.length} of ${report.checked} nav hrefs do not resolve to a registered route:
${detail}
Registered patterns (${report.patterns.length}): ${report.patterns.join(", ")}`
    );
  }
  if (report.checked === 0) {
    throw new Error(
      `assertNavHrefsRegistered examined 0 hrefs (${report.external.length} external, ${ignoredCount(items, options)} ignored) \u2014 the check would pass without examining anything`
    );
  }
}
function ignoredCount(items, options) {
  const ignored = new Set((options.ignore ?? []).map((href) => normalizePath(href)));
  return flattenItems(items).filter((item) => ignored.has(normalizePath(item.href))).length;
}

// src/session-shell/command-palette.ts
var COMMAND_PALETTE_SESSIONS_GROUP = "Sessions";
var COMMAND_PALETTE_ACTIONS_GROUP = "Actions";
function buildCommandPaletteItems({
  sessions = [],
  actions = [],
  sessionsLabel = COMMAND_PALETTE_SESSIONS_GROUP,
  actionsLabel = COMMAND_PALETTE_ACTIONS_GROUP,
  untitledLabel = UNTITLED_SESSION_LABEL
}) {
  const ordered = [...sessions].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    return compareRecent(a.updatedAt, b.updatedAt);
  });
  const sessionItems = ordered.map((session) => ({
    id: session.id,
    group: sessionsLabel,
    label: sessionLabel(session, untitledLabel),
    keywords: session.category ? [session.category] : void 0,
    recentAt: session.updatedAt
  }));
  const actionItems = actions.map((action) => ({
    id: action.id,
    group: actionsLabel,
    label: action.label,
    description: action.description,
    hint: action.hint,
    keywords: action.keywords
  }));
  return [...sessionItems, ...actionItems];
}
function compareRecent(a, b) {
  if (a && b) return a < b ? 1 : a > b ? -1 : 0;
  if (a) return -1;
  if (b) return 1;
  return 0;
}
function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
var WORD_SPLIT = /[^\p{L}\p{N}]+/u;
function wordsOf(text) {
  return text.split(WORD_SPLIT).filter(Boolean);
}
var KEYWORD_PENALTY = 65;
function scoreText(text, query) {
  if (!query) return 0;
  if (text === query) return 100;
  if (text.startsWith(query)) return 90;
  const words = wordsOf(text);
  if (words.some((word) => word.startsWith(query))) return 80;
  const at = text.indexOf(query);
  if (at >= 0) return 60 + Math.max(0, 19 - at);
  const tokens = wordsOf(query);
  if (tokens.length > 1) {
    let atWord = 0;
    const inOrder = tokens.every((token) => {
      while (atWord < words.length) {
        const word = words[atWord];
        atWord += 1;
        if (word !== void 0 && (word.startsWith(token) || word.includes(token))) return true;
      }
      return false;
    });
    if (inOrder) return 40;
  }
  return null;
}
function scoreCommandPaletteItem(item, query) {
  const q = normalize(query);
  const label = scoreText(normalize(item.label), q);
  let best = label;
  for (const keyword of item.keywords ?? []) {
    const score = scoreText(normalize(keyword), q);
    if (score !== null) {
      const penalized = score - KEYWORD_PENALTY;
      if (best === null || penalized > best) best = penalized;
    }
  }
  return best;
}
function filterCommandPaletteItems(items, query) {
  if (!normalize(query)) return [...items];
  const scored = [];
  items.forEach((item, index) => {
    const score = scoreCommandPaletteItem(item, query);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const recent = compareRecent(a.item.recentAt, b.item.recentAt);
    if (recent !== 0) return recent;
    return a.index - b.index;
  });
  return scored.map(({ item }) => item);
}
function groupCommandPaletteItems(items) {
  const groups = [];
  const byGroup = /* @__PURE__ */ new Map();
  for (const item of items) {
    let group = byGroup.get(item.group);
    if (!group) {
      group = { group: item.group, items: [] };
      byGroup.set(item.group, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

// src/session-shell/index.ts
var UNTITLED_SESSION_LABEL = "Untitled chat";
function sessionLabel(session, untitled = UNTITLED_SESSION_LABEL) {
  return session.title?.trim() || untitled;
}
function buildSessionSubItems({
  sessions,
  hrefForSession,
  respondingSessionIds,
  actions,
  untitledLabel = UNTITLED_SESSION_LABEL,
  prefetch = "intent",
  overflow
}) {
  const rowActions = (session) => {
    if (!actions?.canEdit) return void 0;
    const built = [];
    const { onRename, onDelete, extraActions } = actions;
    if (onRename) {
      built.push({
        id: "rename",
        label: actions.renameLabel ?? "Rename",
        icon: actions.renameIcon,
        onSelect: () => onRename(session)
      });
    }
    if (extraActions) built.push(...extraActions(session));
    if (onDelete) {
      built.push({
        id: "delete",
        label: actions.deleteLabel ?? "Delete",
        icon: actions.deleteIcon,
        destructive: true,
        onSelect: () => onDelete(session)
      });
    }
    return built.length ? built : void 0;
  };
  const rows = sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session, untitledLabel),
    href: hrefForSession(session.id),
    prefetch,
    isLoading: respondingSessionIds?.has(session.id) ?? false,
    unread: Boolean(session.unread),
    actions: rowActions(session)
  }));
  if (!overflow) return rows;
  return [
    ...rows,
    {
      id: "view-all",
      label: overflow.label ?? "View all chats",
      href: overflow.href,
      prefetch,
      emphasis: true
    }
  ];
}
function buildSessionNavItem({
  id = "history",
  label = "History",
  icon,
  href,
  activeSessionId,
  emptyLabel = "No chats yet",
  defaultOpen = true,
  ...subItemOptions
}) {
  return {
    id,
    icon,
    label,
    href,
    expandable: true,
    defaultOpen,
    subItems: buildSessionSubItems(subItemOptions),
    subActiveIds: activeSessionId ? [activeSessionId] : void 0,
    emptyLabel,
    prefetch: subItemOptions.prefetch ?? "intent"
  };
}
function activeSessionIdFromPath({
  pathname,
  base,
  segment = "chat",
  newSegment = "new",
  reserved
}) {
  const path = normalizePath(pathname);
  const root = stripTrailingSlashes(base);
  const prefix = segment ? `${root}/${segment}` : root;
  if (!isUnderPrefix(path, prefix) || path === prefix) return null;
  const id = path.slice(prefix.length + 1).split("/")[0] ?? "";
  if (!id || id === newSegment) return null;
  if (reserved?.some((name) => stripSlashes(name) === id)) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}
function resolveActiveNavId({
  pathname,
  base,
  routes,
  aliases,
  claimsNothing
}) {
  const path = normalizePath(pathname);
  const root = stripTrailingSlashes(base);
  let bestLength = -1;
  let bestId;
  const consider = (relative, id, winsTies = false) => {
    const full = stripTrailingSlashes(`${root}${relative}`);
    if (!isUnderPrefix(path, full)) return;
    if (full.length > bestLength || winsTies && full.length === bestLength) {
      bestLength = full.length;
      bestId = id;
    }
  };
  for (const route of routes) consider(route.path, route.id);
  for (const [prefix, id] of Object.entries(aliases ?? {})) consider(prefix, id);
  for (const prefix of claimsNothing ?? []) consider(prefix, void 0, true);
  return bestId;
}
function resolveSessionUnread({
  sessionId,
  loaderUnread,
  liveUnreadIds,
  locallyReadIds,
  currentSessionId
}) {
  if (sessionId === currentSessionId) return false;
  if (liveUnreadIds?.has(sessionId)) return true;
  if (locallyReadIds?.has(sessionId)) return false;
  return loaderUnread;
}
function composeSidebarSessions({
  loaderSessions,
  optimisticSessions = [],
  limit,
  totalCount,
  liveUnreadIds,
  locallyReadIds,
  currentSessionId
}) {
  const loaderIds = new Set(loaderSessions.map((session) => session.id));
  const pendingNew = optimisticSessions.filter((session) => !loaderIds.has(session.id));
  const merged = [...pendingNew, ...loaderSessions];
  const sessions = merged.slice(0, Math.max(0, limit)).map((session) => ({
    ...session,
    unread: resolveSessionUnread({
      sessionId: session.id,
      loaderUnread: Boolean(session.unread),
      liveUnreadIds,
      locallyReadIds,
      currentSessionId
    })
  }));
  const known = (totalCount ?? loaderSessions.length) + pendingNew.length;
  return { sessions, hasMore: known > sessions.length };
}
function mergeSessionPages(existing, incoming) {
  const seen = new Set(existing.map((session) => session.id));
  return [...existing, ...incoming.filter((session) => !seen.has(session.id))];
}
var DEFAULT_RAIL_COOKIE_NAME = "agent-sidebar-rail-collapsed";
function readRailCollapsedCookie(cookieHeader, name = DEFAULT_RAIL_COOKIE_NAME) {
  for (const pair of (cookieHeader ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1).trim() === "1";
  }
  return false;
}
function railCollapsedCookie(collapsed, { name = DEFAULT_RAIL_COOKIE_NAME, maxAge = 31536e3, path = "/", secure } = {}) {
  const isSecure = secure ?? (typeof location !== "undefined" && location.protocol === "https:");
  return `${name}=${collapsed ? "1" : "0"}; path=${path}; max-age=${maxAge}; samesite=lax${isSecure ? "; secure" : ""}`;
}
function writeRailCollapsedCookie(collapsed, options = {}) {
  if (typeof document === "undefined") return;
  document.cookie = railCollapsedCookie(collapsed, options);
}

export {
  resolveNavHref,
  resolveNavDestinations,
  resolveScopedActiveNavId,
  flattenRouteTable,
  checkNavHrefs,
  assertNavHrefsRegistered,
  COMMAND_PALETTE_SESSIONS_GROUP,
  COMMAND_PALETTE_ACTIONS_GROUP,
  buildCommandPaletteItems,
  scoreCommandPaletteItem,
  filterCommandPaletteItems,
  groupCommandPaletteItems,
  UNTITLED_SESSION_LABEL,
  sessionLabel,
  buildSessionSubItems,
  buildSessionNavItem,
  activeSessionIdFromPath,
  resolveActiveNavId,
  resolveSessionUnread,
  composeSidebarSessions,
  mergeSessionPages,
  DEFAULT_RAIL_COOKIE_NAME,
  readRailCollapsedCookie,
  railCollapsedCookie,
  writeRailCollapsedCookie
};
//# sourceMappingURL=chunk-SJWIZT7B.js.map