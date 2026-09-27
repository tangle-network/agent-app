import type { ReactNode } from 'react';
import type { MentionItem } from './use-file-mentions';
/** Imperative surface the editor's suggestion keymap drives. */
export interface MentionListHandle {
    /** Returns true when the key was consumed — the editor must not also act. */
    onKeyDown: (event: KeyboardEvent) => boolean;
}
export interface MentionListProps {
    items: MentionItem[];
    loading: boolean;
    error: boolean;
    /** Shown when the fetch resolved to zero items. Default "No matches". */
    emptyText?: string;
    renderItem?: (item: MentionItem) => ReactNode;
    onSelect: (item: MentionItem) => void;
    /** Root `role="listbox"` element id; option rows derive stable ids from it
     *  (`<id>-opt-<index>`) so the editor can point `aria-activedescendant` at
     *  the highlighted row. */
    id?: string;
    /** Fired whenever the highlight moves (keys, hover, or a result-set
     *  re-home) — what keeps the editor's `aria-activedescendant` current. */
    onActiveChange?: (index: number) => void;
    /** Extra classes merged onto the panel's root element, applied last so
     *  they win over the component's own. */
    className?: string;
}
/**
 * The mention suggestion list: a flat, keyboard-driven menu with loading,
 * empty, and error states. Selection is owned here so ↑/↓ and Enter/Tab
 * resolve against the highlighted row; every key it handles is reported
 * consumed so the composer's Enter-to-send never fires while open. The panel
 * carries its own surface classes but no positioning — the editor places it
 * through `PopoverSurface`, per the popover canon.
 */
export declare const MentionList: import("react").ForwardRefExoticComponent<MentionListProps & import("react").RefAttributes<MentionListHandle>>;
