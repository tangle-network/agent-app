/**
 * Nav destinations, and the guard that proves every href the rail renders
 * resolves to a route the product's router actually registered.
 *
 * A rail row's href is assembled from a base plus a relative path, and nothing
 * downstream re-checks it: the sidebar renders a link, the click navigates, and
 * the router answers 404. A unit test written against the nav builder alone
 * cannot catch that — it asserts the href the builder produced, which is the
 * same wrong string the user clicks.
 *
 * Two mechanisms, meant to be used together:
 *
 * 1. `NavDestination` makes the base a REQUIRED discriminant (`scope`). An
 *    optional `absolute?: boolean`-style flag has the opposite property:
 *    omitting it type-checks, and the destination silently resolves under the
 *    workspace prefix instead of the app-level one. A required literal union
 *    turns that omission into a compile error, and widening `TScope` demands a
 *    base for the new scope rather than defaulting to a wrong one.
 * 2. `assertNavHrefsRegistered` matches every resolved href against the route
 *    table, so a destination the router never registered fails a test instead
 *    of a user's click. It reads the product's real route table, so it cannot
 *    agree with the builder's mistake the way a hand-maintained expected-href
 *    list does.
 */

import { isUnderPrefix, normalizePath, stripTrailingSlashes, toRootedPath, toSegments } from './path'

// ---------------------------------------------------------------------------
// Destinations — the base is a required discriminant, never an optional flag
// ---------------------------------------------------------------------------

/** The bases a product routes rail rows under. `workspace` is the per-workspace
 *  prefix (`/app/ws_123`); `app` is the account-level one (`/app`), where
 *  singleton surfaces such as a shared terminal or billing live. */
export type NavScope = 'workspace' | 'app'

/** A base path per scope. Widening `TScope` widens this record, so a product
 *  that adds a scope cannot compile until it supplies that scope's base. */
export type NavScopeBases<TScope extends string = NavScope> = Readonly<Record<TScope, string>>

/** One rail destination as the product declares it, before a base is applied. */
export interface NavDestination<TScope extends string = NavScope> {
  id: string
  /** Path relative to the base named by `scope`. `''` is the base itself.
   *  Must be empty or start with `/` — a bare `'vault'` would concatenate into
   *  `/app/ws_123vault`, so it is rejected rather than silently repaired. */
  path: string
  /** Which base `path` resolves against. Required on purpose. */
  scope: TScope
}

/** A destination with its base applied. */
export interface ResolvedNavDestination<TScope extends string = NavScope> {
  id: string
  href: string
  scope: TScope
}

/** Apply a destination's scope base to its path.
 *
 *  Throws when the scope has no base configured — a product that assembles
 *  `bases` dynamically can defeat the type-level guarantee, and a missing base
 *  would otherwise produce `undefined/vault`. */
export function resolveNavHref<TScope extends string>(
  destination: NavDestination<TScope>,
  bases: NavScopeBases<TScope>,
): string {
  const base = bases[destination.scope]
  if (typeof base !== 'string') {
    throw new Error(
      `Nav destination '${destination.id}' uses scope '${destination.scope}', which has no configured base`,
    )
  }
  if (destination.path !== '' && !destination.path.startsWith('/')) {
    throw new Error(
      `Nav destination '${destination.id}' path must be empty or start with '/' (got '${destination.path}')`,
    )
  }
  const rooted = `${stripTrailingSlashes(base)}${destination.path}`
  return rooted === '' ? '/' : stripTrailingSlashes(rooted)
}

/** Apply the bases to every destination, preserving declaration order. */
export function resolveNavDestinations<TScope extends string>(
  destinations: readonly NavDestination<TScope>[],
  bases: NavScopeBases<TScope>,
): ResolvedNavDestination<TScope>[] {
  return destinations.map((destination) => ({
    id: destination.id,
    href: resolveNavHref(destination, bases),
    scope: destination.scope,
  }))
}

export interface ResolveScopedActiveNavIdOptions<TScope extends string = NavScope> {
  pathname: string
  destinations: readonly NavDestination<TScope>[]
  bases: NavScopeBases<TScope>
  /** Extra ABSOLUTE prefixes that light an existing row, e.g.
   *  `{ '/app/ws_1/agents': 'integrations' }`. Same longest-prefix contest. */
  aliases?: Readonly<Record<string, string>>
  /** ABSOLUTE prefixes that deliberately highlight nothing, beating any shorter
   *  match. */
  claimsNothing?: readonly string[]
}

/**
 * The rail row to highlight, across scopes.
 *
 * `resolveActiveNavId` resolves rows against ONE base, so an app-level row can
 * only be highlighted by a second, hand-rolled scan — the same split that lets
 * an app-level destination render under the workspace base. This resolves the
 * hrefs first and runs a single longest-prefix contest over absolute paths, so
 * declaration order cannot change the answer and no scope needs its own pass.
 *
 * Prefixes in `aliases` / `claimsNothing` are absolute here, unlike
 * `resolveActiveNavId`'s base-relative ones, because the contest itself is
 * absolute.
 */
export function resolveScopedActiveNavId<TScope extends string>({
  pathname,
  destinations,
  bases,
  aliases,
  claimsNothing,
}: ResolveScopedActiveNavIdOptions<TScope>): string | undefined {
  const path = normalizePath(pathname)
  let bestLength = -1
  let bestId: string | undefined
  const consider = (candidate: string, id: string | undefined, winsTies = false): void => {
    const full = stripTrailingSlashes(candidate)
    if (!isUnderPrefix(path, full)) return
    if (full.length > bestLength || (winsTies && full.length === bestLength)) {
      bestLength = full.length
      bestId = id
    }
  }
  for (const resolved of resolveNavDestinations(destinations, bases)) consider(resolved.href, resolved.id)
  for (const [prefix, id] of Object.entries(aliases ?? {})) consider(prefix, id)
  // Declared last and wins an exact-length tie: naming a prefix here is a
  // deliberate override of the row that owns it.
  for (const prefix of claimsNothing ?? []) consider(prefix, undefined, true)
  return bestId
}

// ---------------------------------------------------------------------------
// Route table — structurally the product's own router config
// ---------------------------------------------------------------------------

/**
 * One entry of a registered route table. Structurally compatible with
 * react-router's `RouteConfigEntry`, so a product passes its real `routes.ts`
 * default export straight in — the point of the guard is that it reads the
 * router's own truth rather than a second list that can agree with the bug.
 */
export interface RegisteredRoute {
  /** Absent on a pathless layout route: its children inherit the parent path. */
  path?: string
  index?: boolean
  children?: readonly RegisteredRoute[]
}

/** A route table entry is either a bare pattern string or a router config node. */
export type NavRouteTable = readonly (string | RegisteredRoute)[]

function joinPattern(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  if (child === '') return parent
  return `${parent}/${child}`
}

/**
 * Every path pattern the table registers, rooted and de-duplicated.
 *
 * Parent nodes contribute their own cumulative path as well as their children's:
 * a router matches a parent route with an index child at the parent path, and a
 * parent without one still matches with an empty outlet, so treating parents as
 * unregistered would flag working hrefs.
 */
export function flattenRouteTable(table: NavRouteTable): string[] {
  const patterns: string[] = []
  const walk = (entries: NavRouteTable, parent: string): void => {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        patterns.push(toRootedPath(joinPattern(parent, entry)))
        continue
      }
      const own = entry.path === undefined ? parent : joinPattern(parent, entry.path)
      patterns.push(toRootedPath(own))
      if (entry.children) walk(entry.children, own)
    }
  }
  walk(table, '')
  return [...new Set(patterns)]
}

/**
 * Whole-path segment match of a concrete path against one route pattern.
 *
 * Supports the three pattern forms a router uses: literal segments, `:param`
 * (exactly one non-empty segment), optional `:param?` / `segment?` (zero or
 * one), and a trailing `*` splat (zero or more). Matching is recursive because
 * an optional segment forks the walk — a linear scan silently mismatches
 * `/a/b` against `a/:x?/b`.
 */
function matchesPattern(pathSegments: readonly string[], patternSegments: readonly string[], caseSensitive: boolean): boolean {
  if (patternSegments.length === 0) return pathSegments.length === 0
  const head = patternSegments[0] ?? ''
  if (head === '*') return true
  const rest = patternSegments.slice(1)
  const optional = head.endsWith('?')
  const core = optional ? head.slice(0, -1) : head
  const first = pathSegments[0]
  if (first !== undefined) {
    const hit = core.startsWith(':')
      ? first.length > 0
      : caseSensitive
        ? core === first
        : core.toLowerCase() === first.toLowerCase()
    if (hit && matchesPattern(pathSegments.slice(1), rest, caseSensitive)) return true
  }
  return optional ? matchesPattern(pathSegments, rest, caseSensitive) : false
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * A nav row as the guard needs to see it. Structurally satisfied by
 * `SessionRailNavItem` / `SessionRailSubItem` and by sandbox-ui's
 * `SidebarLayoutNavItem`, so the guard runs over the builder's real output
 * rather than a re-declaration of it.
 */
export interface NavHrefItem {
  id: string
  href: string
  subItems?: readonly NavHrefItem[]
}

export type NavHrefProblemReason =
  /** No registered pattern matches the resolved href. */
  | 'unregistered'
  /** Empty, fragment-only, or not rooted at `/` — the row navigates nowhere
   *  predictable regardless of the route table. */
  | 'not-a-path'
  /** Leaves the router (scheme or protocol-relative) while `allowExternal` is
   *  off. */
  | 'external'

export interface NavHrefProblem {
  id: string
  href: string
  reason: NavHrefProblemReason
  /** Registered patterns ending in the same segment. A destination resolved
   *  under the wrong base lands here as its correctly-based twin, which is what
   *  names the missing scope in the failure message. */
  nearest: string[]
  message: string
}

export interface NavHrefReport {
  /** Hrefs examined, including nested sub-items. */
  checked: number
  problems: NavHrefProblem[]
  /** Off-router destinations accepted because `allowExternal` is on. */
  external: string[]
  /** The flattened route table the check ran against. */
  patterns: string[]
}

export interface NavHrefCheckOptions {
  /** Hrefs to skip, compared after query/fragment removal. For a destination
   *  served outside this route table (a static asset, another worker). */
  ignore?: readonly string[]
  /** Absolute URLs / `mailto:` / `tel:` are reported under `external` instead
   *  of failing. Default true. */
  allowExternal?: boolean
  /** Compare literal segments case-sensitively. Default true — a router that
   *  matches case-insensitively still renders a link the deploy's CDN or a
   *  case-sensitive origin may not. */
  caseSensitive?: boolean
}

/** `scheme:` or `//host` — anything the router will not resolve as a path. */
const OFF_ROUTER_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function flattenItems(items: readonly NavHrefItem[], out: NavHrefItem[] = []): NavHrefItem[] {
  for (const item of items) {
    out.push(item)
    if (item.subItems) flattenItems(item.subItems, out)
  }
  return out
}

/**
 * Check every nav href against the product's route table.
 *
 * Pure — returns the full report so a caller can assert on parts of it. Use
 * {@link assertNavHrefsRegistered} in tests; it turns the report into a failure
 * that names the offending row, its resolved href, and the near-miss pattern.
 */
export function checkNavHrefs(
  items: readonly NavHrefItem[],
  routes: NavRouteTable,
  options: NavHrefCheckOptions = {},
): NavHrefReport {
  const { ignore, allowExternal = true, caseSensitive = true } = options
  const patterns = flattenRouteTable(routes)
  const patternSegments = patterns.map((pattern) => ({ pattern, segments: toSegments(pattern) }))
  const ignored = new Set((ignore ?? []).map((href) => normalizePath(href)))
  const problems: NavHrefProblem[] = []
  const external: string[] = []
  const flat = flattenItems(items)
  let checked = 0

  for (const item of flat) {
    const raw = item.href
    const path = normalizePath(raw)
    if (ignored.has(path)) continue
    if (OFF_ROUTER_HREF.test(raw)) {
      if (allowExternal) {
        external.push(raw)
        continue
      }
      // Counted as checked: it was examined and rejected, so the vacuous-pass
      // guard must not read this run as "nothing was looked at".
      checked += 1
      problems.push({
        id: item.id,
        href: raw,
        reason: 'external',
        nearest: [],
        message: `Nav item '${item.id}' href '${raw}' leaves the router, and external destinations are rejected`,
      })
      continue
    }
    checked += 1
    if (raw === '' || raw.startsWith('#') || !raw.startsWith('/')) {
      problems.push({
        id: item.id,
        href: raw,
        reason: 'not-a-path',
        nearest: [],
        message: `Nav item '${item.id}' href '${raw}' is not a rooted path — it cannot resolve to a registered route`,
      })
      continue
    }
    const segments = toSegments(path)
    if (patternSegments.some((candidate) => matchesPattern(segments, candidate.segments, caseSensitive))) continue
    const nearest = nearestPatterns(segments, patternSegments.map((candidate) => candidate.pattern), caseSensitive)
    problems.push({
      id: item.id,
      href: raw,
      reason: 'unregistered',
      nearest,
      message:
        `Nav item '${item.id}' href '${raw}' matches no registered route` +
        (nearest.length ? ` — nearest registered: ${nearest.join(', ')}` : ''),
    })
  }

  return { checked, problems, external, patterns }
}

/** Registered patterns whose last segment equals the href's last segment: the
 *  same destination under a different base is the near-miss worth printing. */
function nearestPatterns(segments: readonly string[], patterns: readonly string[], caseSensitive: boolean): string[] {
  const tail = segments[segments.length - 1]
  if (tail === undefined) return []
  const same = (a: string, b: string): boolean => (caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase())
  return patterns
    .filter((pattern) => {
      const patternTail = toSegments(pattern).at(-1)
      return patternTail !== undefined && same(patternTail, tail)
    })
    .slice(0, 5)
}

/**
 * Fail unless every nav href resolves to a registered route.
 *
 * Throws on an empty item list or an empty route table as well: a guard that
 * examined nothing reports safety it does not provide, and both are what a
 * mis-wired import looks like.
 */
export function assertNavHrefsRegistered(
  items: readonly NavHrefItem[],
  routes: NavRouteTable,
  options: NavHrefCheckOptions = {},
): void {
  if (items.length === 0) {
    throw new Error('assertNavHrefsRegistered received no nav items — the check would pass without examining anything')
  }
  const report = checkNavHrefs(items, routes, options)
  if (report.patterns.length === 0) {
    throw new Error('assertNavHrefsRegistered received an empty route table — every href would fail or nothing would be proven')
  }
  // Real problems are reported before the vacuous-pass guard: rejected external
  // hrefs are problems that were never "checked", and the guard's message would
  // otherwise hide them.
  if (report.problems.length > 0) {
    const detail = report.problems.map((problem) => `  - ${problem.message}`).join('\n')
    throw new Error(
      `${report.problems.length} of ${report.checked} nav hrefs do not resolve to a registered route:\n${detail}\n` +
        `Registered patterns (${report.patterns.length}): ${report.patterns.join(', ')}`,
    )
  }
  if (report.checked === 0) {
    throw new Error(
      `assertNavHrefsRegistered examined 0 hrefs (${report.external.length} external, ${ignoredCount(items, options)} ignored) — the check would pass without examining anything`,
    )
  }
}

function ignoredCount(items: readonly NavHrefItem[], options: NavHrefCheckOptions): number {
  const ignored = new Set((options.ignore ?? []).map((href) => normalizePath(href)))
  return flattenItems(items).filter((item) => ignored.has(normalizePath(item.href))).length
}
