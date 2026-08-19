/**
 * Command palette — the React-free selection half of the Cmd/Ctrl+K surface
 * (`/web-react` holds the rendered half, `CommandPalette`).
 *
 * Pure and import-free beyond this module's own types: no React, no DOM, no
 * fuse.js. A route loader or a worker can build and rank the same items the
 * browser renders.
 *
 * Domain stays a parameter. The palette knows two kinds of row — a SESSION the
 * user can jump to and an ACTION the product offers (new chat, toggle theme,
 * open settings) — and both arrive as data. What a selection DOES is the
 * product's business; the shell only builds, ranks, and groups.
 *
 * Ranking is the documented ladder, not a fuzzy library: exact > prefix >
 * word-prefix > substring (earlier index wins) > token-order, with keyword
 * hits ranked a fixed step below the same hit on the label. Deterministic —
 * no index-building, no async, same input always sorts the same way.
 */

import { sessionLabel, UNTITLED_SESSION_LABEL, type SessionSummary } from './index'

/** A product-supplied palette action. `hint` is the right-aligned affordance
 *  copy (a kbd chord, a route name) — rendered verbatim, never interpreted. */
export interface CommandPaletteAction {
  id: string
  label: string
  description?: string
  hint?: string
  /** Extra match vocabulary that never renders (`settings` matching
   *  "preferences"). A keyword hit ranks below the same hit on the label. */
  keywords?: string[]
}

/** One selectable row. `group` is the section header it renders under. */
export interface CommandPaletteItem {
  id: string
  group: string
  label: string
  description?: string
  hint?: string
  keywords?: string[]
  /** Recency key (ISO-8601). Breaks score ties and orders the unfiltered
   *  list recent-first. Rows without one sort below rows with one. */
  recentAt?: string | null
}

/** One rendered section: a header plus its rows, in first-seen group order. */
export interface CommandPaletteGroup {
  group: string
  items: CommandPaletteItem[]
}

export const COMMAND_PALETTE_SESSIONS_GROUP = 'Sessions'
export const COMMAND_PALETTE_ACTIONS_GROUP = 'Actions'

export interface BuildCommandPaletteItemsOptions {
  sessions?: readonly SessionSummary[]
  actions?: readonly CommandPaletteAction[]
  /** Section label for sessions. Default "Sessions". */
  sessionsLabel?: string
  /** Section label for actions. Default "Actions". */
  actionsLabel?: string
  /** Placeholder title for an untitled session. */
  untitledLabel?: string
}

/**
 * Flatten sessions + actions into palette items, sessions group first (the
 * jump-back-in list), actions after. Sessions order recent-first by
 * `updatedAt` — a palette with an empty query IS the recency list, so the
 * build order is the render order and the filter never has to re-derive it.
 * Pinned sessions lead the recency sort, matching the rail.
 */
export function buildCommandPaletteItems({
  sessions = [],
  actions = [],
  sessionsLabel = COMMAND_PALETTE_SESSIONS_GROUP,
  actionsLabel = COMMAND_PALETTE_ACTIONS_GROUP,
  untitledLabel = UNTITLED_SESSION_LABEL,
}: BuildCommandPaletteItemsOptions): CommandPaletteItem[] {
  const ordered = [...sessions].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1
    return compareRecent(a.updatedAt, b.updatedAt)
  })
  const sessionItems: CommandPaletteItem[] = ordered.map((session) => ({
    id: session.id,
    group: sessionsLabel,
    label: sessionLabel(session, untitledLabel),
    keywords: session.category ? [session.category] : undefined,
    recentAt: session.updatedAt,
  }))
  const actionItems: CommandPaletteItem[] = actions.map((action) => ({
    id: action.id,
    group: actionsLabel,
    label: action.label,
    description: action.description,
    hint: action.hint,
    keywords: action.keywords,
  }))
  return [...sessionItems, ...actionItems]
}

/** Newer first; an undated row sorts below every dated one. ISO strings
 *  compare lexicographically. */
function compareRecent(a: string | null | undefined, b: string | null | undefined): number {
  if (a && b) return a < b ? 1 : a > b ? -1 : 0
  if (a) return -1
  if (b) return 1
  return 0
}

/** Collapse whitespace, lowercase once — every comparison runs on this form. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Words of a normalized string: runs of letters/numbers, so "new-chat" and
 *  "new chat" word-prefix identically. */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u

function wordsOf(text: string): string[] {
  return text.split(WORD_SPLIT).filter(Boolean)
}

/** How far below a label hit the same keyword hit ranks: any label match, even
 *  a token-order one (40), outranks a keyword exact match (100 − 65 = 35). */
const KEYWORD_PENALTY = 65

/**
 * Score one text against the query on the prefix > substring > token-order
 * ladder. Returns `null` for no match. Higher is better; tiers are spaced so
 * no within-tier adjustment can cross a tier boundary:
 *
 * - 100 exact
 * -  90 prefix (`text` starts with the query)
 * -  80 word-prefix (a WORD starts with the query — "chat" hits "New chat")
 * -  60–79 substring, minus the match index clamped to 19 (earlier wins)
 * -  40 token-order (every query token matches a later word, in order)
 */
function scoreText(text: string, query: string): number | null {
  if (!query) return 0
  if (text === query) return 100
  if (text.startsWith(query)) return 90
  const words = wordsOf(text)
  if (words.some((word) => word.startsWith(query))) return 80
  const at = text.indexOf(query)
  if (at >= 0) return 60 + Math.max(0, 19 - at)
  const tokens = wordsOf(query)
  if (tokens.length > 1) {
    let atWord = 0
    const inOrder = tokens.every((token) => {
      while (atWord < words.length) {
        const word = words[atWord]
        atWord += 1
        // Guarded by the while condition; noUncheckedIndexedAccess can't see it.
        if (word !== undefined && (word.startsWith(token) || word.includes(token))) return true
      }
      return false
    })
    if (inOrder) return 40
  }
  return null
}

/**
 * Score an item: the best label score, or the best keyword score a fixed step
 * below. `null` when neither matches — the item is filtered out. An empty
 * query scores every item 0 (the caller keeps build order: recent-first).
 */
export function scoreCommandPaletteItem(item: CommandPaletteItem, query: string): number | null {
  const q = normalize(query)
  const label = scoreText(normalize(item.label), q)
  let best = label
  for (const keyword of item.keywords ?? []) {
    const score = scoreText(normalize(keyword), q)
    if (score !== null) {
      const penalized = score - KEYWORD_PENALTY
      if (best === null || penalized > best) best = penalized
    }
  }
  return best
}

/**
 * Filter + rank: an empty query returns the items untouched (build order is
 * the recency order); a real query drops non-matches and sorts by score, then
 * recency, then original position — stable and deterministic.
 */
export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  if (!normalize(query)) return [...items]
  const scored: Array<{ item: CommandPaletteItem; score: number; index: number }> = []
  items.forEach((item, index) => {
    const score = scoreCommandPaletteItem(item, query)
    if (score !== null) scored.push({ item, score, index })
  })
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const recent = compareRecent(a.item.recentAt, b.item.recentAt)
    if (recent !== 0) return recent
    return a.index - b.index
  })
  return scored.map(({ item }) => item)
}

/**
 * Fold a flat (already ordered) item list into renderable sections. Groups
 * appear in first-seen order and each group appears ONCE — a filtered ranking
 * interleaves sessions and actions by score, and folding only consecutive runs
 * would render the same header twice. Within a group, rows keep the flat
 * order. Empty groups vanish, so a filter that leaves only actions renders no
 * "Sessions" header over nothing.
 */
export function groupCommandPaletteItems(items: readonly CommandPaletteItem[]): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = []
  const byGroup = new Map<string, CommandPaletteGroup>()
  for (const item of items) {
    let group = byGroup.get(item.group)
    if (!group) {
      group = { group: item.group, items: [] }
      byGroup.set(item.group, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}
