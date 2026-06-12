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
 * product's access control, then mints its own URLs and capability tokens from
 * server configuration (`buildHttpMcpServer` + `createCapabilityToken` in
 * ../tools). A client can therefore never inject an arbitrary MCP url, header,
 * or token into the agent profile: the overlay's `mcp` values are typed as
 * {@link SurfaceMcpServer} (= the server-built `AppToolMcpServer` entry shape),
 * and only build() constructs them.
 */

import type { AppToolMcpServer } from '../tools/mcp'

/** Sandbox permission posture values, ranked deny > ask > allow for merging. */
export type SurfacePermissionValue = 'allow' | 'ask' | 'deny'

/** The only MCP entry shape an overlay may carry: the server-built bridge
 *  entry from ../tools/mcp (transport, url, headers, and capability token all
 *  assembled server-side). The alias exists so overlay authors reach for the
 *  builders in ../tools rather than hand-rolling `{ url: ctx.url }` shapes
 *  that would let request data become a dialable endpoint. */
export type SurfaceMcpServer = AppToolMcpServer

/** What one surface contributes to the agent profile for a single turn. */
export interface SurfaceOverlay {
  /** MCP servers to mount for this turn, keyed by tool-routing name. Names
   *  must not collide with the base profile's — see {@link mergeSurfaceOverlay}. */
  mcp?: Record<string, SurfaceMcpServer>
  /** Appended to the base system-prompt addendum with a blank-line separator. */
  promptAddendum?: string
  /** Per-key posture the surface wants for its turns. Merging is monotone
   *  fail-closed: the stricter of base/overlay wins, so a surface can tighten
   *  the workspace posture but never relax it. */
  permissions?: Record<string, SurfacePermissionValue>
}

/**
 * One registered surface kind. `TCtx` is the shape build() expects — a CLAIM
 * about the client payload, not a guarantee: the registry hands build() the
 * request's `ctx` unvalidated, so build() must treat every field as an
 * untrusted id (resolve it through access control that throws on a bad or
 * foreign id) before minting anything from it.
 */
export interface SurfaceKindDefinition<TCtx> {
  kind: string
  build: (ctx: TCtx) => SurfaceOverlay | Promise<SurfaceOverlay>
}

/** The variance-erased form a registry accepts (`build` is contravariant in
 *  `TCtx`, so every concrete definition is assignable to this). */
export type AnySurfaceKind = SurfaceKindDefinition<never>

/**
 * Declare one surface kind. The `kind` string is the client-visible routing
 * key (e.g. `'sequences'`); `build` is the server-side factory that turns a
 * validated ctx into the overlay for one turn.
 */
export function defineSurfaceKind<TCtx>(opts: {
  kind: string
  build: (ctx: TCtx) => SurfaceOverlay | Promise<SurfaceOverlay>
}): SurfaceKindDefinition<TCtx> {
  if (typeof opts.kind !== 'string' || opts.kind.length === 0 || /\s/.test(opts.kind)) {
    throw new Error(`surface kind must be a non-empty string without whitespace (got ${JSON.stringify(opts.kind)})`)
  }
  if (typeof opts.build !== 'function') {
    throw new Error(`surface kind '${opts.kind}' requires a build function`)
  }
  return { kind: opts.kind, build: opts.build }
}

export interface SurfaceRegistry {
  /** Build the overlay for one turn. Throws on an unknown kind — an unknown
   *  surface is a routing bug (client and server registries drifted), and
   *  silently returning an empty overlay would strip the surface's tools from
   *  the turn with no signal anywhere. Build errors propagate unwrapped. */
  resolve(kind: string, ctx: unknown): Promise<SurfaceOverlay>
}

/**
 * Assemble the product's surface registry from its registered kinds. Duplicate
 * kinds throw at construction: two builders behind one routing key would make
 * the mounted toolset depend on registration order.
 */
export function createSurfaceRegistry(kinds: readonly AnySurfaceKind[]): SurfaceRegistry {
  const byKind = new Map<string, AnySurfaceKind>()
  for (const definition of kinds) {
    if (byKind.has(definition.kind)) {
      throw new Error(`duplicate surface kind '${definition.kind}' — each kind must be registered exactly once`)
    }
    byKind.set(definition.kind, definition)
  }

  return {
    async resolve(kind, ctx) {
      const definition = byKind.get(kind)
      if (!definition) {
        const known = [...byKind.keys()].join(', ') || '(none)'
        throw new Error(
          `unknown surface kind '${kind}' — registered kinds: ${known}. ` +
            'An unknown surface is a routing bug: register the kind via defineSurfaceKind before clients can reference it.',
        )
      }
      // The trust boundary where static ctx typing ends: the request payload is
      // handed to build() as-is, and build() validates it (see SurfaceKindDefinition).
      const overlay = await definition.build(ctx as never)
      assertSurfaceOverlay(overlay, `surface kind '${kind}'`)
      return overlay
    },
  }
}

/** Base-profile slice the merge reads/writes. Real callers pass their full
 *  profile object; every field outside this slice passes through untouched. */
export interface SurfaceMergeBase {
  mcp?: Record<string, unknown>
  systemPromptAddendum?: string
  permissions?: Record<string, SurfacePermissionValue>
}

const PERMISSION_SEVERITY: Record<SurfacePermissionValue, number> = { allow: 0, ask: 1, deny: 2 }

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
export function mergeSurfaceOverlay<TBase extends SurfaceMergeBase>(
  base: TBase,
  overlay: SurfaceOverlay,
): TBase & SurfaceMergeBase {
  assertSurfaceOverlay(overlay, 'surface overlay')
  const merged: SurfaceMergeBase = { ...base }

  if (overlay.mcp && Object.keys(overlay.mcp).length > 0) {
    const baseMcp = base.mcp ?? {}
    const collisions = Object.keys(overlay.mcp).filter((name) => name in baseMcp)
    if (collisions.length > 0) {
      throw new Error(
        `surface overlay MCP name collision: ${collisions.map((n) => `'${n}'`).join(', ')} already exist on the base profile. ` +
          'Two servers cannot claim one name — give the surface server a distinct name.',
      )
    }
    merged.mcp = { ...baseMcp, ...overlay.mcp }
  }

  if (overlay.promptAddendum !== undefined) {
    merged.systemPromptAddendum = base.systemPromptAddendum
      ? `${base.systemPromptAddendum}\n\n${overlay.promptAddendum}`
      : overlay.promptAddendum
  }

  if (overlay.permissions && Object.keys(overlay.permissions).length > 0) {
    const permissions: Record<string, SurfacePermissionValue> = { ...(base.permissions ?? {}) }
    for (const [key, value] of Object.entries(overlay.permissions)) {
      const existing = permissions[key]
      permissions[key] =
        existing === undefined || PERMISSION_SEVERITY[value] > PERMISSION_SEVERITY[existing] ? value : existing
    }
    merged.permissions = permissions
  }

  // merged began as a shallow copy of base; only the three slice fields were
  // replaced, so the intersection type is the true shape.
  return merged as TBase & SurfaceMergeBase
}

/** Reject overlays a build() (or hand-rolled caller) malformed, with the exact
 *  field named: a relative MCP url, a blank addendum, or an off-vocabulary
 *  permission would otherwise surface only as an opaque sandbox failure. */
function assertSurfaceOverlay(overlay: SurfaceOverlay, label: string): void {
  if (overlay.promptAddendum !== undefined) {
    if (typeof overlay.promptAddendum !== 'string' || overlay.promptAddendum.trim().length === 0) {
      throw new Error(`${label}: promptAddendum must be a non-blank string when provided`)
    }
  }
  if (overlay.mcp !== undefined) {
    for (const [name, server] of Object.entries(overlay.mcp)) {
      if (name.trim().length === 0) throw new Error(`${label}: MCP server names must be non-empty`)
      if (server.transport !== 'http') {
        throw new Error(`${label}: MCP server '${name}' must use transport 'http' (got ${JSON.stringify((server as { transport?: unknown }).transport)})`)
      }
      let parsed: URL
      try {
        parsed = new URL(server.url)
      } catch {
        throw new Error(`${label}: MCP server '${name}' url must be an absolute URL (got ${JSON.stringify(server.url)})`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label}: MCP server '${name}' url must be http(s) (got ${JSON.stringify(server.url)})`)
      }
    }
  }
  if (overlay.permissions !== undefined) {
    for (const [key, value] of Object.entries(overlay.permissions)) {
      if (!(value in PERMISSION_SEVERITY)) {
        throw new Error(`${label}: permission '${key}' must be 'allow' | 'ask' | 'deny' (got ${JSON.stringify(value)})`)
      }
    }
  }
}
