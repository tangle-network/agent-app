/**
 * The command palette's pure half: build (sessions recent-first, actions
 * after), rank (the prefix > substring > token-order ladder), and group
 * (one section per group, first-seen order).
 *
 * The ranking ladder is pinned rung by rung, because the whole point of the
 * hand-rolled scorer is that it is DETERMINISTIC — a fuse-style fuzzy score
 * would let two adjacent runs disagree, and a palette whose rows shuffle
 * under the same query is a defect, not a preference.
 */

import { describe, expect, it } from 'vitest'

import {
  COMMAND_PALETTE_ACTIONS_GROUP,
  COMMAND_PALETTE_SESSIONS_GROUP,
  buildCommandPaletteItems,
  filterCommandPaletteItems,
  groupCommandPaletteItems,
  scoreCommandPaletteItem,
  type CommandPaletteItem,
} from '../../src/session-shell/index'

function item(label: string, extra: Partial<CommandPaletteItem> = {}): CommandPaletteItem {
  return { id: label, group: 'G', label, ...extra }
}

describe('buildCommandPaletteItems', () => {
  it('orders sessions recent-first, undated last, and keeps actions after sessions', () => {
    const items = buildCommandPaletteItems({
      sessions: [
        { id: 'old', title: 'Old thread', updatedAt: '2026-08-01T10:00:00.000Z' },
        { id: 'new', title: 'New thread', updatedAt: '2026-08-17T10:00:00.000Z' },
        { id: 'undated', title: 'Undated', updatedAt: null },
      ],
      actions: [{ id: 'new-chat', label: 'New chat', hint: '⌘N' }],
    })
    expect(items.map((i) => i.id)).toEqual(['new', 'old', 'undated', 'new-chat'])
    expect(items[0]?.group).toBe(COMMAND_PALETTE_SESSIONS_GROUP)
    expect(items[3]?.group).toBe(COMMAND_PALETTE_ACTIONS_GROUP)
    expect(items[3]?.hint).toBe('⌘N')
  })

  it('leads with pinned sessions and carries category into keywords', () => {
    const items = buildCommandPaletteItems({
      sessions: [
        { id: 'recent', title: 'Recent', updatedAt: '2026-08-17T10:00:00.000Z' },
        { id: 'pinned', title: 'Pinned', updatedAt: '2026-08-01T10:00:00.000Z', isPinned: true, category: 'gtm' },
      ],
    })
    expect(items.map((i) => i.id)).toEqual(['pinned', 'recent'])
    expect(items[0]?.keywords).toEqual(['gtm'])
  })

  it('renders an untitled session as the placeholder, never a blank row', () => {
    const items = buildCommandPaletteItems({
      sessions: [{ id: 's1', title: null, updatedAt: null }],
    })
    expect(items[0]?.label).toBe('Untitled chat')
  })

  it('honours group label overrides', () => {
    const items = buildCommandPaletteItems({
      sessions: [{ id: 's1', title: 'T', updatedAt: null }],
      actions: [{ id: 'a1', label: 'A' }],
      sessionsLabel: 'Threads',
      actionsLabel: 'Commands',
    })
    expect(items.map((i) => i.group)).toEqual(['Threads', 'Commands'])
  })
})

describe('scoreCommandPaletteItem — the ladder', () => {
  it('scores an empty query 0 for every item', () => {
    expect(scoreCommandPaletteItem(item('anything'), '')).toBe(0)
    expect(scoreCommandPaletteItem(item('anything'), '   ')).toBe(0)
  })

  it('ranks exact > prefix > word-prefix > substring > token-order', () => {
    const q = 'chat'
    const exact = scoreCommandPaletteItem(item('chat'), q)
    const prefix = scoreCommandPaletteItem(item('chat room'), q)
    const wordPrefix = scoreCommandPaletteItem(item('new chat'), q)
    const substring = scoreCommandPaletteItem(item('superchat'), q)
    const none = scoreCommandPaletteItem(item('unrelated'), q)

    expect(exact).toBe(100)
    expect(prefix).toBe(90)
    expect(wordPrefix).toBe(80)
    expect(substring).not.toBeNull()
    expect(substring as number).toBeLessThan(80)
    expect(substring as number).toBeGreaterThan(40)
    expect(none).toBeNull()

    // token-order sits below every single-token tier
    const tokenOrder = scoreCommandPaletteItem(item('session review'), 'ses rev')
    expect(tokenOrder).toBe(40)
  })

  it('token-order requires the query tokens IN ORDER', () => {
    expect(scoreCommandPaletteItem(item('session review'), 'ses rev')).toBe(40)
    expect(scoreCommandPaletteItem(item('session review'), 'rev ses')).toBeNull()
  })

  it('prefers an earlier substring index', () => {
    const early = scoreCommandPaletteItem(item('xchat'), 'chat')
    const late = scoreCommandPaletteItem(item('xxchat'), 'chat')
    expect(early).not.toBeNull()
    expect(late).not.toBeNull()
    expect(early as number).toBeGreaterThan(late as number)
  })

  it('is case-insensitive and collapses whitespace', () => {
    expect(scoreCommandPaletteItem(item('New Chat'), 'new chat')).toBe(100)
    expect(scoreCommandPaletteItem(item('New Chat'), '  NEW   CHAT ')).toBe(100)
  })

  it('ranks a keyword hit below any label hit', () => {
    const keywordExact = scoreCommandPaletteItem(item('Preferences', { keywords: ['chat'] }), 'chat')
    const labelTokenOrder = scoreCommandPaletteItem(item('session review'), 'ses rev')
    expect(keywordExact).toBe(100 - 65)
    expect(labelTokenOrder).toBe(40)
    // even a keyword EXACT match loses to the weakest label match
    expect(keywordExact as number).toBeLessThan(labelTokenOrder as number)
  })
})

describe('filterCommandPaletteItems', () => {
  it('returns the build order untouched for an empty query', () => {
    const items = [item('b'), item('a'), item('c')]
    expect(filterCommandPaletteItems(items, '')).toEqual(items)
    expect(filterCommandPaletteItems(items, '  ')).toEqual(items)
  })

  it('drops non-matches and sorts by the ladder', () => {
    const items = [
      item('superchat'),
      item('unrelated'),
      item('chat room'),
      item('new chat'),
      item('chat'),
    ]
    const ranked = filterCommandPaletteItems(items, 'chat').map((i) => i.label)
    expect(ranked).toEqual(['chat', 'chat room', 'new chat', 'superchat'])
  })

  it('breaks score ties recent-first, then by build order', () => {
    const items = [
      item('chat older', { id: 'older', recentAt: '2026-08-01T10:00:00.000Z' }),
      item('chat newer', { id: 'newer', recentAt: '2026-08-17T10:00:00.000Z' }),
      item('chat undated', { id: 'undated' }),
    ]
    // all three are prefix hits on "chat" — recency decides
    const ranked = filterCommandPaletteItems(items, 'chat').map((i) => i.id)
    expect(ranked).toEqual(['newer', 'older', 'undated'])
  })

  it('matches on keywords and descriptions without rendering them', () => {
    const items = [item('Preferences', { keywords: ['settings', 'config'] })]
    expect(filterCommandPaletteItems(items, 'settings').map((i) => i.label)).toEqual(['Preferences'])
    expect(filterCommandPaletteItems(items, 'nope')).toEqual([])
  })
})

describe('groupCommandPaletteItems', () => {
  it('folds one section per group in first-seen order — even when the ranking interleaves groups', () => {
    const items = [
      item('s1', { group: 'Sessions' }),
      item('a1', { group: 'Actions' }),
      item('s2', { group: 'Sessions' }),
    ]
    const groups = groupCommandPaletteItems(items)
    expect(groups.map((g) => g.group)).toEqual(['Sessions', 'Actions'])
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['s1', 's2'])
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['a1'])
  })

  it('empty input yields no sections', () => {
    expect(groupCommandPaletteItems([])).toEqual([])
  })
})
