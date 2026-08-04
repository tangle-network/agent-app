/**
 * The nav-href guard.
 *
 * The defect class: a rail row whose href is built from the wrong base. It
 * renders, it looks right, the click 404s — and a unit test over the nav
 * builder asserts the SAME wrong string, so the suite certifies the bug. The
 * only check that can catch it compares the resolved href against the router's
 * own route table, which is what these tests exercise.
 */

import { describe, expect, it } from 'vitest'

import {
  assertNavHrefsRegistered,
  buildSessionNavItem,
  checkNavHrefs,
  flattenRouteTable,
  resolveNavDestinations,
  resolveNavHref,
  resolveScopedActiveNavId,
  type NavDestination,
  type NavHrefItem,
  type NavRouteTable,
  type NavScope,
  type NavScopeBases,
  type SessionRailNavItem,
} from '../../src/session-shell/index'

const BASES = { workspace: '/app/ws_123', app: '/app' } as const

/** The shape a product's router registers: nested config nodes, an `index`
 *  child at the parent path, `:params`, and a splat. Passed to the guard the
 *  way a product passes its own `routes.ts` default export. */
const ROUTES: NavRouteTable = [
  { path: 'login' },
  { path: 'api/auth/*' },
  {
    path: 'app',
    children: [
      { index: true },
      { path: 'billing' },
      { path: 'terminal' },
      { path: 'integrations' },
      {
        path: ':workspaceId',
        children: [
          { index: true },
          { path: 'chat/new' },
          { path: 'chat/:threadId' },
          { path: 'history' },
          { path: 'vault' },
          { path: 'filings' },
          { path: 'approvals' },
        ],
      },
    ],
  },
]

describe('flattenRouteTable', () => {
  it('roots every node, keeps parents, and folds index children onto the parent path', () => {
    const patterns = flattenRouteTable(ROUTES)
    expect(patterns).toContain('/login')
    expect(patterns).toContain('/app')
    expect(patterns).toContain('/app/terminal')
    expect(patterns).toContain('/app/:workspaceId')
    expect(patterns).toContain('/app/:workspaceId/chat/:threadId')
    // An index child adds nothing beyond the parent path it already registers.
    expect(patterns.filter((p) => p === '/app')).toHaveLength(1)
  })

  it('accepts bare pattern strings alongside config nodes', () => {
    expect(flattenRouteTable(['/health', 'metrics'])).toEqual(['/health', '/metrics'])
  })

  it('lets a pathless layout node pass its parent path to its children', () => {
    expect(flattenRouteTable([{ path: 'app', children: [{ children: [{ path: 'inner' }] }] }])).toEqual([
      '/app',
      '/app/inner',
    ])
  })
})

describe('resolveNavHref', () => {
  it('applies the scope base', () => {
    expect(resolveNavHref({ id: 'vault', path: '/vault', scope: 'workspace' }, BASES)).toBe('/app/ws_123/vault')
    expect(resolveNavHref({ id: 'terminal', path: '/terminal', scope: 'app' }, BASES)).toBe('/app/terminal')
  })

  it('resolves an empty path to the base itself', () => {
    expect(resolveNavHref({ id: 'overview', path: '', scope: 'workspace' }, BASES)).toBe('/app/ws_123')
  })

  it('throws on a path that is not rooted, rather than concatenating it into the base', () => {
    expect(() => resolveNavHref({ id: 'vault', path: 'vault', scope: 'workspace' }, BASES)).toThrow(
      /must be empty or start with/,
    )
  })

  it('throws when a dynamically built base map is missing the scope', () => {
    const partial = { workspace: '/app/ws_123' } as unknown as typeof BASES
    expect(() => resolveNavHref({ id: 'terminal', path: '/terminal', scope: 'app' }, partial)).toThrow(
      /no configured base/,
    )
  })
})

// ---------------------------------------------------------------------------
// The shipped defect, reproduced
// ---------------------------------------------------------------------------

describe('the wrong-base nav row', () => {
  /** The builder shape that shipped the bug: an OPTIONAL absolute flag. Omit
   *  it and the row silently resolves under the workspace prefix. */
  interface LegacyNavDef {
    id: string
    path: string
    absolute?: boolean
  }
  const legacyHref = (def: LegacyNavDef, base: string): string => (def.absolute ? `/app${def.path}` : `${base}${def.path}`)

  it('a builder test asserting the resolved href PASSES while the route 404s', () => {
    // `absolute: true` omitted — this is the whole defect.
    const broken: LegacyNavDef = { id: 'terminal', path: '/terminal' }
    // The unit test a product writes against its builder: green, and wrong.
    expect(legacyHref(broken, BASES.workspace)).toBe('/app/ws_123/terminal')
    // The router registers `/app/terminal`, so the row the user clicks 404s.
    expect(flattenRouteTable(ROUTES)).not.toContain('/app/ws_123/terminal')
  })

  it('the guard catches it and names the correctly-based route', () => {
    const items: NavHrefItem[] = [
      { id: 'vault', href: '/app/ws_123/vault' },
      { id: 'terminal', href: '/app/ws_123/terminal' },
    ]
    const report = checkNavHrefs(items, ROUTES)
    expect(report.checked).toBe(2)
    expect(report.problems).toHaveLength(1)
    const [problem] = report.problems
    expect(problem?.id).toBe('terminal')
    expect(problem?.reason).toBe('unregistered')
    expect(problem?.nearest).toContain('/app/terminal')
    expect(() => assertNavHrefsRegistered(items, ROUTES)).toThrow(/'terminal'.*\/app\/ws_123\/terminal/s)
    expect(() => assertNavHrefsRegistered(items, ROUTES)).toThrow(/nearest registered: \/app\/terminal/)
  })

  it('the required scope discriminant resolves the same row correctly', () => {
    const destinations: NavDestination[] = [
      { id: 'overview', path: '', scope: 'workspace' },
      { id: 'vault', path: '/vault', scope: 'workspace' },
      { id: 'terminal', path: '/terminal', scope: 'app' },
    ]
    const resolved = resolveNavDestinations(destinations, BASES)
    expect(resolved.map((r) => r.href)).toEqual(['/app/ws_123', '/app/ws_123/vault', '/app/terminal'])
    expect(() => assertNavHrefsRegistered(resolved, ROUTES)).not.toThrow()
  })

  it('a destination cannot omit its scope — the omission is a compile error, not a wrong href', () => {
    // @ts-expect-error `scope` is required. With an optional `absolute?` flag
    // this same object compiles and resolves under the wrong base.
    const missingScope: NavDestination = { id: 'terminal', path: '/terminal' }
    expect(missingScope.id).toBe('terminal')
  })

  it('adding a scope demands its base', () => {
    type WithAdmin = NavScope | 'admin'
    // @ts-expect-error the base map must cover every scope in the union.
    const incomplete: NavScopeBases<WithAdmin> = { workspace: '/app/ws_123', app: '/app' }
    const complete: NavScopeBases<WithAdmin> = { ...incomplete, admin: '/admin' }
    expect(resolveNavHref({ id: 'audit', path: '/audit', scope: 'admin' }, complete)).toBe('/admin/audit')
  })

  it('mis-scoping a destination is caught by the same guard', () => {
    const destinations: NavDestination[] = [{ id: 'terminal', path: '/terminal', scope: 'workspace' }]
    const resolved = resolveNavDestinations(destinations, BASES)
    expect(() => assertNavHrefsRegistered(resolved, ROUTES)).toThrow(/matches no registered route/)
  })
})

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('checkNavHrefs matching', () => {
  const check = (href: string): ReturnType<typeof checkNavHrefs> => checkNavHrefs([{ id: 'x', href }], ROUTES)
  const problems = (href: string): number => check(href).problems.length

  it('matches a :param segment against a real id', () => {
    expect(problems('/app/ws_123/chat/thr_9')).toBe(0)
  })

  it('rejects a :param segment with nothing in it', () => {
    expect(problems('/app/ws_123/chat/')).toBe(1)
  })

  it('requires the WHOLE path to be consumed — a registered prefix is not a match', () => {
    expect(problems('/app/ws_123/vault/folder/deep')).toBe(1)
  })

  it('matches a trailing splat, including with zero segments after it', () => {
    expect(problems('/api/auth/callback/tangle')).toBe(0)
    expect(problems('/api/auth')).toBe(0)
  })

  it('ignores a query string and a fragment on the href', () => {
    expect(problems('/app/ws_123/vault?tab=recent#top')).toBe(0)
  })

  it('tolerates a trailing slash', () => {
    expect(problems('/app/ws_123/vault/')).toBe(0)
  })

  it('is case-sensitive by default and configurable', () => {
    expect(problems('/app/ws_123/Vault')).toBe(1)
    expect(checkNavHrefs([{ id: 'x', href: '/app/ws_123/Vault' }], ROUTES, { caseSensitive: false }).problems).toHaveLength(0)
  })

  it('matches an optional segment with and without it', () => {
    const optional: NavRouteTable = ['reports/:period?']
    expect(checkNavHrefs([{ id: 'a', href: '/reports' }], optional).problems).toHaveLength(0)
    expect(checkNavHrefs([{ id: 'b', href: '/reports/q3' }], optional).problems).toHaveLength(0)
    expect(checkNavHrefs([{ id: 'c', href: '/reports/q3/detail' }], optional).problems).toHaveLength(1)
  })

  it('flags a row that navigates nowhere', () => {
    expect(check('#').problems[0]?.reason).toBe('not-a-path')
    expect(check('').problems[0]?.reason).toBe('not-a-path')
    expect(check('vault').problems[0]?.reason).toBe('not-a-path')
  })

  it('reports an off-router destination separately, and rejects it on request', () => {
    const items: NavHrefItem[] = [
      { id: 'docs', href: 'https://docs.example.com' },
      { id: 'mail', href: 'mailto:help@example.com' },
    ]
    const allowed = checkNavHrefs(items, ROUTES)
    expect(allowed.external).toEqual(['https://docs.example.com', 'mailto:help@example.com'])
    expect(allowed.problems).toHaveLength(0)
    expect(allowed.checked).toBe(0)
    const rejected = checkNavHrefs(items, ROUTES, { allowExternal: false })
    expect(rejected.problems.map((p) => p.reason)).toEqual(['external', 'external'])
    // Rejected externals were examined, so the assert reports THEM rather than
    // the vacuous-pass guard swallowing the real failures.
    expect(rejected.checked).toBe(2)
    expect(() => assertNavHrefsRegistered(items, ROUTES, { allowExternal: false })).toThrow(
      /2 of 2 nav hrefs do not resolve/,
    )
  })

  it('an ignored href is skipped even when it points off the router', () => {
    const report = checkNavHrefs([{ id: 'docs', href: 'https://docs.example.com' }], ROUTES, {
      allowExternal: false,
      ignore: ['https://docs.example.com'],
    })
    expect(report.problems).toHaveLength(0)
    expect(report.checked).toBe(0)
  })

  it('skips an explicitly ignored href without counting it as checked', () => {
    const report = checkNavHrefs([{ id: 'legacy', href: '/legacy/portal' }], ROUTES, { ignore: ['/legacy/portal'] })
    expect(report.checked).toBe(0)
    expect(report.problems).toHaveLength(0)
  })
})

describe('assertNavHrefsRegistered refuses to pass vacuously', () => {
  it('throws when there are no nav items', () => {
    expect(() => assertNavHrefsRegistered([], ROUTES)).toThrow(/no nav items/)
  })

  it('throws when the route table is empty', () => {
    expect(() => assertNavHrefsRegistered([{ id: 'a', href: '/app' }], [])).toThrow(/empty route table/)
  })

  it('throws when every href was skipped or external', () => {
    expect(() =>
      assertNavHrefsRegistered([{ id: 'docs', href: 'https://docs.example.com' }], ROUTES),
    ).toThrow(/examined 0 hrefs/)
  })
})

// ---------------------------------------------------------------------------
// It runs over the rail's real output
// ---------------------------------------------------------------------------

describe('the guard consumes the shell builder output directly', () => {
  it('checks the expandable row AND its session sub-items', () => {
    const railItem: SessionRailNavItem<string> = buildSessionNavItem<string>({
      icon: 'history-icon',
      href: `${BASES.workspace}/history`,
      sessions: [
        { id: 'thr_1', title: 'One', updatedAt: null },
        { id: 'thr_2', title: 'Two', updatedAt: null },
      ],
      hrefForSession: (id) => `${BASES.workspace}/chat/${id}`,
      overflow: { href: `${BASES.workspace}/history` },
    })
    // SessionRailNavItem satisfies NavHrefItem structurally — no re-declaration.
    const report = checkNavHrefs([railItem], ROUTES)
    expect(report.checked).toBe(4)
    expect(report.problems).toEqual([])
  })

  it('catches a session href built from the wrong base', () => {
    const railItem: SessionRailNavItem<string> = buildSessionNavItem<string>({
      icon: 'history-icon',
      href: `${BASES.workspace}/history`,
      sessions: [{ id: 'thr_1', title: 'One', updatedAt: null }],
      // The app-level base, where no chat route is registered.
      hrefForSession: (id) => `${BASES.app}/chat/${id}`,
    })
    expect(() => assertNavHrefsRegistered([railItem], ROUTES)).toThrow(/'thr_1'.*\/app\/chat\/thr_1/s)
  })
})

// ---------------------------------------------------------------------------
// Highlighting across scopes
// ---------------------------------------------------------------------------

describe('resolveScopedActiveNavId', () => {
  const destinations: NavDestination[] = [
    { id: 'new', path: '/chat/new', scope: 'workspace' },
    { id: 'overview', path: '', scope: 'workspace' },
    { id: 'vault', path: '/vault', scope: 'workspace' },
    { id: 'terminal', path: '/terminal', scope: 'app' },
    { id: 'billing', path: '/billing', scope: 'app' },
  ]

  it('highlights a workspace row and an app row from one contest', () => {
    expect(resolveScopedActiveNavId({ pathname: '/app/ws_123/vault', destinations, bases: BASES })).toBe('vault')
    expect(resolveScopedActiveNavId({ pathname: '/app/terminal', destinations, bases: BASES })).toBe('terminal')
  })

  it('prefers the longest prefix regardless of declaration order', () => {
    expect(resolveScopedActiveNavId({ pathname: '/app/ws_123/chat/new', destinations, bases: BASES })).toBe('new')
  })

  it('does not let the app base claim a workspace route', () => {
    // `/app` is a prefix of `/app/ws_123/...`, but no app-scoped row is rooted
    // at the bare base, so the workspace overview wins.
    expect(resolveScopedActiveNavId({ pathname: '/app/ws_123', destinations, bases: BASES })).toBe('overview')
  })

  it('does not let a sibling segment claim a row', () => {
    expect(resolveScopedActiveNavId({ pathname: '/app/terminal-archive', destinations, bases: BASES })).toBeUndefined()
  })

  it('honours absolute aliases and claims-nothing prefixes', () => {
    expect(
      resolveScopedActiveNavId({
        pathname: '/app/ws_123/agents/x',
        destinations,
        bases: BASES,
        aliases: { '/app/ws_123/agents': 'vault' },
      }),
    ).toBe('vault')
    expect(
      resolveScopedActiveNavId({
        pathname: '/app/ws_123/vault',
        destinations,
        bases: BASES,
        claimsNothing: ['/app/ws_123/vault'],
      }),
    ).toBeUndefined()
  })
})
