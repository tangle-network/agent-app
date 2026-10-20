/** Shared picker geometry, focus, and theme presentation. */
import { fieldPresentation, fieldSizes, fieldTouchText } from '@tangle-network/ui/presentation'

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
export const POPOVER_OPTION_FOCUS = 'focus-visible:[outline-offset:-2px]'

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
export const OVERLAY_SHADOW = 'shadow-[var(--shadow-overlay)]'

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
export function pickerRootClass(fullWidth: boolean): string {
  return `relative ${fullWidth ? 'flex w-full' : 'inline-flex'}`
}

/**
 * How a picker's TRIGGER is drawn. The menu it opens is the same either way.
 *
 *  - `chip` (default): the 32px bordered pill — `rounded-full border
 *    border-border bg-card font-medium`, on the composer row's height.
 *  - `quiet`: a 32px borderless text button (the control scale's sm, the
 *    composer row's one height) — muted label, small glyph, a
 *    surface fill on hover and while the menu is open, nothing else. For a
 *    composer whose card already draws the border: three pills docked under
 *    the input there read as three more cards, not as the input's controls.
 *  - `field`: a full-width form field — the same height, radius, border,
 *    well, and focus treatment as a text input at `--control-height`. For a
 *    settings form, where a pill among inputs reads as a different control.
 */
export type PickerVariant = 'chip' | 'quiet' | 'field'

/**
 * Trigger classes for a `field` picker: `@tangle-network/ui`'s own field
 * presentation and `md` field size, the classes its `Input` and `SelectTrigger`
 * draw, so a model, harness or timezone selector sits in a form as one more
 * field — the same well on every plane, the same border, hover and focus halo.
 */
export function fieldPickerTriggerClass({ interactive = true }: { interactive?: boolean } = {}): string {
  return `${fieldPresentation} ${fieldSizes.md} ${fieldTouchText} inline-flex w-full min-w-0 items-center justify-between gap-2 whitespace-nowrap border text-left font-normal text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
    interactive ? 'data-[state=open]:border-[var(--ix-hover-border)] data-[state=open]:shadow-[var(--ix-after)]' : 'cursor-default'}`
}

/** The chip trigger: a fixed 32px height (no vertical padding, so the 20px
 *  line and the border cannot push it to 34px). A full-width EffortPicker in a
 *  settings panel keeps the 36px field row instead. */
export const CHIP_PICKER_TRIGGER =
  'inline-flex h-[var(--control-height-sm,2rem)] items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground transition'

/** The quiet trigger at rest: geometry, type, and keyboard focus. */
const QUIET_PICKER_TRIGGER_BASE =
  'inline-flex h-[var(--control-height-sm,2rem)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-transparent px-2 text-sm font-normal text-muted-foreground transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The fills a quiet trigger shows on hover and while its menu is open — the
 *  only two states it draws. Reads `data-state`, which every picker trigger
 *  in this family stamps. */
const QUIET_PICKER_TRIGGER_INTERACTIVE =
  'hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

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
export function quietPickerTriggerClass({ interactive = true }: { interactive?: boolean } = {}): string {
  return interactive
    ? `${QUIET_PICKER_TRIGGER_BASE} ${QUIET_PICKER_TRIGGER_INTERACTIVE}`
    : `${QUIET_PICKER_TRIGGER_BASE} cursor-default`
}
