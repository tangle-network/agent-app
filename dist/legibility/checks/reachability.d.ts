/**
 * Check 5 — a capability with no door.
 *
 * Two deterministic engines shipped in this fleet with no way to reach them: a
 * contract redline that cites statutes, and a court-deadline calculator with 59
 * golden tests. Both correct, both routed, neither in the navigation and
 * neither linked from any screen. The only way to open them was to type the URL.
 * No test failed, because every test was about the engine.
 *
 * This check joins two things a product already has — its route table and its
 * navigation definition — and reports the routes that neither the navigation
 * nor any link in the source reaches.
 *
 * ── Matching, and why it is by STATIC SEGMENTS ───────────────────────────────
 *
 * Links are written against a base that is computed at runtime:
 *
 *     route('contracts/redline', …)   under   route(':workspaceId', …) under route('app', …)
 *     <Link to={`${base}/contracts/redline`}>            base = `/app/${workspaceId}`
 *
 * Comparing strings finds nothing. So both sides are reduced to their STATIC
 * segments — parameters and `${…}` holes drop out — and a link reaches a route
 * when the link's segments are a suffix of the route's:
 *
 *     route  app/:workspaceId/contracts/redline  →  [app, contracts, redline]
 *     link   `${base}/contracts/redline`         →  [contracts, redline]  ✓ suffix
 *     link   `${base}/contracts`                 →  [contracts]           ✗ (matches the parent, not this)
 *
 * The suffix rule is what makes the check usable without resolving `base`, and
 * the cost is a known blind spot: a detail route (`reviews/:id`) has the same
 * static segments as its list route, so a link to the list marks the detail
 * reachable. That is a missed defect, never a false alarm — the deliberate
 * direction for a gate that only survives if its reports are all real.
 *
 * ── Reachable FROM THE NAVIGATION, not merely linked ─────────────────────────
 *
 * A link is only a door if the screen holding it can itself be opened. The
 * shipped defect is an ISLAND: a contract list, a contract detail page and a
 * statute-citing redline engine, each linking the other two, and no navigation
 * entry pointing at any of them. Every route in it has an inbound link, so a
 * check that asks "does a link exist?" reports nothing at all — which is what
 * happened, and the redline shipped unreachable.
 *
 * So doors are resolved transitively from the navigation:
 *
 *   - a nav file's path literals are roots;
 *   - so is a link in a file that is NOT a route module (a shared component, a
 *     header, an index route) — it could be rendered anywhere, and assuming it
 *     is always available is the direction that removes findings rather than
 *     inventing them;
 *   - a link inside a ROUTE module counts only once that route is itself
 *     reachable, and the pass repeats to a fixpoint.
 *
 * An island therefore reports every route in it, which is right: one nav entry
 * clears them all, and naming only the entry route would hide how much shipped
 * behind it.
 *
 * ── What is not a screen ─────────────────────────────────────────────────────
 *
 * `index()` and `layout()` add no path of their own. A route whose module is
 * not `.tsx` is a resource endpoint (the react-router convention) and is
 * skipped by default, as is anything under `ignore` (default `api/*`).
 */
import { type ScannedFile } from '../scan';
import type { RawFinding, ReachabilityOptions } from '../types';
/** One route as declared, with its composed path. */
export interface RouteEntry {
    /** Full path from the root of the route table, no leading slash. */
    readonly path: string;
    /** The route module, when the declaration names one. */
    readonly module: string | null;
    /** Offset of the path literal in the route config, for file:line. */
    readonly offset: number;
    /**
     * True when the declaration nests children. Such a route renders an Outlet
     * shell; the destination is its index child, whose path is the same string.
     * Asking a layout for its own door reports every product's `app` wrapper.
     */
    readonly isLayout: boolean;
}
/**
 * Parse a `@react-router/dev/routes` config into composed route paths.
 *
 * Nesting is read from offset containment rather than from a grammar: a call
 * whose parentheses sit inside another call's is that call's child, which is
 * true of `route(p, m, [ route(…) ])` and needs no array bookkeeping.
 */
export declare function parseRouteConfig(file: ScannedFile): RouteEntry[];
/** The comparable segments of a path: statics only, params and holes dropped. */
export declare function staticSegments(path: string): string[];
export interface ReachabilityInput {
    /** Every scanned product file — the source of in-source links. */
    readonly files: readonly ScannedFile[];
    readonly options: ReachabilityOptions;
}
export interface ReachabilityResult {
    readonly findings: readonly RawFinding[];
    /** The route config, lexed — so the runner can apply its suppressions. */
    readonly routeFile: ScannedFile | null;
    readonly routeCount: number;
}
/** Run the unreachable-capability check over a whole product. */
export declare function checkReachability({ files, options }: ReachabilityInput): ReachabilityResult;
