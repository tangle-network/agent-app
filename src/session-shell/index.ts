/**
 * Session shell — the app-shell mechanism every agent product needs around the
 * chat surface: a list of past sessions in the rail, an entry point for a new
 * one, and a paged history view behind it.
 *
 * `/web-react` already owns the chat SURFACE (composer, transcript, cards); it
 * owned no session SHELL, so all four products hand-rolled one and drifted.
 * This module is the shell's pure half: no React, no DOM, no peer imports, so a
 * server loader can call `readRailCollapsedCookie` without dragging React into
 * a worker bundle (`/web-react` holds the rendered half).
 *
 * Domain stays a parameter. A "session" here is only an id, a title and a
 * timestamp — a gtm thread, a tax session and a legal matter are all the same
 * shape to the shell, and the product supplies routing through `hrefForSession`
 * rather than the shell knowing any URL.
 */

/** One session as the shell needs to see it. Products map their own row
 *  (thread / session / matter) onto this before handing it over. */
export interface SessionSummary {
  id: string
  /** `null`/empty renders as the untitled placeholder rather than a blank row. */
  title: string | null
  /** ISO-8601. `null` when the product has no timestamp to show. */
  updatedAt: string | null
  isPinned?: boolean
  /** Unread for the viewer. Use `resolveSessionUnread` to fold live overlays in. */
  unread?: boolean
  /** Free-form product label (gtm categories, legal matter types). Passed
   *  through untouched — the shell never interprets it. */
  category?: string | null
}

/** One fetched page of sessions with an optional continuation cursor. */
export interface SessionPage {
  items: SessionSummary[]
  /** Opaque continuation token; absent/null ⇒ no further pages. */
  nextCursor?: string | null
}

/** Sort order for the history view. The product's fetcher decides what these
 *  mean against its own storage; the shell only round-trips the value. */
export type SessionSort = 'newest' | 'oldest'

// ---------------------------------------------------------------------------
// Rail items — structurally assignable to sandbox-ui's SidebarLayout types
// ---------------------------------------------------------------------------

/**
 * These mirror `@tangle-network/sandbox-ui/dashboard`'s `SidebarLayoutNavItem`
 * / `RailExpandableSubItem` STRUCTURALLY rather than importing them, so this
 * module stays free of the optional peer (invariant 3 — structural over
 * hard-dep when the surface is small). `tests/session-shell/rail-contract.test.ts`
 * assigns the builder output to the real sandbox-ui types, so a drift in either
 * direction fails CI instead of silently dropping a field at runtime.
 *
 * `TIcon` is the product's icon component type (lucide, custom, anything) —
 * generic so this file needs no React types.
 */
export interface SessionRailAction<TIcon = unknown> {
  id: string
  label: string
  icon?: TIcon
  destructive?: boolean
  onSelect: () => void
}

export type RailPrefetch = 'none' | 'intent' | 'render' | 'viewport'

export interface SessionRailSubItem<TIcon = unknown> {
  id: string
  label: string
  href: string
  prefetch?: RailPrefetch
  /** Live working indicator — the session is mid-turn. */
  isLoading?: boolean
  /** Bold + leading dot. sandbox-ui suppresses it while `isLoading`. */
  unread?: boolean
  /** Emphasised row, used for the trailing "view all" overflow link. */
  emphasis?: boolean
  actions?: SessionRailAction<TIcon>[]
}

export interface SessionRailNavItem<TIcon = unknown> {
  id: string
  /** REQUIRED, mirroring sandbox-ui — the rail renders `<Icon />` unguarded, so
   *  an omitted icon is a blank/crashing row rather than a styling nit. */
  icon: TIcon
  label: string
  href: string
  badge?: number
  expandable?: boolean
  defaultOpen?: boolean
  subItems?: SessionRailSubItem<TIcon>[]
  subActiveIds?: string[]
  emptyLabel?: string
  prefetch?: RailPrefetch
}

/** Per-row rename/delete wiring. Supplied by the layout that owns the dialogs;
 *  omitted (or `canEdit: false`) leaves rows read-only. */
export interface SessionRowActions<TIcon = unknown> {
  canEdit: boolean
  renameIcon?: TIcon
  deleteIcon?: TIcon
  renameLabel?: string
  deleteLabel?: string
  /**
   * Omit when the product cannot rename a session — the row then offers delete
   * only, instead of a menu item that does nothing.
   *
   * Independently optional, matching `SessionHistoryPanel`, which has always
   * rendered whichever of the two it was given. The rail builder used to demand
   * both, so a product with archive-but-no-rename (tax) could either fake a
   * rename or ship no row actions at all.
   */
  onRename?: (session: SessionSummary) => void
  onDelete?: (session: SessionSummary) => void
}

export const UNTITLED_SESSION_LABEL = 'Untitled chat'

/** Display title for a session row — trims, and falls back rather than
 *  rendering an empty row the user cannot aim at. */
export function sessionLabel(session: SessionSummary, untitled = UNTITLED_SESSION_LABEL): string {
  return session.title?.trim() || untitled
}

export interface BuildSessionSubItemsOptions<TIcon = unknown> {
  sessions: SessionSummary[]
  /** The product's route for one session. The shell never builds a URL itself. */
  hrefForSession: (sessionId: string) => string
  /** Ids currently mid-turn — renders the working indicator. */
  respondingSessionIds?: ReadonlySet<string>
  actions?: SessionRowActions<TIcon>
  untitledLabel?: string
  prefetch?: RailPrefetch
  /** Trailing "view all" row, appended when the capped list hides sessions. */
  overflow?: { href: string; label?: string }
}

/** Session rows for the rail's expandable history item. */
export function buildSessionSubItems<TIcon = unknown>({
  sessions,
  hrefForSession,
  respondingSessionIds,
  actions,
  untitledLabel = UNTITLED_SESSION_LABEL,
  prefetch = 'intent',
  overflow,
}: BuildSessionSubItemsOptions<TIcon>): SessionRailSubItem<TIcon>[] {
  /**
   * Only the handlers the product actually supplied. An empty result becomes
   * `undefined` rather than `[]`, because sandbox-ui renders the kebab trigger
   * whenever `actions` is an array — an empty one is a button that opens an
   * empty menu.
   */
  const rowActions = (session: SessionSummary): SessionRailAction<TIcon>[] | undefined => {
    if (!actions?.canEdit) return undefined
    const built: SessionRailAction<TIcon>[] = []
    const { onRename, onDelete } = actions
    if (onRename) {
      built.push({
        id: 'rename',
        label: actions.renameLabel ?? 'Rename',
        icon: actions.renameIcon,
        onSelect: () => onRename(session),
      })
    }
    if (onDelete) {
      built.push({
        id: 'delete',
        label: actions.deleteLabel ?? 'Delete',
        icon: actions.deleteIcon,
        destructive: true,
        onSelect: () => onDelete(session),
      })
    }
    return built.length ? built : undefined
  }

  const rows: SessionRailSubItem<TIcon>[] = sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session, untitledLabel),
    href: hrefForSession(session.id),
    prefetch,
    isLoading: respondingSessionIds?.has(session.id) ?? false,
    unread: Boolean(session.unread),
    actions: rowActions(session),
  }))
  if (!overflow) return rows
  return [
    ...rows,
    {
      id: 'view-all',
      label: overflow.label ?? 'View all chats',
      href: overflow.href,
      prefetch,
      emphasis: true,
    },
  ]
}

export interface BuildSessionNavItemOptions<TIcon = unknown>
  extends BuildSessionSubItemsOptions<TIcon> {
  /** Nav id the product highlights against (`activeNavId === id`). */
  id?: string
  label?: string
  /** The product's icon component. Required — see `SessionRailNavItem.icon`. */
  icon: TIcon
  /** The expandable row's own destination — the full history page. */
  href: string
  /** Session currently open, highlighted inside the expandable. */
  activeSessionId?: string | null
  emptyLabel?: string
  defaultOpen?: boolean
}

/**
 * The rail's session entry: one expandable nav row whose sub-items are the
 * recent sessions. This is the structure the owner asked for — history lives IN
 * the rail, not in a second sidebar panel beside it.
 */
export function buildSessionNavItem<TIcon = unknown>({
  id = 'history',
  label = 'History',
  icon,
  href,
  activeSessionId,
  emptyLabel = 'No chats yet',
  defaultOpen = true,
  ...subItemOptions
}: BuildSessionNavItemOptions<TIcon>): SessionRailNavItem<TIcon> {
  return {
    id,
    icon,
    label,
    href,
    expandable: true,
    defaultOpen,
    subItems: buildSessionSubItems<TIcon>(subItemOptions),
    subActiveIds: activeSessionId ? [activeSessionId] : undefined,
    emptyLabel,
    prefetch: subItemOptions.prefetch ?? 'intent',
  }
}

// ---------------------------------------------------------------------------
// Routing / selection
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Bare segment name, so `reserved` accepts `'/settings'` or `'settings'`. */
function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/** Path with query + fragment removed and trailing slashes trimmed. A caller
 *  passing a full href instead of a pathname would otherwise match nothing. */
function normalizePath(pathname: string): string {
  const withoutHash = pathname.split('#')[0] ?? ''
  const withoutQuery = withoutHash.split('?')[0] ?? ''
  return stripTrailingSlashes(withoutQuery)
}

/** True when `path` is `prefix` or a segment-aligned descendant of it, so
 *  `/vault` never claims `/vault-archive`. */
function isUnderPrefix(path: string, prefix: string): boolean {
  const p = stripTrailingSlashes(prefix)
  if (p === '') return true
  return path === p || path.startsWith(`${p}/`)
}

export interface ActiveSessionIdOptions {
  pathname: string
  /** Workspace-scoped route base, e.g. `/app/ws_123`. */
  base: string
  /** Route segment sessions live under. Default `chat` ⇒ `${base}/chat/:id`.
   *  Pass `''` when sessions sit DIRECTLY under the base (`/app/:sessionId`),
   *  which is how one product routes them — then `reserved` is mandatory. */
  segment?: string
  /** Segment that means "composing a new session", not an id. Default `new`. */
  newSegment?: string
  /**
   * First segments that are OTHER routes, not session ids. Only meaningful
   * with `segment: ''`, where `/app/settings` is otherwise indistinguishable
   * from a session called `settings` — and resolving it as one would highlight
   * and prefetch a session that does not exist. Pass the product's own nav
   * paths; unknown-but-reserved is a routing bug, so this fails closed.
   */
  reserved?: readonly string[]
}

/**
 * The session id the current route has open, or `null` on the new-session
 * composer / anywhere else.
 *
 * Anchored at `base` on purpose. A bare `/\/chat\/([^/]+)/` scan — the shape
 * three products shipped — matches the FIRST `/chat/` anywhere in the path, so
 * a workspace or vault folder named `chat` resolves a neighbouring segment as a
 * session id and the rail highlights (and prefetches) a session the user is not
 * in. Same class as attaching to a stale box: it looks right and points at the
 * wrong row.
 */
export function activeSessionIdFromPath({
  pathname,
  base,
  segment = 'chat',
  newSegment = 'new',
  reserved,
}: ActiveSessionIdOptions): string | null {
  const path = normalizePath(pathname)
  const root = stripTrailingSlashes(base)
  const prefix = segment ? `${root}/${segment}` : root
  if (!isUnderPrefix(path, prefix) || path === prefix) return null
  const id = path.slice(prefix.length + 1).split('/')[0] ?? ''
  if (!id || id === newSegment) return null
  // `/app/settings` under a segment-less route is a sibling page, not a
  // session named "settings".
  if (reserved?.some((name) => stripSlashes(name) === id)) return null
  return decodeURIComponent(id)
}

/** One rail destination. `path` is relative to the workspace base. */
export interface NavRouteDef {
  id: string
  path: string
}

export interface ResolveActiveNavIdOptions {
  pathname: string
  base: string
  /** The product's rail rows, in any order — resolution is longest-prefix. */
  routes: NavRouteDef[]
  /** Extra prefixes that light an existing row: `{ '/agents': 'integrations' }`.
   *  Participates in the same longest-prefix contest. */
  aliases?: Record<string, string>
  /** Prefixes that deliberately highlight NOTHING, beating any shorter match.
   *  gtm uses this so an open chat lights no rail row while `/chat/new` still
   *  lights "New". */
  claimsNothing?: string[]
}

/**
 * The rail row to highlight for the current route.
 *
 * Longest-prefix wins, so declaration order cannot change the answer. The
 * per-product versions this replaces were first-match over an array, which made
 * `/chat/new` vs `/chat` an ordering accident rather than a rule.
 */
export function resolveActiveNavId({
  pathname,
  base,
  routes,
  aliases,
  claimsNothing,
}: ResolveActiveNavIdOptions): string | undefined {
  const path = normalizePath(pathname)
  const root = stripTrailingSlashes(base)
  let bestLength = -1
  let bestId: string | undefined
  const consider = (relative: string, id: string | undefined, winsTies = false) => {
    const full = stripTrailingSlashes(`${root}${relative}`)
    if (!isUnderPrefix(path, full)) return
    if (full.length > bestLength || (winsTies && full.length === bestLength)) {
      bestLength = full.length
      bestId = id
    }
  }
  for (const route of routes) consider(route.path, route.id)
  for (const [prefix, id] of Object.entries(aliases ?? {})) consider(prefix, id)
  // Declared last and wins an exact-length tie: naming a prefix in
  // `claimsNothing` is a deliberate override of the row that owns it, so
  // `claimsNothing: ['/chat']` beats a `{ id: 'chat', path: '/chat' }` row while
  // a longer `/chat/new` still wins on specificity.
  for (const prefix of claimsNothing ?? []) consider(prefix, undefined, true)
  return bestId
}

// ---------------------------------------------------------------------------
// Sidebar list composition
// ---------------------------------------------------------------------------

export interface ResolveSessionUnreadOptions {
  sessionId: string
  /** Server-computed unread from the route loader. */
  loaderUnread: boolean
  /** Live "went unread" ids from the workspace channel. */
  liveUnreadIds?: ReadonlySet<string>
  /** Ids this tab has already opened since the loader ran. */
  locallyReadIds?: ReadonlySet<string>
  /** The open session is never unread to its own viewer. */
  currentSessionId?: string | null
}

/**
 * Effective unread for one row. The loader's value can be stale — a layout
 * loader that survives same-workspace navigation keeps reporting a session as
 * unread after the user opened it — so live and local overlays win over it, and
 * the currently-open session always reads as read.
 */
export function resolveSessionUnread({
  sessionId,
  loaderUnread,
  liveUnreadIds,
  locallyReadIds,
  currentSessionId,
}: ResolveSessionUnreadOptions): boolean {
  if (sessionId === currentSessionId) return false
  if (liveUnreadIds?.has(sessionId)) return true
  if (locallyReadIds?.has(sessionId)) return false
  return loaderUnread
}

export interface ComposeSidebarSessionsOptions {
  /** Server-rendered rows, already ordered by the product's query. */
  loaderSessions: SessionSummary[]
  /** Optimistic rows from the live channel (a chat created in another tab). */
  optimisticSessions?: SessionSummary[]
  /** Rail cap. The full list lives on the history page. */
  limit: number
  /** Total sessions the product holds, used to decide the overflow row. */
  totalCount?: number
  liveUnreadIds?: ReadonlySet<string>
  locallyReadIds?: ReadonlySet<string>
  currentSessionId?: string | null
}

export interface ComposedSidebarSessions {
  sessions: SessionSummary[]
  /** More sessions exist than the rail shows ⇒ render the "view all" row. */
  hasMore: boolean
}

/**
 * The rail's session list: optimistic rows first, then the loader's, capped,
 * with unread resolved per row.
 *
 * Optimistic rows are deduped against the loader by id — once a revalidation
 * brings a live-created session back from the server it must not appear twice
 * (duplicate React keys, and the row's actions would target the same session
 * from two places).
 */
export function composeSidebarSessions({
  loaderSessions,
  optimisticSessions = [],
  limit,
  totalCount,
  liveUnreadIds,
  locallyReadIds,
  currentSessionId,
}: ComposeSidebarSessionsOptions): ComposedSidebarSessions {
  const loaderIds = new Set(loaderSessions.map((session) => session.id))
  const pendingNew = optimisticSessions.filter((session) => !loaderIds.has(session.id))
  const merged = [...pendingNew, ...loaderSessions]
  const sessions = merged.slice(0, Math.max(0, limit)).map((session) => ({
    ...session,
    unread: resolveSessionUnread({
      sessionId: session.id,
      loaderUnread: Boolean(session.unread),
      liveUnreadIds,
      locallyReadIds,
      currentSessionId,
    }),
  }))
  const known = (totalCount ?? loaderSessions.length) + pendingNew.length
  return { sessions, hasMore: known > sessions.length }
}

/**
 * Append a fetched page to held rows, dropping ids already shown. A session
 * bumped to the top between two page fetches otherwise arrives twice — once in
 * the page it moved out of and once in the page it moved into.
 */
export function mergeSessionPages(
  existing: SessionSummary[],
  incoming: SessionSummary[],
): SessionSummary[] {
  const seen = new Set(existing.map((session) => session.id))
  return [...existing, ...incoming.filter((session) => !seen.has(session.id))]
}

// ---------------------------------------------------------------------------
// Rail collapse cookie (SSR-seeded so the first paint matches the client)
// ---------------------------------------------------------------------------

export const DEFAULT_RAIL_COOKIE_NAME = 'agent-sidebar-rail-collapsed'

/**
 * Read the persisted rail-collapse state from a request's `Cookie` header, so
 * the server renders the rail in the state the user left it and the first
 * client render does not re-flow.
 *
 * Parses the header rather than building a `RegExp` from the cookie name (the
 * shape the products shipped): a name containing a regex metacharacter would
 * silently match the wrong cookie or none at all.
 */
export function readRailCollapsedCookie(
  cookieHeader: string | null | undefined,
  name: string = DEFAULT_RAIL_COOKIE_NAME,
): boolean {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() !== name) continue
    return pair.slice(eq + 1).trim() === '1'
  }
  return false
}

export interface RailCookieOptions {
  name?: string
  /** Seconds. Default one year. */
  maxAge?: number
  path?: string
  /** Omit to auto-detect: `secure` on https, off on http://localhost — a Secure
   *  cookie is dropped there and the rail state would not persist in dev. */
  secure?: boolean
}

/** The cookie string for a collapse state. Usable as `document.cookie` or as a
 *  `Set-Cookie` value. Exported separately so it is testable without a DOM. */
export function railCollapsedCookie(
  collapsed: boolean,
  { name = DEFAULT_RAIL_COOKIE_NAME, maxAge = 31_536_000, path = '/', secure }: RailCookieOptions = {},
): string {
  const isSecure =
    secure ?? (typeof location !== 'undefined' && location.protocol === 'https:')
  return `${name}=${collapsed ? '1' : '0'}; path=${path}; max-age=${maxAge}; samesite=lax${isSecure ? '; secure' : ''}`
}

/** Persist the rail-collapse state from the browser. No-op without a document
 *  so a shared toggle handler is safe to call during SSR. */
export function writeRailCollapsedCookie(collapsed: boolean, options: RailCookieOptions = {}): void {
  if (typeof document === 'undefined') return
  document.cookie = railCollapsedCookie(collapsed, options)
}
