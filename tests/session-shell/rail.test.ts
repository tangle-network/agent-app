/**
 * The rail contract + list composition.
 *
 * The contract half matters because `/session-shell` mirrors sandbox-ui's nav
 * types STRUCTURALLY instead of importing them (invariant 3). A structural
 * mirror that drifts fails silently at runtime — sandbox-ui simply ignores a
 * field it does not know, so the unread dot and the responding indicator just
 * stop appearing. Assigning the builder's output to the REAL published types
 * turns that into a compile error.
 */

import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import type { SidebarLayoutNavItem } from '@tangle-network/sandbox-ui/dashboard'

import {
  buildSessionNavItem,
  buildSessionSubItems,
  composeSidebarSessions,
  mergeSessionPages,
  readRailCollapsedCookie,
  railCollapsedCookie,
  resolveSessionUnread,
  sessionLabel,
  type SessionRailSubItem,
  type SessionRowActions,
  type SessionSummary,
} from '../../src/session-shell/index'

const BASE = '/app/ws_1'
const href = (id: string) => `${BASE}/chat/${id}`
/** A product icon, in the shape sandbox-ui requires. */
type Icon = ComponentType<{ className?: string }>
const HistoryIcon: Icon = () => null

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Session ${id}`, updatedAt: '2026-07-24T10:00:00.000Z', ...over }
}

describe('rail item contract against sandbox-ui', () => {
  it('the built nav item is assignable to sandbox-ui SidebarLayoutNavItem', () => {
    const item = buildSessionNavItem<Icon>({
      icon: HistoryIcon,
      href: `${BASE}/history`,
      sessions: [session('a', { unread: true })],
      hrefForSession: href,
      respondingSessionIds: new Set(['a']),
      actions: { canEdit: true, onRename: () => {}, onDelete: () => {} },
      overflow: { href: `${BASE}/history` },
    })
    // Two halves, because neither catches the other's drift.
    //
    // (1) The assignment fails at TYPECHECK when a required field goes missing
    //     or a type changes — e.g. making `icon` optional, which sandbox-ui
    //     requires and renders unguarded.
    const asSandboxUi: SidebarLayoutNavItem = item
    expect(asSandboxUi.expandable).toBe(true)
    expect(asSandboxUi.subItems).toHaveLength(2)

    // (2) Assignability is blind to a RENAMED optional field: dropping `unread`
    //     and emitting `isUnread` still typechecks, and sandbox-ui would simply
    //     ignore the unknown key — the dot silently stops rendering. So the
    //     emitted key names are asserted directly, against the names read off
    //     the published `RailExpandableSubItem`.
    const emitted = Object.keys(item.subItems?.[0] ?? {})
    expect(emitted.sort()).toEqual(['actions', 'href', 'id', 'isLoading', 'label', 'prefetch', 'unread'])
    expect(Object.keys(item.subItems?.[1] ?? {}).sort()).toEqual(['emphasis', 'href', 'id', 'label', 'prefetch'])
  })

  it('carries the live/unread/action fields sandbox-ui renders', () => {
    const [row] = buildSessionSubItems({
      sessions: [session('a', { unread: true })],
      hrefForSession: href,
      respondingSessionIds: new Set(['a']),
      actions: { canEdit: true, onRename: () => {}, onDelete: () => {} },
    })
    expect(row).toMatchObject({ id: 'a', href: `${BASE}/chat/a`, isLoading: true, unread: true })
    expect(row?.actions?.map((a) => a.id)).toEqual(['rename', 'delete'])
    expect(row?.actions?.find((a) => a.id === 'delete')?.destructive).toBe(true)
  })

  it('omits actions entirely for a viewer who cannot edit', () => {
    const [row] = buildSessionSubItems({
      sessions: [session('a')],
      hrefForSession: href,
      actions: { canEdit: false, onRename: () => {}, onDelete: () => {} },
    })
    expect(row?.actions).toBeUndefined()
  })

  it('an action calls back with the session it was built for', () => {
    const renamed: string[] = []
    const [row] = buildSessionSubItems({
      sessions: [session('a'), session('b')],
      hrefForSession: href,
      actions: { canEdit: true, onRename: (s) => renamed.push(s.id), onDelete: () => {} },
    })
    row?.actions?.[0]?.onSelect()
    expect(renamed).toEqual(['a'])
  })

  it('appends the overflow row only when asked, and marks it emphasised', () => {
    const withOverflow = buildSessionSubItems({
      sessions: [session('a')],
      hrefForSession: href,
      overflow: { href: `${BASE}/history`, label: 'View all chats' },
    })
    expect(withOverflow.map((r) => r.id)).toEqual(['a', 'view-all'])
    expect(withOverflow[1]?.emphasis).toBe(true)
    expect(buildSessionSubItems({ sessions: [session('a')], hrefForSession: href })).toHaveLength(1)
  })

  it('highlights the open session inside the expandable', () => {
    const item = buildSessionNavItem<Icon>({
      icon: HistoryIcon,
      href: `${BASE}/history`,
      sessions: [session('a'), session('b')],
      hrefForSession: href,
      activeSessionId: 'b',
    })
    expect(item.subActiveIds).toEqual(['b'])
    expect(buildSessionNavItem<Icon>({ icon: HistoryIcon, href: `${BASE}/history`, sessions: [], hrefForSession: href, activeSessionId: null }).subActiveIds).toBeUndefined()
  })

  it('falls back to a placeholder rather than an unaimable blank row', () => {
    expect(sessionLabel(session('a', { title: '   ' }))).toBe('Untitled chat')
    expect(sessionLabel(session('a', { title: null }), 'No title')).toBe('No title')
  })
})

describe('composeSidebarSessions', () => {
  it('puts optimistic rows first and caps at the limit', () => {
    const { sessions, hasMore } = composeSidebarSessions({
      loaderSessions: [session('a'), session('b'), session('c')],
      optimisticSessions: [session('new1')],
      limit: 2,
      totalCount: 3,
    })
    expect(sessions.map((s) => s.id)).toEqual(['new1', 'a'])
    expect(hasMore).toBe(true)
  })

  // A revalidation brings a live-created session back from the server. Keeping
  // both copies means duplicate React keys AND two kebabs acting on one row.
  it('drops an optimistic row the loader has since returned', () => {
    const { sessions } = composeSidebarSessions({
      loaderSessions: [session('new1'), session('a')],
      optimisticSessions: [session('new1')],
      limit: 10,
    })
    expect(sessions.map((s) => s.id)).toEqual(['new1', 'a'])
  })

  it('reports no overflow when everything fits', () => {
    expect(
      composeSidebarSessions({ loaderSessions: [session('a')], limit: 20, totalCount: 1 }).hasMore,
    ).toBe(false)
  })

  it('counts optimistic rows toward the overflow decision', () => {
    const { hasMore } = composeSidebarSessions({
      loaderSessions: [session('a'), session('b')],
      optimisticSessions: [session('new1')],
      limit: 2,
      totalCount: 2,
    })
    expect(hasMore).toBe(true)
  })

  it('resolves unread per row through the live overlays', () => {
    const { sessions } = composeSidebarSessions({
      loaderSessions: [session('a', { unread: true }), session('b'), session('c', { unread: true })],
      limit: 10,
      liveUnreadIds: new Set(['b']),
      locallyReadIds: new Set(['a']),
      currentSessionId: 'c',
    })
    expect(sessions.map((s) => [s.id, s.unread])).toEqual([
      ['a', false], // opened in this tab since the loader ran
      ['b', true], // went unread live
      ['c', false], // the session being viewed is never unread
    ])
  })
})

describe('resolveSessionUnread', () => {
  it('the open session is never unread, even when the loader says so', () => {
    expect(
      resolveSessionUnread({ sessionId: 'a', loaderUnread: true, currentSessionId: 'a' }),
    ).toBe(false)
  })

  it('live unread beats a stale loader value', () => {
    expect(
      resolveSessionUnread({ sessionId: 'a', loaderUnread: false, liveUnreadIds: new Set(['a']) }),
    ).toBe(true)
  })

  it('live unread beats a local read for the same session', () => {
    expect(
      resolveSessionUnread({
        sessionId: 'a',
        loaderUnread: false,
        liveUnreadIds: new Set(['a']),
        locallyReadIds: new Set(['a']),
      }),
    ).toBe(true)
  })

  it('falls back to the loader value with no overlays', () => {
    expect(resolveSessionUnread({ sessionId: 'a', loaderUnread: true })).toBe(true)
    expect(resolveSessionUnread({ sessionId: 'a', loaderUnread: false })).toBe(false)
  })
})

describe('mergeSessionPages', () => {
  it('appends and drops ids already shown', () => {
    // A session bumped to page 1 between fetches arrives again on page 2.
    const merged = mergeSessionPages([session('a'), session('b')], [session('b'), session('c')])
    expect(merged.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the held copy when a duplicate arrives', () => {
    const merged = mergeSessionPages(
      [session('a', { title: 'held' })],
      [session('a', { title: 'incoming' })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.title).toBe('held')
  })
})

describe('rail collapse cookie', () => {
  it('round-trips through a Cookie header', () => {
    const set = railCollapsedCookie(true, { name: 'x-rail', secure: false })
    expect(readRailCollapsedCookie(set.split(';')[0] ?? '', 'x-rail')).toBe(true)
    expect(readRailCollapsedCookie('x-rail=0', 'x-rail')).toBe(false)
  })

  it('reads the right cookie among several, with or without spaces', () => {
    expect(readRailCollapsedCookie('a=1; x-rail=1; b=2', 'x-rail')).toBe(true)
    expect(readRailCollapsedCookie('a=1;x-rail=1', 'x-rail')).toBe(true)
    expect(readRailCollapsedCookie('other-rail=1', 'x-rail')).toBe(false)
  })

  // The shipped versions built a RegExp from the cookie name. A name carrying a
  // metacharacter then matches the wrong cookie (or nothing) with no error.
  it('treats the cookie name literally, not as a pattern', () => {
    expect(readRailCollapsedCookie('aXb=1', 'a.b')).toBe(false)
    expect(readRailCollapsedCookie('a.b=1', 'a.b')).toBe(true)
  })

  it('is false with no cookie header at all', () => {
    expect(readRailCollapsedCookie(null, 'x-rail')).toBe(false)
    expect(readRailCollapsedCookie(undefined, 'x-rail')).toBe(false)
  })

  it('omits `secure` for http so the rail state persists on localhost', () => {
    expect(railCollapsedCookie(true, { secure: false })).not.toContain('secure')
    expect(railCollapsedCookie(true, { secure: true })).toContain('; secure')
  })
})

/**
 * A product may support archiving a session but not renaming it (tax's PATCH
 * takes `planMode` only). The rail builder used to require BOTH handlers, so
 * such a product had two bad choices: pass a no-op rename — a menu item that
 * silently does nothing — or pass no actions and lose archive entirely when its
 * session panel was removed.
 *
 * `SessionHistoryPanel` has always rendered whichever handler it was given, so
 * this makes the two halves of the shell agree rather than adding a new idea.
 */
describe('row actions the product actually has', () => {
  function only(over: Partial<SessionRowActions<Icon>>): SessionRailSubItem<Icon> {
    const [row] = buildSessionSubItems<Icon>({
      sessions: [session('a')],
      hrefForSession: href,
      actions: { canEdit: true, ...over },
    })
    if (!row) throw new Error('expected one row')
    return row
  }

  it('emits delete alone when the product has no rename', () => {
    const deleted: string[] = []
    const row = only({ onDelete: (s: SessionSummary) => deleted.push(s.id) })
    expect(row.actions?.map((a) => a.id)).toEqual(['delete'])
    row.actions?.[0]?.onSelect()
    expect(deleted).toEqual(['a'])
    // The one that is present must still be wired to the right handler.
    expect(row.actions?.[0]?.destructive).toBe(true)
  })

  it('emits rename alone when the product has no delete', () => {
    const renamed: string[] = []
    const row = only({ onRename: (s: SessionSummary) => renamed.push(s.id) })
    expect(row.actions?.map((a) => a.id)).toEqual(['rename'])
    row.actions?.[0]?.onSelect()
    expect(renamed).toEqual(['a'])
  })

  it('still emits both, in order, when the product has both', () => {
    const row = only({ onRename: () => {}, onDelete: () => {} })
    expect(row.actions?.map((a) => a.id)).toEqual(['rename', 'delete'])
  })

  // sandbox-ui renders the kebab trigger whenever `actions` is an array, so an
  // empty array is a button that opens an empty menu.
  it('emits undefined, not an empty array, when neither handler is supplied', () => {
    expect(only({}).actions).toBeUndefined()
  })
})

/**
 * Rename and delete are the only two acts the shell can name for every product.
 * Pin, categorise, duplicate, share are real row actions that differ per
 * product, so they arrive through a callback rather than as more fields.
 */
describe('product row actions beyond rename and delete', () => {
  function rowWith(over: Partial<SessionRowActions<Icon>>): SessionRailSubItem<Icon> {
    const [row] = buildSessionSubItems<Icon>({
      sessions: [session('a')],
      hrefForSession: href,
      actions: { canEdit: true, ...over },
    })
    if (!row) throw new Error('expected one row')
    return row
  }

  it('places them between rename and delete, keeping destructive last', () => {
    const row = rowWith({
      onRename: () => {},
      onDelete: () => {},
      extraActions: () => [
        { id: 'pin', label: 'Pin', onSelect: () => {} },
        { id: 'category', label: 'Set category', onSelect: () => {} },
      ],
    })
    expect(row.actions?.map((a) => a.id)).toEqual(['rename', 'pin', 'category', 'delete'])
  })

  it('evaluates per session, so a label can read that row’s own state', () => {
    const [pinned, unpinned] = buildSessionSubItems<Icon>({
      sessions: [session('a', { isPinned: true }), session('b')],
      hrefForSession: href,
      actions: {
        canEdit: true,
        extraActions: (s) => [
          { id: 'pin', label: s.isPinned ? 'Unpin' : 'Pin', onSelect: () => {} },
        ],
      },
    })
    expect(pinned?.actions?.[0]?.label).toBe('Unpin')
    expect(unpinned?.actions?.[0]?.label).toBe('Pin')
  })

  it('carries the session into the handler', () => {
    const pinned: string[] = []
    const row = rowWith({
      extraActions: (s) => [{ id: 'pin', label: 'Pin', onSelect: () => pinned.push(s.id) }],
    })
    row.actions?.[0]?.onSelect()
    expect(pinned).toEqual(['a'])
  })

  it('is suppressed for a read-only viewer, like rename and delete', () => {
    const [row] = buildSessionSubItems<Icon>({
      sessions: [session('a')],
      hrefForSession: href,
      actions: {
        canEdit: false,
        extraActions: () => [{ id: 'pin', label: 'Pin', onSelect: () => {} }],
      },
    })
    expect(row?.actions).toBeUndefined()
  })
})
