/**
 * Does the shell actually carry all four products, or only the one it was
 * lifted from?
 *
 * Every fixture below is a product's REAL loader row and REAL route shape, read
 * off the shipped source, not a shape invented to fit this API:
 *
 *   gtm       src/routes/app.workspace.tsx        {id,title,category,updatedAt,isPinned,unread}   /app/:workspaceId/chat/:threadId
 *   legal     src/routes/app.workspace.tsx        {id,title,category,isPinned,updatedAt}          /app/:workspaceId/chat/:threadId
 *   creative  src/routes/app.workspace.tsx        {id,title,createdAt}                            /app/:workspaceId/chat
 *   tax       apps/web/src/routes/app.tsx         {id,name,taxYear,status,updatedAt}              /app/:sessionId
 *
 * The point is the ones that DON'T look like gtm. creative selects `createdAt`
 * and has no unread column at all; tax calls the title `name` and mounts
 * sessions directly under `/app` with no `chat` segment, so `/app/settings` sits
 * in the same position a session id does. A shell that only carries gtm is a
 * shell that will be forked again.
 */

import { describe, expect, it } from 'vitest'

import {
  activeSessionIdFromPath,
  buildSessionNavItem,
  composeSidebarSessions,
  resolveActiveNavId,
  sessionLabel,
  type SessionSummary,
} from '../../src/session-shell/index'

const ICON = 'icon' as const

// --------------------------------------------------------------------------
// gtm — threads under /app/:workspaceId/chat/:threadId
// --------------------------------------------------------------------------

describe('gtm-agent', () => {
  const base = '/app/ws_gtm'
  const rows = [
    { id: 't1', title: 'Q3 pipeline', category: 'research', updatedAt: new Date('2026-07-24T10:00:00Z'), isPinned: true, unread: 1 },
    { id: 't2', title: 'Outreach seq', category: null, updatedAt: new Date('2026-07-23T10:00:00Z'), isPinned: false, unread: 0 },
  ]
  const toSummary = (r: (typeof rows)[number]): SessionSummary => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
    category: r.category,
    isPinned: r.isPinned,
    unread: r.unread === 1,
  })

  it('maps the loader row and keeps the unread bit', () => {
    const { sessions, hasMore } = composeSidebarSessions({
      loaderSessions: rows.map(toSummary),
      limit: 20,
      totalCount: 34,
      currentSessionId: 't2',
    })
    expect(sessions.map((s) => [s.id, s.unread])).toEqual([['t1', true], ['t2', false]])
    expect(hasMore).toBe(true) // 34 total > 2 shown ⇒ the "View all" row
  })

  it('resolves the open thread and lights no rail row for it', () => {
    expect(activeSessionIdFromPath({ pathname: `${base}/chat/t1`, base })).toBe('t1')
    const routes = [
      { id: 'new', path: '/chat/new' },
      { id: 'vault', path: '/vault' },
      { id: 'history', path: '/history' },
    ]
    expect(resolveActiveNavId({ pathname: `${base}/chat/t1`, base, routes, claimsNothing: ['/chat'] })).toBeUndefined()
    expect(resolveActiveNavId({ pathname: `${base}/chat/new`, base, routes, claimsNothing: ['/chat'] })).toBe('new')
    // gtm routes /agents onto the Integrations row.
    expect(
      resolveActiveNavId({
        pathname: `${base}/agents`,
        base,
        routes: [...routes, { id: 'integrations', path: '/integrations' }],
        aliases: { '/agents': 'integrations' },
      }),
    ).toBe('integrations')
  })
})

// --------------------------------------------------------------------------
// legal — same route shape, no unread column
// --------------------------------------------------------------------------

describe('legal-agent', () => {
  const base = '/app/ws_legal'
  const rows = [
    { id: 'm1', title: 'Acme MSA redline', category: 'contracts', isPinned: false, updatedAt: new Date('2026-07-24T09:00:00Z') },
  ]

  it('carries a row with no unread column at all', () => {
    const { sessions } = composeSidebarSessions({
      loaderSessions: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString(), category: r.category, isPinned: r.isPinned })),
      limit: 20,
      totalCount: 1,
    })
    expect(sessions[0]?.unread).toBe(false)
  })

  it('keeps matter-flavoured labels the product supplies', () => {
    const item = buildSessionNavItem<string>({
      icon: ICON,
      id: 'matters',
      label: 'Matters',
      href: `${base}/history`,
      sessions: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() })),
      hrefForSession: (id) => `${base}/chat/${id}`,
      emptyLabel: 'No matters yet',
      actions: { canEdit: true, renameLabel: 'Rename matter', deleteLabel: 'Close matter', onRename: () => {}, onDelete: () => {} },
    })
    expect(item.label).toBe('Matters')
    expect(item.emptyLabel).toBe('No matters yet')
    expect(item.subItems?.[0]?.actions?.map((a) => a.label)).toEqual(['Rename matter', 'Close matter'])
  })
})

// --------------------------------------------------------------------------
// creative — selects createdAt, not updatedAt; no per-thread route yet
// --------------------------------------------------------------------------

describe('creative-agent', () => {
  const base = '/app/ws_creative'
  const rows = [
    { id: 'c1', title: 'Launch film cutdowns', createdAt: new Date('2026-07-20T08:00:00Z') },
    { id: 'c2', title: '   ', createdAt: new Date('2026-07-19T08:00:00Z') },
  ]

  it('carries a row whose only timestamp is createdAt', () => {
    const { sessions } = composeSidebarSessions({
      loaderSessions: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.createdAt.toISOString() })),
      limit: 100,
      totalCount: 2,
    })
    expect(sessions.map((s) => s.id)).toEqual(['c1', 'c2'])
    expect(sessions[0]?.updatedAt).toBe('2026-07-20T08:00:00.000Z')
  })

  it('never renders an unaimable blank row for a whitespace title', () => {
    expect(sessionLabel({ id: 'c2', title: '   ', updatedAt: null })).toBe('Untitled chat')
  })

  it('a row with no timestamp at all still resolves', () => {
    const { sessions } = composeSidebarSessions({
      loaderSessions: [{ id: 'c3', title: 'Draft', updatedAt: null }],
      limit: 10,
    })
    expect(sessions[0]).toMatchObject({ id: 'c3', updatedAt: null, unread: false })
  })

  it('creative today has one /chat route, which resolves to no open session', () => {
    expect(activeSessionIdFromPath({ pathname: `${base}/chat`, base })).toBeNull()
  })
})

// --------------------------------------------------------------------------
// tax — title is `name`, sessions sit DIRECTLY under /app (no chat segment)
// --------------------------------------------------------------------------

describe('tax-agent', () => {
  const base = '/app'
  // Its own nav; every one of these occupies the same path position a session
  // id does, which is what makes `reserved` mandatory for this route shape.
  const routes = [
    { id: 'entities', path: '/entities' },
    { id: 'planning', path: '/planning' },
    { id: 'reviews', path: '/reviews' },
    { id: 'signatures', path: '/signatures' },
    { id: 'calendar', path: '/calendar' },
    { id: 'integrations', path: '/integrations' },
    { id: 'settings', path: '/settings' },
    { id: 'billing', path: '/billing' },
    { id: 'members', path: '/members' },
    { id: 'terminal', path: '/terminal' },
  ]
  const reserved = routes.map((r) => r.path)
  const rows = [
    { id: 's1', name: '2025 return — Almaraz', taxYear: 2025, status: 'active', updatedAt: new Date('2026-07-24T11:00:00Z') },
    { id: 's2', name: '2024 amended', taxYear: 2024, status: 'active', updatedAt: new Date('2026-06-01T11:00:00Z') },
  ]
  const toSummary = (r: (typeof rows)[number]): SessionSummary => ({
    id: r.id,
    title: r.name, // the column is `name`, not `title`
    updatedAt: r.updatedAt.toISOString(),
    category: String(r.taxYear),
  })

  it('resolves a session that sits directly under the base', () => {
    expect(activeSessionIdFromPath({ pathname: '/app/s1', base, segment: '', reserved })).toBe('s1')
    expect(activeSessionIdFromPath({ pathname: '/app/s1/vault', base, segment: '', reserved })).toBe('s1')
    expect(activeSessionIdFromPath({ pathname: '/app', base, segment: '', reserved })).toBeNull()
  })

  // The reason `reserved` exists. Without it every sibling page reads as an
  // open session, and the rail highlights (and prefetches) a session that does
  // not exist — the same silent-wrong-target class as the un-anchored regex.
  it('never mistakes a sibling page for a session id', () => {
    for (const path of reserved) {
      expect(activeSessionIdFromPath({ pathname: `/app${path}`, base, segment: '', reserved })).toBeNull()
    }
    // …and without `reserved` it would: this is the bug, stated.
    expect(activeSessionIdFromPath({ pathname: '/app/settings', base, segment: '' })).toBe('settings')
  })

  it('lights the right rail row for a sibling page, and none for an open session', () => {
    expect(resolveActiveNavId({ pathname: '/app/signatures', base, routes })).toBe('signatures')
    expect(resolveActiveNavId({ pathname: '/app/reviews/r_9', base, routes })).toBe('reviews')
    expect(resolveActiveNavId({ pathname: '/app/s1', base, routes })).toBeUndefined()
  })

  it('builds the rail list from tax rows with its own vocabulary', () => {
    const item = buildSessionNavItem<string>({
      icon: ICON,
      id: 'sessions',
      label: 'Sessions',
      href: '/app/history',
      sessions: rows.map(toSummary),
      hrefForSession: (id) => `/app/${id}`,
      activeSessionId: 's1',
      emptyLabel: 'No returns yet',
      untitledLabel: 'Untitled return',
      overflow: { href: '/app/history', label: 'View all sessions' },
    })
    expect(item.subItems?.map((r) => [r.id, r.href])).toEqual([
      ['s1', '/app/s1'],
      ['s2', '/app/s2'],
      ['view-all', '/app/history'],
    ])
    expect(item.subActiveIds).toEqual(['s1'])
  })
})

// --------------------------------------------------------------------------
// All four at once
// --------------------------------------------------------------------------

describe('one shell, four products', () => {
  const products = [
    { name: 'gtm', base: '/app/ws_1', segment: 'chat', open: '/app/ws_1/chat/t1', expect: 't1' },
    { name: 'legal', base: '/app/ws_1', segment: 'chat', open: '/app/ws_1/chat/m1', expect: 'm1' },
    { name: 'creative', base: '/app/ws_1', segment: 'chat', open: '/app/ws_1/chat', expect: null },
    { name: 'tax', base: '/app', segment: '', open: '/app/s1', expect: 's1', reserved: ['/settings'] },
  ] as const

  it('resolves each product’s own route shape', () => {
    for (const p of products) {
      expect(
        activeSessionIdFromPath({ pathname: p.open, base: p.base, segment: p.segment, reserved: 'reserved' in p ? p.reserved : undefined }),
        p.name,
      ).toBe(p.expect)
    }
  })

  it('no product’s route resolves a session inside another product’s base', () => {
    expect(activeSessionIdFromPath({ pathname: '/app/ws_1/chat/t1', base: '/app', segment: '', reserved: ['/ws_1'] })).toBeNull()
    expect(activeSessionIdFromPath({ pathname: '/app/s1', base: '/app/ws_1', segment: 'chat' })).toBeNull()
  })
})
