/**
 * The studio composer's control row: the media-type segmented group, the
 * horizontally scrolling option band, and the pills that dock in it.
 *
 * Every pill that opens a panel opens it through `usePopover` + `PopoverSurface`
 * (`../web-react/controls`), never an in-place `absolute` panel: the band IS a
 * scroll container (`overflow-x-auto`), and a scroll container clips every
 * positioned descendant whose containing block sits inside it — the measured
 * failure that left the chat composer's own menus painting zero pixels. The
 * surface portals to `document.body` and re-anchors on capture-phase scroll, so
 * scrolling the band moves an open menu with its pill. The one rule the surface
 * cannot supply is when to give up: a menu whose pill has been scrolled out of
 * the band no longer points at anything, so it closes when the pill's
 * horizontal CENTRE leaves the band's box.
 */
import { type JSX, type ReactNode, type RefObject } from 'react';
import { type LucideIcon } from 'lucide-react';
import { type MediaModelOption, type ModelOptionValue } from '../studio';
/** One media lane's segment: the icon it shows collapsed, the word it shows
 *  when active. */
export interface MediaTypeSegment<T extends string> {
    type: T;
    label: string;
    icon: LucideIcon;
}
/**
 * The pinned-left media-type group: a track holding one filled pill (the active
 * lane, icon + word) and icon-only siblings. `aria-pressed` carries the state
 * and `aria-label` carries the word the collapsed items drop.
 */
export declare function MediaTypeSegments<T extends string>({ value, segments, onChange, }: {
    value: T;
    segments: readonly MediaTypeSegment<T>[];
    onChange: (type: T) => void;
}): JSX.Element;
/**
 * The middle scroller. It hides its scrollbar and fades whichever edge has
 * content behind it, at the DEPTH of what is actually hidden (capped at
 * {@link MAX_FADE}) rather than a fixed gradient that claims more is off-screen
 * than there is. A media-type switch resets the scroll to the start, because
 * the control set itself changed; every other re-render leaves `scrollLeft`
 * alone, so picking a value cannot jump the band back to the beginning.
 */
export declare function ComposerBand({ bandRef, resetKey, children, }: {
    bandRef: RefObject<HTMLDivElement | null>;
    /** Changing this scrolls the band back to the start. */
    resetKey: string;
    children: ReactNode;
}): JSX.Element;
/** One renderable value: the wire value, untouched, and how it reads. */
export interface OptionChoice {
    value: ModelOptionValue;
    label: string;
    icon?: LucideIcon;
}
/** A standalone enum picker using the studio composer's pill and menu grammar. */
export declare function MenuPill<T extends string>({ label, value, choices, onSelect, className, icon: Icon, trigger, }: {
    label: string;
    value: T;
    choices: readonly {
        value: T;
        label: string;
        icon?: LucideIcon;
    }[];
    onSelect: (value: T) => void;
    className?: string;
    icon?: LucideIcon;
    trigger?: 'pill' | 'text';
}): JSX.Element;
/**
 * A value pill and the menu it opens.
 *
 * The pill shows the VALUE and carries the parameter name in `title` and in its
 * accessible name — a band of eight labelled pills does not fit a chat card,
 * and "5s" alone tells a screen-reader user nothing about which parameter it
 * belongs to.
 */
export declare function OptionPill({ label, value, choices, onSelect, bandRef, custom, icon: Icon, }: {
    label: string;
    value: ModelOptionValue | undefined;
    choices: readonly OptionChoice[];
    onSelect: (value: ModelOptionValue) => void;
    bandRef: RefObject<HTMLDivElement | null>;
    icon?: LucideIcon;
    /** A trailing row that swaps the menu to a form (the gpt-image-2 custom
     *  size). Absent for every parameter whose values are an enum. */
    custom?: {
        label: string;
        render: (args: {
            close: () => void;
        }) => ReactNode;
    };
}): JSX.Element;
/**
 * The custom-size form the Size menu swaps to.
 *
 * The reason a size is refused renders next to the fields that are wrong — a
 * toast would be gone by the time the user looks back at the inputs — and Apply
 * refuses rather than disables, so the reason is always reachable.
 */
export declare function CustomSizeForm({ initial, onApply, onCancel, }: {
    initial?: string;
    onApply: (size: string) => void;
    onCancel: () => void;
}): JSX.Element;
/**
 * The audio switch. It is a toggle rather than a menu because the parameter has
 * exactly two states, and a two-row menu to say "on" is a menu that costs a
 * click for nothing.
 */
export declare function AudioTogglePill({ on, onToggle }: {
    on: boolean;
    onToggle: (on: boolean) => void;
}): JSX.Element;
/**
 * The reference-image pill: the only control that changes which MODEL runs, so
 * the swap to the image-to-video sibling is the caller's (`onAttach`/`onRemove`)
 * and the pill only reports what is attached.
 *
 * With no `pick` seam it opens a URL form instead of a file dialog — a URL is
 * something a host with no upload endpoint can still supply, and refusing
 * anything that is not `http(s)` keeps a pasted local path from reaching the
 * provider as an unfetchable reference.
 */
export declare function ReferencePill({ url, onAttach, onRemove, pick, bandRef, }: {
    url: string | null;
    onAttach: (url: string) => void;
    onRemove: () => void;
    pick?: () => Promise<string | null>;
    bandRef: RefObject<HTMLDivElement | null>;
}): JSX.Element;
/**
 * The model pill — first in the band on every lane, and the only pill that is
 * always there. A model with no published option metadata renders this and
 * nothing else, which is the honest reading of "we do not know what this model
 * takes".
 */
export declare function ModelPill({ models, value, displayName, provider, unavailable, onSelect, bandRef, }: {
    models: readonly MediaModelOption[];
    value: string;
    /** What the pill reads. Falls back to the id — including for a model the
     *  catalog does not list, such as an image-to-video sibling. */
    displayName: string;
    provider?: string;
    /** The selected model is listed but not routable — the pill carries the warning instead of any status line. */
    unavailable?: boolean;
    onSelect: (id: string) => void;
    bandRef: RefObject<HTMLDivElement | null>;
}): JSX.Element;
/**
 * How a wire value reads, with the wire value itself untouched underneath.
 *
 * Keyed on the PARAMETER because the same scalar means different things across
 * them: `5` is "5s" of video and `2` is "×2" images. Anything this table has no
 * rule for reads as itself with a capital letter — never as an invented word,
 * so `std` renders "Std" and not a "Standard" nobody published.
 */
export declare function optionValueLabel(param: string, value: ModelOptionValue): string;
