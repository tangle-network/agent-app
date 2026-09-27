/**
 * Shared chat-shell control primitives — the LEAF that both the web-react barrel
 * (`./index`) and the composer children (`./agent-session-controls`,
 * `./seat-paywall`) import directly, so neither child has to reach back through
 * the barrel (which would re-create an import cycle). The barrel re-exports the
 * public names (`usePopover`, `usePending`, `ModelPicker`, `EffortPicker`, …)
 * unchanged, so the published export surface is identical.
 *
 * Styling contract matches the rest of `web-react`: Tailwind classes against the
 * shared design tokens; the glyphs are inline SVGs, no icon-library dependency.
 */
import { type ReactNode, type RefObject } from 'react';
import { type CatalogModel } from '../runtime/model-catalog';
export declare function ChevronDown({ className }: {
    className?: string;
}): import("react").JSX.Element;
/** lucide `brain` (v1.27) inlined — `/web-react` ships no icon-library
 *  dependency, so the thinking glyph follows the same pattern as the rest of
 *  this set. */
export declare function BrainGlyph({ className }: {
    className?: string;
}): import("react").JSX.Element;
/** lucide `check` — the selected-row mark in the picker menus. */
export declare function CheckGlyph({ className }: {
    className?: string;
}): import("react").JSX.Element;
/**
 * Keyboard + pointer model for a trigger-and-popover pair, dependency-free.
 * Outside-mousedown and Escape both close; Escape also returns focus to the
 * trigger so keyboard users aren't dropped at the top of the document. The
 * returned `triggerProps` carry the ARIA contract (`aria-haspopup`/
 * `aria-expanded`); spread them onto the trigger button.
 *
 * `panelRef` belongs to the popover panel and MUST be wired when the panel is
 * rendered through {@link PopoverSurface}: a portaled panel is not inside
 * `containerRef`, so a container-only outside test reads every click on the
 * menu's own rows as an outside click and closes before the row's handler runs.
 */
export declare function usePopover(open: boolean, setOpen: (open: boolean) => void): {
    containerRef: RefObject<HTMLDivElement | null>;
    triggerRef: RefObject<HTMLButtonElement | null>;
    panelRef: RefObject<HTMLDivElement | null>;
    triggerProps: {
        ref: RefObject<HTMLButtonElement | null>;
        'aria-haspopup': true;
        'aria-expanded': boolean;
    };
};
/**
 * Marks the portaled panel in the DOM. Products and audits (see
 * `playground/scripts/popover-hit-test.mjs`) select on this rather than on a
 * Tailwind class, which is presentation and free to change.
 *
 * Its VALUE is the surface's ancestor path (`outer/inner`), which is what
 * restores "is this click inside my popover" after the portal flattens two
 * nested panels into two siblings of `<body>`.
 */
export declare const POPOVER_SURFACE_ATTR = "data-agent-app-popover";
export interface PopoverSurfaceProps {
    open: boolean;
    /** The trigger the panel anchors to — `usePopover`'s `triggerRef`. */
    triggerRef: RefObject<HTMLElement | null>;
    /** `usePopover`'s `panelRef`; also what the outside-click test consults. */
    panelRef: RefObject<HTMLDivElement | null>;
    /** Presentation classes. Placement and elevation are owned here — a caller
     *  must not pass `absolute`/`fixed`/`top-*`/`bottom-*`/`z-*`. */
    className?: string;
    role?: string;
    id?: string;
    /** Make the panel at least as wide as its trigger. A portaled panel has no
     *  `w-full` to inherit — the trigger is no longer its offset parent — so a
     *  menu that used to stretch to a full-width trigger declares it here. */
    matchTriggerWidth?: boolean;
    children: ReactNode;
}
/**
 * The floating panel every canonical picker opens.
 *
 * It renders through a PORTAL to `document.body` and anchors itself to the
 * trigger in viewport coordinates, because an in-place `absolute` panel's
 * visibility is decided by markup this package does not own. Measured in
 * production: the shipped chat composer docks these controls inside a
 * horizontally scrolling rail (`overflow-x-auto`), and a scroll container
 * clips every positioned descendant whose containing block sits inside it —
 * so a correct 420x457 menu with correct coordinates painted zero pixels and
 * could not be clicked. An ancestor `transform`/`filter`/`contain` would trap
 * it the same way through the stacking context instead of the clip. Leaving
 * the DOM subtree is the only placement a host cannot re-break.
 *
 * Placement prefers ABOVE the trigger (these controls dock at the bottom of a
 * composer), flips below when there is more room there, clamps horizontally
 * into the viewport, and caps its own height to the space on the chosen side.
 * The panel is `visibility: hidden` for the measure pass so it never paints at
 * the pre-placement origin.
 */
export declare function PopoverSurface({ open, triggerRef, panelRef, className, role, id, matchTriggerWidth, children, }: PopoverSurfaceProps): import("react").ReactPortal | null;
/**
 * Focus treatment for a row inside a popover panel.
 *
 * The ring itself now comes from the `:focus-visible` floor in tokens.css, so
 * this no longer restates a width or a colour. What it still has to say is
 * WHERE the ring is drawn: a popover option is a full-width row inside a panel
 * that clips its own corners (`overflow-hidden rounded-xl`), and an outward
 * ring on the first or last row is clipped away by that panel. Pulling the
 * offset negative draws the same ring just inside the row instead.
 */
export declare const POPOVER_OPTION_FOCUS = "focus-visible:[outline-offset:-2px]";
/**
 * The one overlay elevation for floating surfaces — picker menus, popovers,
 * drawers, modals. Reads the theme's `--shadow-overlay` token, so every overlay
 * lifts with the same shadow and re-themes from one source. The floating
 * composer uses the quieter `shadow-raised` rung instead.
 *
 * Written as an arbitrary value rather than the preset's `shadow-overlay`
 * utility, because that utility only exists where the preset is part of the
 * Tailwind build. A host that gets its tokens through a precompiled bundle —
 * `@tangle-network/sandbox-ui` ships brand's tokens inlined, with no `@theme`
 * block surviving the compile — receives `--shadow-overlay` as a plain custom
 * property, from which no `shadow-overlay` utility can be generated, and these
 * surfaces render flat. The arbitrary form emits from the class alone and works
 * either way.
 */
export declare const OVERLAY_SHADOW = "shadow-[var(--shadow-overlay)]";
/**
 * Root geometry for a picker — the box that holds the trigger — in one place
 * because every picker in this family has to agree on it.
 *
 * Shrink-wrapping (`inline-flex`) is the default: these controls dock on a
 * composer row where an expanding pill shoves its neighbours around. A STACKED
 * panel wants the opposite — the compact `AgentSessionControls` gear popover
 * lays its controls out in a column, and a shrink-wrapped root there makes a
 * trigger's own `w-full` a no-op, since it fills a box the trigger itself
 * sized. That is what left Agent backend short of the panel edge and Thinking
 * narrower still.
 *
 * The panel is portaled ({@link PopoverSurface}), so widening the root widens
 * the TRIGGER only. A menu that should follow it declares `matchTriggerWidth`.
 */
export declare function pickerRootClass(fullWidth: boolean): string;
/**
 * How a picker's TRIGGER is drawn. The menu it opens is the same either way.
 *
 *  - `chip` (default): the 36px bordered pill — `rounded-full border
 *    border-border bg-card font-medium`. A consumer that names no variant
 *    renders exactly what it rendered before this prop existed.
 *  - `quiet`: a 28px borderless text button — muted label, small glyph, a
 *    surface fill on hover and while the menu is open, nothing else. For a
 *    composer whose card already draws the border: three pills docked under
 *    the input there read as three more cards, not as the input's controls.
 */
export type PickerVariant = 'chip' | 'quiet';
/**
 * Trigger classes for a `quiet` picker. Height, padding, radius, and type are
 * fixed here so the triggers on one composer row agree; a caller adds only
 * width (`w-full`) and alignment (`justify-between`).
 *
 * The focus ring is drawn on the element rather than left to the tokens.css
 * `:focus-visible` floor: a quiet trigger sits beside the composer's own action
 * buttons (attach, dictate, send), which draw `focus-visible:ring-2
 * focus-visible:ring-ring`, and a row whose controls answer keyboard focus two
 * different ways reads as two families.
 *
 * `interactive: false` is for a PINNED control (see `HarnessPicker`'s
 * `lockReason`): it keeps the resting treatment and draws no hover or open
 * fill, because a fill promises a menu the control will not open.
 */
export declare function quietPickerTriggerClass({ interactive }?: {
    interactive?: boolean;
}): string;
/**
 * Guard an async action against double-submit. `run` ignores re-entrant calls
 * while a promise is in flight and flips `pending` so the caller can disable
 * the control — the fix for double-charge / double-approve on a slow network.
 * Settles (success or throw) before clearing, and no-ops state updates after
 * unmount.
 */
export declare function usePending(): {
    pending: boolean;
    run: (action: () => void | Promise<void>) => void;
};
export interface ModelPickerProps {
    value: string;
    onChange: (id: string) => void;
    /** Catalogue models — from `GET`ing the app's catalogue route (see
     *  `runtime/model-catalog`), plus any product-specific entries appended. */
    models: CatalogModel[];
    loading?: boolean;
    /** Render a provider logo/badge; default is a generic sparkle. */
    renderProviderBadge?: (provider: string) => ReactNode;
    /** Section label for `featured` models. */
    recommendedLabel?: string;
    /** Pin a labeled section to the TOP of the list (above Recommended) for the
     *  models a product wants surfaced first — e.g. a tuner app's own fine-tuned
     *  models (`{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'tuner' }`).
     *  Matching models are shown only in this section, not duplicated below. */
    priorityGroup?: {
        label: string;
        match: (model: CatalogModel) => boolean;
    };
    /** Trigger treatment — see {@link PickerVariant}. Default `chip`. */
    variant?: PickerVariant;
}
/**
 * Searchable model picker pill + popover. A featured model is recommended
 * only when it is also that provider's newest entry. Older featured models
 * stay visible in their provider group instead of jumping above new releases.
 *
 * This is the CANONICAL ecosystem model picker (see "UI chrome ownership
 * (picker canon)" in AGENTS.md). sandbox-ui's `dashboard/ModelPicker` is
 * legacy — deprecated, frozen, removed at sandbox-ui's next major; new code
 * belongs here.
 */
export declare function ModelPicker({ value, onChange, models, loading, renderProviderBadge, recommendedLabel, priorityGroup, variant }: ModelPickerProps): import("react").JSX.Element;
/** One reasoning-budget level: the engine `id` is unchanged (the value the
 *  product sends to the loop); only the user-facing `label` is renamed to the
 *  plainer "how hard should it think" vocabulary from docs/product-surfaces.md.
 *  `low`→Quick, `medium`→Standard, `high`→Extended. The mapping is overridable
 *  via `EffortPickerProps.levels`, so a product can relabel without losing the
 *  ids the runtime expects. */
export interface EffortLevel {
    id: string;
    label: string;
}
export declare const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[];
/**
 * The user-facing label for an engine level id: the canonical vocabulary when
 * the id is one this package names, otherwise the id itself made readable
 * (`auto` -> "Auto", `ultra-code` -> "Ultra code"). Never invents a depth word,
 * so an id nobody declared a label for still reads as ITSELF and never as some
 * other level.
 */
export declare function effortLevelLabel(id: string): string;
/**
 * Build a levels list from the engine ids a backend applies — the shape the
 * removed `ComposerAgentControls` took as `reasoning.available`, so a product
 * migrating that list has one call to make instead of a hand-written label map
 * per product (which is how "Quick" and "Low" drift apart across surfaces).
 */
export declare function effortLevelsFromIds(ids: readonly string[]): readonly EffortLevel[];
/**
 * The list {@link EffortPicker} RENDERS for `value` — the declared levels, plus
 * `value` itself when the declaration omits it.
 *
 * A picker cannot honestly resolve a selected value it was not given, and the
 * failure it used to take instead — fall back to the middle entry — renders the
 * session's real depth as a DIFFERENT level's name. That is exactly the defect
 * `levels` was added to prevent: the legacy adapter's `available` list excluded
 * the `auto` sentinel because the old picker injected it, so a product mapping
 * that list straight across ships a session running on `auto` labelled
 * "Extended". Admitting the value is not offering a new choice — it is
 * reporting the state the session is already in, and it disappears from the
 * list as soon as the user picks a declared level.
 *
 * A blank value is not admitted (there is no honest label for it); the picker
 * renders no selection instead.
 */
export declare function reconcileEffortLevels(value: string, levels?: readonly EffortLevel[]): readonly EffortLevel[];
/** Segments the meter draws — fixed geometry so the ladder stays tabular
 *  across levels (and across the trigger and its menu rows). */
export declare const EFFORT_METER_SEGMENTS = 4;
/**
 * Filled-segment count for a level: 0 for off/none (or an id the levels list
 * does not carry); otherwise the level's position among the non-off choices
 * scaled onto the meter, so the ladder reads low < medium < high and the top
 * level fills the whole scale. The canonical four levels land 0 / 1 / 2 / 4.
 */
export declare function effortMeterFill(levelId: string, levels?: readonly EffortLevel[]): number;
/**
 * The thinking-strength meter: four 12px bars, filled count = level, filled
 * opacity ramping 25→100% left to right (unfilled at a faint ghost). Purely
 * decorative — the level name is always rendered as text beside it, so the
 * meter is `aria-hidden` and adds no second accessible name.
 */
export declare function EffortMeter({ fill, className }: {
    fill: number;
    className?: string;
}): import("react").JSX.Element;
export interface EffortPickerProps {
    value: string;
    onChange: (id: string) => void;
    /** Selectable levels (engine id + user-facing label). Defaults to the plain
     *  "Thinking" vocabulary; override to relabel without changing the ids the
     *  runtime receives.
     *
     *  A list that omits the current `value` is not a rendering error the picker
     *  papers over: `value` is reconciled INTO the rendered list under its own
     *  name (see {@link reconcileEffortLevels}), because a control must report
     *  the depth the session is running at and never some other list entry. */
    levels?: readonly EffortLevel[];
    /** Prefix shown before the active level on the pill — the "what is this"
     *  context the bare value lacked. Default "Thinking". Pass '' to hide it. */
    label?: string;
    /** Fill the container instead of shrink-wrapping — opt-in, default `false`;
     *  see {@link pickerRootClass} for when and why. */
    fullWidth?: boolean;
    /** Trigger treatment — see {@link PickerVariant}. Default `chip`. */
    variant?: PickerVariant;
}
/** Thinking-budget selector pill, styled to match {@link ModelPicker}. Show
 *  it only when the selected model `supportsReasoning`. "Thinking" is the
 *  plain-English name for what was internally called "effort".
 *
 *  The CANONICAL ecosystem effort picker — sandbox-ui's reasoning menu (inside
 *  its `chat/AgentSessionControls`) is legacy and frozen. */
export declare function EffortPicker({ value, onChange, levels, label, fullWidth, variant }: EffortPickerProps): import("react").JSX.Element;
