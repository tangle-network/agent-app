/** Reasoning-level selection and effort-meter presentation. */
import { useId, useState } from 'react'
import { BrainGlyph, ChevronDown, CheckGlyph } from './control-glyphs'
import { usePopover, PopoverSurface } from './popover-surface'
import { CHIP_PICKER_TRIGGER, OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, pickerRootClass, fieldPickerTriggerClass, quietPickerTriggerClass, type PickerVariant } from './picker-presentation'

/** One reasoning-budget level: the engine `id` is unchanged (the value the
 *  product sends to the loop); only the user-facing `label` is renamed to the
 *  plainer "how hard should it think" vocabulary from docs/product-surfaces.md.
 *  `low`→Quick, `medium`→Standard, `high`→Extended. The mapping is overridable
 *  via `EffortPickerProps.levels`, so a product can relabel without losing the
 *  ids the runtime expects. */
export interface EffortLevel {
  id: string
  label: string
}

/**
 * The engine ids this package NAMES, and the word each one reads as.
 *
 * Deliberately WIDER than {@link DEFAULT_EFFORT_LEVELS}: the default list is
 * what a picker OFFERS when a product declares nothing, while this is the
 * vocabulary — the labels a named id keeps wherever it appears. The two are
 * different questions, and folding them together is what made a real engine
 * rung read as its own id: `xhigh` and `ultracode` are rungs claude-code
 * applies above `high`, so a product declaring them got "Xhigh" while every
 * neighbouring rung had a plain English word. Naming them here is what stops
 * each product inventing its own — the drift `effortLevelsFromIds` exists to
 * prevent. They stay OUT of the offered default because most backends do not
 * apply them, and offering a rung the backend ignores is the defect
 * `effortLevels` was added to close.
 */
const KNOWN_EFFORT_LABELS = {
  off: 'Off',
  low: 'Quick',
  medium: 'Standard',
  high: 'Extended',
  xhigh: 'Extra',
  ultracode: 'Ultra',
} as const

export const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[] = [
  { id: 'off', label: KNOWN_EFFORT_LABELS.off },
  { id: 'low', label: KNOWN_EFFORT_LABELS.low },
  { id: 'medium', label: KNOWN_EFFORT_LABELS.medium },
  { id: 'high', label: KNOWN_EFFORT_LABELS.high },
]

/**
 * The user-facing label for an engine level id: the canonical vocabulary when
 * the id is one this package names, otherwise the id itself made readable
 * (`auto` -> "Auto", `ultra-code` -> "Ultra code"). Never invents a depth word,
 * so an id nobody declared a label for still reads as ITSELF and never as some
 * other level.
 */
export function effortLevelLabel(id: string): string {
  const known = (KNOWN_EFFORT_LABELS as Record<string, string | undefined>)[id]
  if (known) return known
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id
}

/**
 * Build a levels list from the engine ids a backend applies — the shape the
 * removed `ComposerAgentControls` took as `reasoning.available`, so a product
 * migrating that list has one call to make instead of a hand-written label map
 * per product (which is how "Quick" and "Low" drift apart across surfaces).
 */
export function effortLevelsFromIds(ids: readonly string[]): readonly EffortLevel[] {
  return ids.map((id) => ({ id, label: effortLevelLabel(id) }))
}

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
export function reconcileEffortLevels(
  value: string,
  levels: readonly EffortLevel[] = DEFAULT_EFFORT_LEVELS,
): readonly EffortLevel[] {
  if (!value || levels.some((l) => l.id === value)) return levels
  return [{ id: value, label: effortLevelLabel(value) }, ...levels]
}

// ── effort strength meter ─────────────────────────────────────────────────

/** Segments the meter draws — fixed geometry so the ladder stays tabular
 *  across levels (and across the trigger and its menu rows). */
export const EFFORT_METER_SEGMENTS = 4

/** Filled-segment opacity ladder: translucent on the left, heavy on the
 *  right — the ramp carries strength even at a glance, the count carries it
 *  exactly. Unfilled segments sit at a fixed ghost opacity. */
const EFFORT_METER_FILL_OPACITY = [0.25, 0.5, 0.75, 1] as const
const EFFORT_METER_GHOST_OPACITY = 0.15

/** Level ids that mean "no reasoning" — the meter renders all-ghost. */
const OFF_LEVEL_IDS: ReadonlySet<string> = new Set(['off', 'none'])

/**
 * Ids that name a POLICY rather than a depth: `auto` means "let the harness and
 * model decide", so it has no position on a strength ladder.
 *
 * Without this it lands wherever the declaration puts it and draws a filled
 * meter — measured on a product that offers `auto` first: every harness read
 * `Auto` at a FULL four bars, including `cli-base`, which has no agent to think
 * at all. A meter is a claim about how hard the run will think, and a sentinel
 * cannot make that claim.
 */
const UNPLACEABLE_LEVEL_IDS: ReadonlySet<string> = new Set(['auto'])

/**
 * Filled-segment count for a level: 0 for off/none (or an id the levels list
 * does not carry); otherwise the level's position among the non-off choices
 * scaled onto the meter, so the ladder reads low < medium < high and the top
 * level fills the whole scale. The canonical four levels land 0 / 1 / 2 / 4.
 */
export function effortMeterFill(
  levelId: string,
  levels: readonly EffortLevel[] = DEFAULT_EFFORT_LEVELS,
): number {
  if (OFF_LEVEL_IDS.has(levelId) || UNPLACEABLE_LEVEL_IDS.has(levelId)) return 0
  const active = levels.filter((l) => !OFF_LEVEL_IDS.has(l.id) && !UNPLACEABLE_LEVEL_IDS.has(l.id))
  const index = active.findIndex((l) => l.id === levelId)
  if (index < 0 || active.length === 0) return 0
  return Math.max(1, Math.floor(((index + 1) * EFFORT_METER_SEGMENTS) / active.length))
}

/**
 * The thinking-strength meter: four 12px bars, filled count = level, filled
 * opacity ramping 25→100% left to right (unfilled at a faint ghost). Purely
 * decorative — the level name is always rendered as text beside it, so the
 * meter is `aria-hidden` and adds no second accessible name.
 */
export function EffortMeter({ fill, className }: { fill: number; className?: string }) {
  return (
    <span aria-hidden className={`inline-flex items-center gap-[2px] ${className ?? ''}`}>
      {Array.from({ length: EFFORT_METER_SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="h-3 w-[3px] rounded-full bg-current"
          style={{ opacity: i < fill ? EFFORT_METER_FILL_OPACITY[i] : EFFORT_METER_GHOST_OPACITY }}
        />
      ))}
    </span>
  )
}

export interface EffortPickerProps {
  value: string
  onChange: (id: string) => void
  /** Selectable levels (engine id + user-facing label). Defaults to the plain
   *  "Thinking" vocabulary; override to relabel without changing the ids the
   *  runtime receives.
   *
   *  A list that omits the current `value` is not a rendering error the picker
   *  papers over: `value` is reconciled INTO the rendered list under its own
   *  name (see {@link reconcileEffortLevels}), because a control must report
   *  the depth the session is running at and never some other list entry. */
  levels?: readonly EffortLevel[]
  /** Prefix shown before the active level on the pill — the "what is this"
   *  context the bare value lacked. Default "Thinking". Pass '' to hide it. */
  label?: string
  /** Fill the container instead of shrink-wrapping — opt-in, default `false`;
   *  see {@link pickerRootClass} for when and why. */
  fullWidth?: boolean
  /** Trigger treatment — see {@link PickerVariant}. Default `chip`. */
  variant?: PickerVariant
  /** Disable the trigger and close an open menu; does not change the value. */
  disabled?: boolean
  /** Associations belong to the trigger button, for a picker labelled by a form field. */
  id?: string
  'aria-describedby'?: string
}

/** Thinking-budget selector pill, styled to match {@link ModelPicker}. Show
 *  it only when the selected model `supportsReasoning`. "Thinking" is the
 *  plain-English name for what was internally called "effort".
 *
 *  The CANONICAL ecosystem effort picker — sandbox-ui's reasoning menu (inside
 *  its `chat/AgentSessionControls`) is legacy and frozen. */
export function EffortPicker({ value, onChange, levels = DEFAULT_EFFORT_LEVELS, label = 'Thinking', fullWidth = false, variant = 'chip',
  disabled = false, id, 'aria-describedby': ariaDescribedBy }: EffortPickerProps) {
  const [requestedOpen, setOpen] = useState(false)
  const open = requestedOpen && !disabled
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const field = variant === 'field'
  const panelId = useId()
  const rendered = reconcileEffortLevels(value, levels)
  // The strength ladder is computed over the DECLARED levels only, so admitting
  // the selected value cannot shift where the declared ones sit on the meter.
  // A level the declaration does not carry has no position on that ladder, so
  // it renders with NO meter — an all-ghost meter is what `off` looks like, and
  // "we cannot place this" is not "no thinking".
  const isDeclared = (id: string) => levels.some((l) => l.id === id) && !UNPLACEABLE_LEVEL_IDS.has(id)
  const selected = rendered.find((l) => l.id === value)

  return (
    <div ref={containerRef} className={pickerRootClass(fullWidth || field)}>
      <button
        type="button"
        {...triggerProps}
        id={id}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        title={label ? `${label} — how hard the agent reasons before answering` : 'Reasoning effort'}
        data-state={open ? 'open' : 'closed'}
        className={`${
          field
            ? fieldPickerTriggerClass({ interactive: !disabled })
            : variant === 'quiet'
            ? quietPickerTriggerClass()
            : fullWidth
            ? 'inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent'
            : `${CHIP_PICKER_TRIGGER} shrink-0 hover:bg-accent`
        } ${fullWidth ? 'w-full' : ''}`}
      >
        <BrainGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {/* Full width gives the label the slack, so the meter and chevron park
            on the trailing edge and the glyph stays against the text. */}
        <span className={fullWidth || field ? 'flex-1 truncate text-left' : undefined}>
          {label ? <span className="text-muted-foreground">{label}: </span> : null}
          {selected ? selected.label : '—'}
        </span>
        {/* Quiet inherits the trigger's tone, so the meter is muted at rest
            and lifts with the label on hover instead of staying at full foreground. */}
        {selected && isDeclared(selected.id) && (
          <EffortMeter
            fill={effortMeterFill(selected.id, levels)}
            className={variant === 'quiet' ? 'shrink-0' : 'shrink-0 text-foreground'}
          />
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        // A portaled panel has no `w-full` to inherit, so a full-width trigger
        // hands its measured width to the panel instead.
        matchTriggerWidth={fullWidth || field}
        side={field ? 'below' : undefined}
        className={`w-44 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`}
      >
          {rendered.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={l.id === value}
              onClick={() => {
                onChange(l.id)
                setOpen(false)
              }}
              className={`flex min-h-[40px] w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${
                l.id === value ? 'bg-primary/10 font-medium' : 'hover:bg-accent'
              }`}
            >
              <BrainGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{l.label}</span>
              {isDeclared(l.id) && (
                <EffortMeter fill={effortMeterFill(l.id, levels)} className="ml-auto text-foreground" />
              )}
              {l.id === value && (
                <CheckGlyph className={`${isDeclared(l.id) ? '' : 'ml-auto '}h-3.5 w-3.5 shrink-0 text-primary`} />
              )}
            </button>
          ))}
      </PopoverSurface>
    </div>
  )
}
