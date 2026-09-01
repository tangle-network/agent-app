/**
 * Selection + routing for the session shell.
 *
 * This is the file that has to be adversarial. A session list that silently
 * opens (or highlights, or prefetches) the WRONG session is the same class of
 * defect as a connection route attaching to a stale box: nothing throws, the
 * page renders, and the user is looking at someone else's work. So every case
 * here is a path that a naive implementation resolves to a plausible-but-wrong
 * answer, not just the happy one.
 */

import { describe, expect, it } from 'vitest'

import {
  activeSessionIdFromPath,
  resolveActiveNavId,
  type NavRouteDef,
} from '../../src/session-shell/index'

const BASE = '/app/ws_123'

describe('activeSessionIdFromPath', () => {
  it('resolves the open session under the base', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr_9`, base: BASE })).toBe('thr_9')
  })

  it('returns null on the new-session composer', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/new`, base: BASE })).toBeNull()
  })

  it('returns null on the chat index and outside the chat segment', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat`, base: BASE })).toBeNull()
    expect(activeSessionIdFromPath({ pathname: `${BASE}/vault`, base: BASE })).toBeNull()
    expect(activeSessionIdFromPath({ pathname: BASE, base: BASE })).toBeNull()
  })

  it('ignores a query string and a trailing slash', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr_9/`, base: BASE })).toBe('thr_9')
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr_9?pending=p1`, base: BASE })).toBe('thr_9')
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr_9#top`, base: BASE })).toBe('thr_9')
  })

  it('takes only the first segment after the session id', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr_9/vault`, base: BASE })).toBe('thr_9')
  })

  // The bug the per-product regex shipped. `/\/chat\/([^/]+)/` scans the WHOLE
  // path, so a workspace (or any earlier segment) literally named `chat` makes
  // the NEXT segment look like a session id — the rail then highlights and
  // prefetches a session the user is not in.
  it('does not resolve a `chat` segment that belongs to a different base', () => {
    const pathname = '/app/chat/vault/chat/thr_real'
    expect(/\/chat\/([^/]+)/.exec(pathname)?.[1]).toBe('vault') // what the old scan returns
    // Anchored at the base, `/app/chat` has no chat segment of its own, so the
    // shell reports "no session open" instead of inventing `vault`…
    expect(activeSessionIdFromPath({ pathname, base: '/app/chat' })).toBeNull()
    // …and the workspace that really owns the route gets the real id.
    expect(activeSessionIdFromPath({ pathname, base: '/app/chat/vault' })).toBe('thr_real')
  })

  it('does not treat a sibling prefix as the chat segment', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chatty/thr_9`, base: BASE })).toBeNull()
  })

  it('decodes an encoded id so the highlight matches the row id', () => {
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/thr%2F9`, base: BASE })).toBe('thr/9')
  })

  it('fails closed when the session id has malformed percent encoding', () => {
    expect(() => activeSessionIdFromPath({ pathname: `${BASE}/chat/%E0%A4%A`, base: BASE })).not.toThrow()
    expect(activeSessionIdFromPath({ pathname: `${BASE}/chat/%E0%A4%A`, base: BASE })).toBeNull()
  })

  it('honours a product-specific segment and new-segment', () => {
    expect(
      activeSessionIdFromPath({ pathname: `${BASE}/matters/m_1`, base: BASE, segment: 'matters' }),
    ).toBe('m_1')
    expect(
      activeSessionIdFromPath({ pathname: `${BASE}/chat/start`, base: BASE, newSegment: 'start' }),
    ).toBeNull()
  })
})

describe('resolveActiveNavId', () => {
  const routes: NavRouteDef[] = [
    { id: 'new', path: '/chat/new' },
    { id: 'vault', path: '/vault' },
    { id: 'board', path: '/pipeline' },
    { id: 'approvals', path: '/approvals' },
    { id: 'history', path: '/history' },
  ]

  it('lights the row whose prefix matches', () => {
    expect(resolveActiveNavId({ pathname: `${BASE}/vault`, base: BASE, routes })).toBe('vault')
    expect(resolveActiveNavId({ pathname: `${BASE}/vault/folder/a`, base: BASE, routes })).toBe('vault')
    expect(resolveActiveNavId({ pathname: `${BASE}/history`, base: BASE, routes })).toBe('history')
  })

  // Longest-prefix, so `/chat/new` beats a shorter `/chat` row regardless of
  // declaration order. The per-product versions were first-match over an array:
  // reordering the nav silently changed which row lit up.
  it('prefers the longest matching prefix, whatever the declaration order', () => {
    const withChat: NavRouteDef[] = [{ id: 'chat', path: '/chat' }, ...routes]
    expect(resolveActiveNavId({ pathname: `${BASE}/chat/new`, base: BASE, routes: withChat })).toBe('new')
    expect(
      resolveActiveNavId({ pathname: `${BASE}/chat/new`, base: BASE, routes: [...withChat].reverse() }),
    ).toBe('new')
  })

  it('never matches a sibling that merely shares a prefix string', () => {
    expect(resolveActiveNavId({ pathname: `${BASE}/vault-archive`, base: BASE, routes })).toBeUndefined()
  })

  it('routes an alias onto an existing row', () => {
    expect(
      resolveActiveNavId({
        pathname: `${BASE}/agents`,
        base: BASE,
        routes: [...routes, { id: 'integrations', path: '/integrations' }],
        aliases: { '/agents': 'integrations' },
      }),
    ).toBe('integrations')
  })

  it('claimsNothing beats a shorter match, so an open chat lights no row', () => {
    const withChat: NavRouteDef[] = [{ id: 'chat', path: '/chat' }, ...routes]
    expect(
      resolveActiveNavId({ pathname: `${BASE}/chat/thr_9`, base: BASE, routes: withChat, claimsNothing: ['/chat'] }),
    ).toBeUndefined()
    // …but the more specific new-chat row still wins over it.
    expect(
      resolveActiveNavId({ pathname: `${BASE}/chat/new`, base: BASE, routes: withChat, claimsNothing: ['/chat'] }),
    ).toBe('new')
  })

  it('is unaffected by a query string or trailing slash', () => {
    expect(resolveActiveNavId({ pathname: `${BASE}/vault/?q=x`, base: BASE, routes })).toBe('vault')
  })

  it('returns undefined at the workspace root when no route claims it', () => {
    expect(resolveActiveNavId({ pathname: BASE, base: BASE, routes })).toBeUndefined()
  })

  it('resolves against the base, so another workspace does not light this rail', () => {
    expect(resolveActiveNavId({ pathname: '/app/ws_OTHER/vault', base: BASE, routes })).toBeUndefined()
  })
})
