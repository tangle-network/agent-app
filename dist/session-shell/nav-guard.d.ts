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
/** The bases a product routes rail rows under. `workspace` is the per-workspace
 *  prefix (`/app/ws_123`); `app` is the account-level one (`/app`), where
 *  singleton surfaces such as a shared terminal or billing live. */
export type NavScope = 'workspace' | 'app';
/** A base path per scope. Widening `TScope` widens this record, so a product
 *  that adds a scope cannot compile until it supplies that scope's base. */
export type NavScopeBases<TScope extends string = NavScope> = Readonly<Record<TScope, string>>;
/** One rail destination as the product declares it, before a base is applied. */
export interface NavDestination<TScope extends string = NavScope> {
    id: string;
    /** Path relative to the base named by `scope`. `''` is the base itself.
     *  Must be empty or start with `/` — a bare `'vault'` would concatenate into
     *  `/app/ws_123vault`, so it is rejected rather than silently repaired. */
    path: string;
    /** Which base `path` resolves against. Required on purpose. */
    scope: TScope;
}
/** A destination with its base applied. */
export interface ResolvedNavDestination<TScope extends string = NavScope> {
    id: string;
    href: string;
    scope: TScope;
}
/** Apply a destination's scope base to its path.
 *
 *  Throws when the scope has no base configured — a product that assembles
 *  `bases` dynamically can defeat the type-level guarantee, and a missing base
 *  would otherwise produce `undefined/vault`. */
export declare function resolveNavHref<TScope extends string>(destination: NavDestination<TScope>, bases: NavScopeBases<TScope>): string;
/** Apply the bases to every destination, preserving declaration order. */
export declare function resolveNavDestinations<TScope extends string>(destinations: readonly NavDestination<TScope>[], bases: NavScopeBases<TScope>): ResolvedNavDestination<TScope>[];
export interface ResolveScopedActiveNavIdOptions<TScope extends string = NavScope> {
    pathname: string;
    destinations: readonly NavDestination<TScope>[];
    bases: NavScopeBases<TScope>;
    /** Extra ABSOLUTE prefixes that light an existing row, e.g.
     *  `{ '/app/ws_1/agents': 'integrations' }`. Same longest-prefix contest. */
    aliases?: Readonly<Record<string, string>>;
    /** ABSOLUTE prefixes that deliberately highlight nothing, beating any shorter
     *  match. */
    claimsNothing?: readonly string[];
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
export declare function resolveScopedActiveNavId<TScope extends string>({ pathname, destinations, bases, aliases, claimsNothing, }: ResolveScopedActiveNavIdOptions<TScope>): string | undefined;
/**
 * One entry of a registered route table. Structurally compatible with
 * react-router's `RouteConfigEntry`, so a product passes its real `routes.ts`
 * default export straight in — the point of the guard is that it reads the
 * router's own truth rather than a second list that can agree with the bug.
 */
export interface RegisteredRoute {
    /** Absent on a pathless layout route: its children inherit the parent path. */
    path?: string;
    index?: boolean;
    children?: readonly RegisteredRoute[];
}
/** A route table entry is either a bare pattern string or a router config node. */
export type NavRouteTable = readonly (string | RegisteredRoute)[];
/**
 * Every path pattern the table registers, rooted and de-duplicated.
 *
 * Parent nodes contribute their own cumulative path as well as their children's:
 * a router matches a parent route with an index child at the parent path, and a
 * parent without one still matches with an empty outlet, so treating parents as
 * unregistered would flag working hrefs.
 */
export declare function flattenRouteTable(table: NavRouteTable): string[];
/**
 * A nav row as the guard needs to see it. Structurally satisfied by
 * `SessionRailNavItem` / `SessionRailSubItem` and by sandbox-ui's
 * `SidebarLayoutNavItem`, so the guard runs over the builder's real output
 * rather than a re-declaration of it.
 */
export interface NavHrefItem {
    id: string;
    href: string;
    subItems?: readonly NavHrefItem[];
}
export type NavHrefProblemReason = 
/** No registered pattern matches the resolved href. */
'unregistered'
/** Empty, fragment-only, or not rooted at `/` — the row navigates nowhere
 *  predictable regardless of the route table. */
 | 'not-a-path'
/** Leaves the router (scheme or protocol-relative) while `allowExternal` is
 *  off. */
 | 'external';
export interface NavHrefProblem {
    id: string;
    href: string;
    reason: NavHrefProblemReason;
    /** Registered patterns ending in the same segment. A destination resolved
     *  under the wrong base lands here as its correctly-based twin, which is what
     *  names the missing scope in the failure message. */
    nearest: string[];
    message: string;
}
export interface NavHrefReport {
    /** Hrefs examined, including nested sub-items. */
    checked: number;
    problems: NavHrefProblem[];
    /** Off-router destinations accepted because `allowExternal` is on. */
    external: string[];
    /** The flattened route table the check ran against. */
    patterns: string[];
}
export interface NavHrefCheckOptions {
    /** Hrefs to skip, compared after query/fragment removal. For a destination
     *  served outside this route table (a static asset, another worker). */
    ignore?: readonly string[];
    /** Absolute URLs / `mailto:` / `tel:` are reported under `external` instead
     *  of failing. Default true. */
    allowExternal?: boolean;
    /** Compare literal segments case-sensitively. Default true — a router that
     *  matches case-insensitively still renders a link the deploy's CDN or a
     *  case-sensitive origin may not. */
    caseSensitive?: boolean;
}
/**
 * Check every nav href against the product's route table.
 *
 * Pure — returns the full report so a caller can assert on parts of it. Use
 * {@link assertNavHrefsRegistered} in tests; it turns the report into a failure
 * that names the offending row, its resolved href, and the near-miss pattern.
 */
export declare function checkNavHrefs(items: readonly NavHrefItem[], routes: NavRouteTable, options?: NavHrefCheckOptions): NavHrefReport;
/**
 * Fail unless every nav href resolves to a registered route.
 *
 * Throws on an empty item list or an empty route table as well: a guard that
 * examined nothing reports safety it does not provide, and both are what a
 * mis-wired import looks like.
 */
export declare function assertNavHrefsRegistered(items: readonly NavHrefItem[], routes: NavRouteTable, options?: NavHrefCheckOptions): void;
