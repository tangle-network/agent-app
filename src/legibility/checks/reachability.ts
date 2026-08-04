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

import { buildScannedFile, evidenceOf, type ScannedFile } from '../scan'
import { readFileSync } from 'node:fs'
import type { RawFinding, ReachabilityOptions } from '../types'

/** One route as declared, with its composed path. */
export interface RouteEntry {
  /** Full path from the root of the route table, no leading slash. */
  readonly path: string
  /** The route module, when the declaration names one. */
  readonly module: string | null
  /** Offset of the path literal in the route config, for file:line. */
  readonly offset: number
  /**
   * True when the declaration nests children. Such a route renders an Outlet
   * shell; the destination is its index child, whose path is the same string.
   * Asking a layout for its own door reports every product's `app` wrapper.
   */
  readonly isLayout: boolean
}

/** A path literal found in the source, reduced to what can be compared. */
interface LinkTarget {
  readonly raw: string
  readonly segments: readonly string[]
}

const ROUTE_CALL_RE = /(?<![\w$.])(route|index|layout|prefix)\s*\(/g

/** A route MODULE, not a path — `routes/app.settings.tsx`. */
const MODULE_LITERAL = /\.(tsx?|jsx?)$/

/**
 * Attributes whose value navigates. The suffix rule matters: a shared shell
 * takes the destination as a PROP (`settingsHref={…}`), so an exact list would
 * miss every door a layout component opens — measured, on the one attribute
 * that made a product's Settings screen look orphaned.
 */
const LINK_ATTRIBUTES = new Set(['to', 'href', 'action', 'redirect'])
const LINK_ATTRIBUTE_SUFFIX = /(href|url|link|route|path)$/i

/**
 * Calls whose first string argument is a destination. Matched on the full
 * dotted name OR its last segment, because the same navigation is written
 * `navigate(…)`, `router.push(…)` and `window.location.assign(…)`.
 */
const LINK_CALLS = new Set(['navigate', 'redirect', 'redirectdocument'])
const LINK_CALL_TAIL = new Set(['push', 'replace', 'assign', 'navigate', 'redirect'])

/** `location.href = '/app/settings'` — navigation without a call or a prop. */
const LOCATION_ASSIGN_RE = /\blocation\s*\.\s*href\s*=\s*/g

/**
 * Parse a `@react-router/dev/routes` config into composed route paths.
 *
 * Nesting is read from offset containment rather than from a grammar: a call
 * whose parentheses sit inside another call's is that call's child, which is
 * true of `route(p, m, [ route(…) ])` and needs no array bookkeeping.
 */
export function parseRouteConfig(file: ScannedFile): RouteEntry[] {
  const masked = file.scan.masked
  interface Call {
    readonly kind: string
    readonly start: number
    readonly end: number
    readonly args: readonly { value: string; start: number }[]
  }

  const calls: Call[] = []
  ROUTE_CALL_RE.lastIndex = 0
  for (const match of masked.matchAll(ROUTE_CALL_RE)) {
    const parenStart = (match.index ?? 0) + (match[0]?.length ?? 1) - 1
    const end = matchingParen(masked, parenStart)
    if (end === -1) continue
    const args = file.scan.segments
      .filter((segment) => segment.kind === 'string' && segment.start > parenStart && segment.end < end)
      .filter((segment) => topLevelArgument(masked, parenStart, segment.start))
      .map((segment) => ({ value: segment.value, start: segment.start }))
    calls.push({ kind: match[1] ?? '', start: match.index ?? 0, end, args })
  }

  const ancestorsOf = (call: Call): Call[] =>
    calls.filter((other) => other !== call && other.start < call.start && other.end > call.end)

  const entries: RouteEntry[] = []
  for (const call of calls) {
    if (call.kind !== 'route' && call.kind !== 'prefix') continue
    const own = call.args[0]
    if (own === undefined) continue
    // `route(pattern, 'routes/x.ts', …)` with a COMPUTED pattern puts the module
    // in first place. Its path is not in the source, so nothing here can decide
    // whether a door reaches it — reporting it would be a guess.
    if (MODULE_LITERAL.test(own.value)) continue
    const prefixParts = ancestorsOf(call)
      .filter((ancestor) => ancestor.kind === 'route' || ancestor.kind === 'prefix')
      .sort((left, right) => left.start - right.start)
      .map((ancestor) => ancestor.args[0]?.value ?? '')
    if (call.kind === 'prefix') continue
    entries.push({
      path: joinPath([...prefixParts, own.value]),
      module: call.args[1]?.value ?? null,
      offset: own.start,
      isLayout: calls.some((other) => other !== call && other.start > call.start && other.end < call.end),
    })
  }
  return entries
}

/**
 * Is this literal a top-level argument of the call, rather than a string nested
 * inside a child call or an object literal? Read by depth over the masked text.
 */
function topLevelArgument(masked: string, parenStart: number, at: number): boolean {
  let depth = 0
  for (let i = parenStart; i < at; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
  }
  return depth === 1
}

/** End of the statement starting at `from` — the next `;` or line break. */
function endOfStatement(masked: string, from: number): number {
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === ';' || ch === '\n') return i
  }
  return masked.length
}

function matchingParen(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function joinPath(parts: readonly string[]): string {
  return parts
    .flatMap((part) => part.split('/'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('/')
}

/** The comparable segments of a path: statics only, params and holes dropped. */
export function staticSegments(path: string): string[] {
  return path
    .replace(/\$\{[^}]*\}/g, '/*/')
    .split(/[/?#]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !segment.startsWith(':') && segment !== '*' && !segment.startsWith('$'))
}

/**
 * Does this literal look like a destination? Leading `/`, no whitespace, at
 * least one separator.
 *
 * ── Why ANY path literal counts as a door ────────────────────────────────────
 *
 * A destination is often assembled before it is used:
 *
 *     const tangleAuthUrl = hasRedirect ? `/auth/tangle/start?next=…` : '/auth/tangle/start'
 *     <AuthPage tangleAuthUrl={tangleAuthUrl} />
 *
 * No attribute holds the literal and no call takes it, so an attribute-and-call
 * rule reports a route the sign-in page plainly links. Counting every path
 * literal makes the claim stronger, not weaker: "no nav entry, no link, and no
 * literal in the whole source even names this path."
 *
 * Measured over two products at the moment this rule was adopted: it removed
 * the one remaining false positive and left all eight true positives standing
 * — the `/api/members` fetch does not mask the unreachable `app/:id/members`
 * screen, because a door must match the route's trailing segments and `api` is
 * not `app`.
 */
function pathLike(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 1 && trimmed.startsWith('/') && /^\/[\w:$@.{}\-/[\]]+$/.test(trimmed)
}

/** Every path literal in one file that could navigate somewhere. */
function linkTargets(file: ScannedFile): LinkTarget[] {
  const targets: LinkTarget[] = []
  const push = (raw: string): void => {
    const segments = staticSegments(raw)
    if (segments.length > 0) targets.push({ raw, segments })
  }

  for (const segment of file.scan.segments) {
    if (segment.kind !== 'jsx-attribute' && segment.kind !== 'template') continue
    const attribute = segment.attribute
    if (attribute === undefined) continue
    if (LINK_ATTRIBUTES.has(attribute.toLowerCase()) || LINK_ATTRIBUTE_SUFFIX.test(attribute)) push(segment.value)
  }

  const masked = file.scan.masked
  const callRe = /(?<![\w$.])([A-Za-z_$][\w$.]*)\s*\(/g
  for (const match of masked.matchAll(callRe)) {
    const name = (match[1] ?? '').toLowerCase()
    const tail = name.split('.').pop() ?? name
    if (!LINK_CALLS.has(name) && !LINK_CALL_TAIL.has(tail)) continue
    const parenStart = (match.index ?? 0) + (match[0]?.length ?? 1) - 1
    const end = matchingParen(masked, parenStart)
    // Every chunk of the argument, not just the first: a destination is written
    // `\`${base}/contracts/redline\`` and the naming half comes after the hole.
    for (const segment of file.scan.segments) {
      if (segment.kind !== 'string' && segment.kind !== 'template') continue
      if (segment.start < parenStart || (end !== -1 && segment.end > end)) continue
      push(segment.value)
    }
  }

  LOCATION_ASSIGN_RE.lastIndex = 0
  for (const match of masked.matchAll(LOCATION_ASSIGN_RE)) {
    const after = (match.index ?? 0) + (match[0]?.length ?? 0)
    const statementEnd = endOfStatement(masked, after)
    for (const segment of file.scan.segments) {
      if (segment.kind !== 'string' && segment.kind !== 'template') continue
      if (segment.start < after || segment.start >= statementEnd) continue
      push(segment.value)
    }
  }

  for (const segment of file.scan.segments) {
    if (segment.kind === 'comment') continue
    if (pathLike(segment.value)) push(segment.value)
  }
  return targets
}

/**
 * Every path-shaped literal in a navigation definition. A nav file is named by
 * the product and is small, so every string that looks like a path counts —
 * being generous here can only REMOVE findings, and a nav entry written as
 * `path: '/filings'` or `href="/filings"` must read the same way.
 */
function navTargets(file: ScannedFile): LinkTarget[] {
  const targets: LinkTarget[] = [...linkTargets(file)]
  for (const segment of file.scan.segments) {
    if (segment.kind !== 'string' && segment.kind !== 'template') continue
    const value = segment.value.trim()
    if (value.length === 0 || /\s/.test(value)) continue
    if (!/^[/$]/.test(value) && !value.includes('/')) continue
    const segments = staticSegments(value)
    if (segments.length > 0) targets.push({ raw: value, segments })
  }
  return targets
}

export interface ReachabilityInput {
  /** Every scanned product file — the source of in-source links. */
  readonly files: readonly ScannedFile[]
  readonly options: ReachabilityOptions
}

export interface ReachabilityResult {
  readonly findings: readonly RawFinding[]
  /** The route config, lexed — so the runner can apply its suppressions. */
  readonly routeFile: ScannedFile | null
  readonly routeCount: number
}

/** Run the unreachable-capability check over a whole product. */
export function checkReachability({ files, options }: ReachabilityInput): ReachabilityResult {
  const routeFile = options.routeConfigFile ? readScanned(options.routeConfigFile) : null
  const declared: RouteEntry[] = routeFile
    ? parseRouteConfig(routeFile)
    : (options.routePaths ?? []).map((path) => ({ path, module: null, offset: 0, isLayout: false }))
  if (declared.length === 0) return { findings: [], routeFile, routeCount: 0 }

  const navFiles = (options.navFiles ?? []).map((path) => readScanned(path)).filter(isScanned)
  const navPaths = navFiles.flatMap((file) => navTargets(file))
  const navSet = new Set(navFiles.map((file) => file.path))

  const product = files.filter((file) => !navSet.has(file.path) && file.path !== routeFile?.path)
  const routeModules = indexRouteModules(declared, product)
  const freeDoors = product
    .filter((file) => !routeModules.has(file.path))
    .flatMap((file) => linkTargets(file))

  const doors = reachableDoors({ files: product, navPaths, freeDoors, routeModules })
  const ignore = options.ignore ?? ['api/*']
  const ignoreNonTsx = options.ignoreNonTsxRoutes ?? true

  const findings: RawFinding[] = []
  for (const entry of declared) {
    if (entry.path.length === 0) continue
    if (entry.isLayout) continue
    if (ignore.some((pattern) => matchesIgnore(entry.path, pattern))) continue
    if (ignoreNonTsx && entry.module !== null && !entry.module.endsWith('.tsx')) continue

    const target = staticSegments(entry.path)
    if (target.length === 0) continue
    if (doors.some((door) => isSuffix(target, door.segments))) continue

    findings.push({
      check: 'unreachable-capability',
      offset: entry.offset,
      message: `Route "${entry.path}" is reachable by neither the navigation nor any link in the source — only by typing the URL.`,
      remedy:
        'Add it to the navigation, or link it from the screen a reader would look for it on. If it is deliberately unlisted (an internal tool, a deep link sent by email), suppress it with that reason.',
      evidence: routeFile ? evidenceOf(routeFile.text, entry.offset - 1, entry.offset + entry.path.length + 60, 90) : entry.path,
    })
  }

  return { findings, routeFile, routeCount: declared.length }
}

function isScanned(file: ScannedFile | null): file is ScannedFile {
  return file !== null
}

/**
 * Which scanned file implements which declared route. The route config names a
 * module relative to the app directory (`routes/app.workspace.contracts.tsx`)
 * and the scan walks from the product's source root, so the join is a path
 * suffix — no knowledge of the product's `appDirectory` needed.
 */
function indexRouteModules(
  declared: readonly RouteEntry[],
  files: readonly ScannedFile[],
): Map<string, RouteEntry[]> {
  const byFile = new Map<string, RouteEntry[]>()
  for (const entry of declared) {
    const module = entry.module
    if (module === null) continue
    const owner = files.find((file) => file.path === module || file.path.endsWith(`/${module}`))
    if (owner === undefined) continue
    const existing = byFile.get(owner.path)
    if (existing) existing.push(entry)
    else byFile.set(owner.path, [entry])
  }
  return byFile
}

interface ReachabilityWalk {
  readonly files: readonly ScannedFile[]
  readonly navPaths: readonly LinkTarget[]
  readonly freeDoors: readonly LinkTarget[]
  readonly routeModules: ReadonlyMap<string, RouteEntry[]>
}

/**
 * Every door the reader can actually arrive at, walked out from the navigation.
 * A route module's links join the set only after something already in the set
 * reaches that route — which is what makes an island of mutually-linked screens
 * report instead of vouching for itself.
 */
function reachableDoors({ files, navPaths, freeDoors, routeModules }: ReachabilityWalk): LinkTarget[] {
  const doors: LinkTarget[] = [...navPaths, ...freeDoors]
  const pending = files
    .filter((file) => routeModules.has(file.path))
    .map((file) => ({
      file,
      // A layout adds no path of its own and renders around every child, so it
      // opens as soon as anything is open at all.
      targets: (routeModules.get(file.path) ?? [])
        .filter((entry) => !entry.isLayout)
        .map((entry) => staticSegments(entry.path))
        .filter((parts) => parts.length > 0),
    }))

  let open = true
  while (open) {
    open = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i]
      if (candidate === undefined) continue
      const reached =
        candidate.targets.length === 0 ||
        candidate.targets.some((target) => doors.some((door) => isSuffix(target, door.segments)))
      if (!reached) continue
      pending.splice(i, 1)
      doors.push(...linkTargets(candidate.file))
      open = true
    }
  }

  return doors
}

function readScanned(path: string): ScannedFile | null {
  try {
    return buildScannedFile(path, readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Does the door's segment list end the route's? */
function isSuffix(route: readonly string[], door: readonly string[]): boolean {
  if (door.length === 0 || door.length > route.length) return false
  const offset = route.length - door.length
  return door.every((segment, index) => segment.toLowerCase() === (route[offset + index] ?? '').toLowerCase())
}

/** `api/*` matches `api/anything`; an exact string matches itself. */
function matchesIgnore(path: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1))
  return path === pattern
}
