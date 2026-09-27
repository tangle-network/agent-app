/**
 * Surface-scoped profile overlay — the seam letting any product page (a
 * sequence editor, a brief composer, a dataset view) add MCP servers, a prompt
 * addendum, and permission tightening to the workspace agent profile for turns
 * initiated FROM that surface, without the chat orchestrator knowing any
 * surface's specifics. The orchestrator resolves `(kind, ctx)` through a
 * registry the REQUEST HANDLER constructs per request (construction is a Map
 * build — cheap) and merges the result into the base profile it was about to
 * send to the sandbox. Per-request construction is the trust mechanism, not an
 * optimization target: each `build()` closes over server-trusted request state
 * (env bindings, secrets, the AUTHENTICATED user/workspace), which on Workers
 * exists only per request — a startup-built registry would force identity
 * through the untrusted client `ctx`.
 *
 * SECURITY INVARIANT: the surface `kind` and the ids inside `ctx` arrive on
 * the client request and are pure ROUTING data — never trusted content, never
 * identity. Identity comes from the closure (see above). The registered
 * `build()` runs server-side only: it validates the routing ids against the
 * product's access control, then mints its own URLs from server configuration
 * (`buildHttpMcpServer` in ../tools). A client can therefore never inject an
 * arbitrary MCP url, header, or credential into the agent profile: the
 * overlay's `mcp` values are typed as {@link SurfaceMcpServer} (= the
 * server-built `AppToolMcpServer` entry shape), and only build() constructs
 * them.
 *
 * The credential itself never appears in the overlay. Since the tagged-config
 * contract (`agent-interface` 0.38.0) the `Authorization` header is a
 * `secret-ref` naming a box-environment variable, which the sandbox resolves
 * privately; `build()` supplies that key NAME from server configuration and the
 * product writes the value through `SandboxRuntimeConfig.env` at creation or
 * refreshes it through `SandboxRuntimeConfig.runtimeEnv` before retained-box
 * bootstrap. The value remains workspace-scoped because every member and turn
 * shares the box; runtime renewal does not create a per-user secret channel.
 */
import type { AppToolMcpServer } from '../tools/mcp';
/** Sandbox permission posture values, ranked deny > ask > allow for merging. */
export type SurfacePermissionValue = 'allow' | 'ask' | 'deny';
/** The only MCP entry shape an overlay may carry: the server-built bridge
 *  entry from ../tools/mcp (transport, url, headers, and capability token all
 *  assembled server-side). The alias exists so overlay authors reach for the
 *  builders in ../tools rather than hand-rolling `{ url: ctx.url }` shapes
 *  that would let request data become a dialable endpoint. */
export type SurfaceMcpServer = AppToolMcpServer;
/** What one surface contributes to the agent profile for a single turn. */
export interface SurfaceOverlay {
    /** MCP servers to mount for this turn, keyed by tool-routing name. Names
     *  must not collide with the base profile's — see {@link mergeSurfaceOverlay}. */
    mcp?: Record<string, SurfaceMcpServer>;
    /** Appended to the base system-prompt addendum with a blank-line separator. */
    promptAddendum?: string;
    /** Per-key posture the surface wants for its turns. Merging is monotone
     *  fail-closed: the stricter of base/overlay wins, so a surface can tighten
     *  the workspace posture but never relax it. */
    permissions?: Record<string, SurfacePermissionValue>;
}
/**
 * One registered surface kind. `TCtx` is the shape build() expects — a CLAIM
 * about the client payload, not a guarantee: the registry hands build() the
 * request's `ctx` unvalidated, so build() must treat every field as an
 * untrusted id (resolve it through access control that throws on a bad or
 * foreign id) before minting anything from it.
 */
export interface SurfaceKindDefinition<TCtx> {
    kind: string;
    build: (ctx: TCtx) => SurfaceOverlay | Promise<SurfaceOverlay>;
}
/** The variance-erased form a registry accepts (`build` is contravariant in
 *  `TCtx`, so every concrete definition is assignable to this). */
export type AnySurfaceKind = SurfaceKindDefinition<never>;
/**
 * Declare one surface kind. The `kind` string is the client-visible routing
 * key (e.g. `'sequences'`); `build` is the server-side factory that turns a
 * validated ctx into the overlay for one turn.
 */
export declare function defineSurfaceKind<TCtx>(opts: {
    kind: string;
    build: (ctx: TCtx) => SurfaceOverlay | Promise<SurfaceOverlay>;
}): SurfaceKindDefinition<TCtx>;
/** Resolve and build the overlay for a given surface kind within a turn context */
export interface SurfaceRegistry {
    /** Build the overlay for one turn. Throws on an unknown kind — an unknown
     *  surface is a routing bug (client and server registries drifted), and
     *  silently returning an empty overlay would strip the surface's tools from
     *  the turn with no signal anywhere. Build errors propagate unwrapped. */
    resolve(kind: string, ctx: unknown): Promise<SurfaceOverlay>;
}
/**
 * Assemble the product's surface registry from its registered kinds. Duplicate
 * kinds throw at construction: two builders behind one routing key would make
 * the mounted toolset depend on registration order.
 */
export declare function createSurfaceRegistry(kinds: readonly AnySurfaceKind[]): SurfaceRegistry;
/** Base-profile slice the merge reads/writes. Real callers pass their full
 *  profile object; every field outside this slice passes through untouched. */
export interface SurfaceMergeBase {
    mcp?: Record<string, unknown>;
    systemPromptAddendum?: string;
    permissions?: Record<string, SurfacePermissionValue>;
}
/**
 * Merge one surface overlay into a base profile, returning a new object
 * (the base is never mutated; untouched nested records are shared by
 * reference).
 *
 * - `mcp`: overlay servers are added under their own names. A name already
 *   present on the base THROWS — a collision is two servers claiming one
 *   routing name, and renaming either silently would corrupt tool routing for
 *   whichever caller expected the original binding.
 * - `systemPromptAddendum`: the overlay's `promptAddendum` appends after a
 *   blank-line separator (no separator when the base has no addendum).
 * - `permissions`: per key the STRICTER value wins (deny > ask > allow). A
 *   surface can tighten the base posture for its turns; a base 'deny' survives
 *   any overlay.
 */
export declare function mergeSurfaceOverlay<TBase extends SurfaceMergeBase>(base: TBase, overlay: SurfaceOverlay): TBase & SurfaceMergeBase;
