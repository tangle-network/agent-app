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
import { type SessionSummary } from './index';
/** A product-supplied palette action. `hint` is the right-aligned affordance
 *  copy (a kbd chord, a route name) — rendered verbatim, never interpreted. */
export interface CommandPaletteAction {
    id: string;
    label: string;
    description?: string;
    hint?: string;
    /** Extra match vocabulary that never renders (`settings` matching
     *  "preferences"). A keyword hit ranks below the same hit on the label. */
    keywords?: string[];
}
/** One selectable row. `group` is the section header it renders under. */
export interface CommandPaletteItem {
    id: string;
    group: string;
    label: string;
    description?: string;
    hint?: string;
    keywords?: string[];
    /** Recency key (ISO-8601). Breaks score ties and orders the unfiltered
     *  list recent-first. Rows without one sort below rows with one. */
    recentAt?: string | null;
}
/** One rendered section: a header plus its rows, in first-seen group order. */
export interface CommandPaletteGroup {
    group: string;
    items: CommandPaletteItem[];
}
export declare const COMMAND_PALETTE_SESSIONS_GROUP = "Sessions";
export declare const COMMAND_PALETTE_ACTIONS_GROUP = "Actions";
export interface BuildCommandPaletteItemsOptions {
    sessions?: readonly SessionSummary[];
    actions?: readonly CommandPaletteAction[];
    /** Section label for sessions. Default "Sessions". */
    sessionsLabel?: string;
    /** Section label for actions. Default "Actions". */
    actionsLabel?: string;
    /** Placeholder title for an untitled session. */
    untitledLabel?: string;
}
/**
 * Flatten sessions + actions into palette items, sessions group first (the
 * jump-back-in list), actions after. Sessions order recent-first by
 * `updatedAt` — a palette with an empty query IS the recency list, so the
 * build order is the render order and the filter never has to re-derive it.
 * Pinned sessions lead the recency sort, matching the rail.
 */
export declare function buildCommandPaletteItems({ sessions, actions, sessionsLabel, actionsLabel, untitledLabel, }: BuildCommandPaletteItemsOptions): CommandPaletteItem[];
/**
 * Score an item: the best label score, or the best keyword score a fixed step
 * below. `null` when neither matches — the item is filtered out. An empty
 * query scores every item 0 (the caller keeps build order: recent-first).
 */
export declare function scoreCommandPaletteItem(item: CommandPaletteItem, query: string): number | null;
/**
 * Filter + rank: an empty query returns the items untouched (build order is
 * the recency order); a real query drops non-matches and sorts by score, then
 * recency, then original position — stable and deterministic.
 */
export declare function filterCommandPaletteItems(items: readonly CommandPaletteItem[], query: string): CommandPaletteItem[];
/**
 * Fold a flat (already ordered) item list into renderable sections. Groups
 * appear in first-seen order and each group appears ONCE — a filtered ranking
 * interleaves sessions and actions by score, and folding only consecutive runs
 * would render the same header twice. Within a group, rows keep the flat
 * order. Empty groups vanish, so a filter that leaves only actions renders no
 * "Sessions" header over nothing.
 */
export declare function groupCommandPaletteItems(items: readonly CommandPaletteItem[]): CommandPaletteGroup[];
