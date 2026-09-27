/**
 * CommandPalette — the rendered half of the Cmd/Ctrl+K surface. Selection,
 * ranking, and grouping live in `/session-shell` (`buildCommandPaletteItems`,
 * `filterCommandPaletteItems`, `groupCommandPaletteItems`); this component is
 * the overlay, the input, and the keyboard model.
 *
 * Placement follows the PopoverSurface canon (AGENTS.md "UI chrome
 * ownership"): the panel PORTALS to `document.body` and positions in viewport
 * coordinates (`fixed`), so no host markup — a scroll rail, a `transform`, a
 * stacking context — can clip or trap it. Unlike the pickers it is CENTERED,
 * not trigger-anchored: a palette has no trigger, so it does not reuse
 * `PopoverSurface` itself, but it carries the same grammar — `bg-popover`,
 * `border-card-edge`, `OVERLAY_SHADOW`, the stamped surface attribute.
 *
 * The keyboard model is the ARIA combobox pattern: focus stays in the input,
 * ArrowUp/ArrowDown move `aria-activedescendant` across the FLAT result list
 * (groups are presentation), Enter selects, Escape closes, and closing returns
 * focus to whatever had it before the palette opened.
 */
import { type CommandPaletteItem } from '../session-shell/index';
export type { CommandPaletteItem } from '../session-shell/index';
export interface CommandPaletteProps {
    /** The full item list, build-ordered (recent-first sessions, then actions).
     *  Filtering and ranking are owned here — pass the UNFILTERED list. */
    items: CommandPaletteItem[];
    /** A row was chosen (click or Enter). The palette closes itself. */
    onSelect: (item: CommandPaletteItem) => void;
    /** Controlled open state. Omit for self-managed state toggled by the hotkey. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Register the Cmd/Ctrl+K toggle. Default true. */
    hotkey?: boolean;
    /** Async source is still resolving — the input stays live, the list shows
     *  the loading row instead of a premature empty state. */
    loading?: boolean;
    /** Seed for the query (uncontrolled). */
    initialQuery?: string;
    placeholder?: string;
    /** Empty-state copy. Default names the query: `No results for “…”`. */
    emptyMessage?: string;
    /** Accessible name for the dialog. Default "Command palette". */
    label?: string;
}
export declare function CommandPalette({ items, onSelect, open: controlledOpen, onOpenChange, hotkey, loading, initialQuery, placeholder, emptyMessage, label, }: CommandPaletteProps): import("react").ReactPortal | null;
