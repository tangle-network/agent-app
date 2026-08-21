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

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import { ImagePlus, TriangleAlert, Volume2, VolumeX, X, type LucideIcon } from 'lucide-react'
import {
  CheckGlyph,
  ChevronDown,
  OVERLAY_SHADOW,
  POPOVER_OPTION_FOCUS,
  PopoverSurface,
  usePopover,
} from '../web-react/controls'
import { ProviderLogo } from '../web-react/provider-logo'
import { type MediaModelOption, type ModelOptionValue, validateCustomImageSize } from '../studio'

/** The resting pill: one row height, never wraps, shrink-proof in the band. */
const PILL = 'inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground transition hover:bg-accent'
/**
 * Optically centers a pill label. Flex `items-center` centers the LINE BOX, but
 * where the glyphs sit inside it is font-metric-determined — with an
 * ascent-heavy font the text reads ~1.5px high. Trimming the line box to the
 * cap→baseline band makes flex centering center the visible text in every
 * font; unsupported browsers keep the untrimmed (current) behavior.
 */
const PILL_LABEL = '[text-box:trim-both_cap_alphabetic]'
const MENU_PANEL = `flex min-w-[184px] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground ${OVERLAY_SHADOW}`
const MENU_HEADER = 'px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground'

function menuRowClass(selected: boolean): string {
  return `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition ${POPOVER_OPTION_FOCUS} ${
    selected ? 'bg-primary/10 font-medium' : 'hover:bg-accent'
  }`
}

/** Deepest edge fade, in px. Beyond this the fade stops reading as "there is
 *  more" and starts reading as a vignette. */
const MAX_FADE = 32

/** One media lane's segment: the icon it shows collapsed, the word it shows
 *  when active. */
export interface MediaTypeSegment<T extends string> {
  type: T
  label: string
  icon: LucideIcon
}

/**
 * The pinned-left media-type group: a track holding one filled pill (the active
 * lane, icon + word) and icon-only siblings. `aria-pressed` carries the state
 * and `aria-label` carries the word the collapsed items drop.
 */
export function MediaTypeSegments<T extends string>({
  value,
  segments,
  onChange,
}: {
  value: T
  segments: readonly MediaTypeSegment<T>[]
  onChange: (type: T) => void
}) {
  return (
    <div
      role="group"
      aria-label="Media type"
      className="flex flex-none items-center gap-0.5 rounded-full border border-border bg-muted p-[3px]"
    >
      {segments.map(({ type, label, icon: Icon }) => {
        const active = type === value
        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(type)}
            className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full text-[12.5px] transition ${
              active
                ? 'bg-card px-2.5 font-medium text-foreground shadow-sm'
                : 'px-2 text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            {active && <span>{label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The middle scroller. It hides its scrollbar and fades whichever edge has
 * content behind it, at the DEPTH of what is actually hidden (capped at
 * {@link MAX_FADE}) rather than a fixed gradient that claims more is off-screen
 * than there is. A media-type switch resets the scroll to the start, because
 * the control set itself changed; every other re-render leaves `scrollLeft`
 * alone, so picking a value cannot jump the band back to the beginning.
 */
export function ComposerBand({
  bandRef,
  resetKey,
  children,
}: {
  bandRef: RefObject<HTMLDivElement | null>
  /** Changing this scrolls the band back to the start. */
  resetKey: string
  children: ReactNode
}) {
  const sync = useCallback(() => {
    const band = bandRef.current
    if (!band) return
    const hiddenStart = band.scrollLeft
    const hiddenEnd = Math.max(0, band.scrollWidth - band.clientWidth - band.scrollLeft)
    const atStart = hiddenStart > 1
    const atEnd = hiddenEnd > 1
    band.dataset.overflow = atStart && atEnd ? 'both' : atStart ? 'start' : atEnd ? 'end' : 'none'
    band.style.setProperty('--fade-start', `${atStart ? Math.min(MAX_FADE, hiddenStart) : 0}px`)
    band.style.setProperty('--fade-end', `${atEnd ? Math.min(MAX_FADE, hiddenEnd) : 0}px`)
  }, [bandRef])

  // After every render: the pill set changes with the model and the lane, so
  // the hidden width this reads is only correct once the new pills are laid out.
  useEffect(sync)

  useEffect(() => {
    const band = bandRef.current
    window.addEventListener('resize', sync)
    // jsdom and older browsers have no ResizeObserver; the window listener still
    // covers the case that matters (the viewport getting narrower).
    const observer = typeof ResizeObserver === 'undefined' || !band ? null : new ResizeObserver(sync)
    if (band) observer?.observe(band)
    return () => {
      window.removeEventListener('resize', sync)
      observer?.disconnect()
    }
  }, [bandRef, sync])

  useEffect(() => {
    const band = bandRef.current
    if (band) band.scrollLeft = 0
    sync()
  }, [bandRef, resetKey, sync])

  return (
    <div
      ref={bandRef}
      data-overflow="none"
      onScroll={sync}
      className="studio-band flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto"
    >
      {children}
    </div>
  )
}

/**
 * Close an open menu once its pill has been scrolled out of the band.
 *
 * `PopoverSurface` re-anchors on scroll, so a menu follows its pill for free —
 * which is right until the pill leaves the band entirely and the menu is left
 * pointing at a clipped edge. The centre is the test rather than either edge: a
 * pill half-way out is still the pill the user opened.
 */
function useCloseWhenScrolledOut(
  open: boolean,
  setOpen: (open: boolean) => void,
  triggerRef: RefObject<HTMLElement | null>,
  bandRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const band = bandRef.current
    if (!open || !band) return
    const onScroll = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const anchor = trigger.getBoundingClientRect()
      const box = band.getBoundingClientRect()
      const centre = anchor.left + anchor.width / 2
      if (centre < box.left || centre > box.right) setOpen(false)
    }
    band.addEventListener('scroll', onScroll)
    return () => band.removeEventListener('scroll', onScroll)
  }, [bandRef, open, setOpen, triggerRef])
}

/** One renderable value: the wire value, untouched, and how it reads. */
export interface OptionChoice {
  value: ModelOptionValue
  label: string
  icon?: LucideIcon
}

function MenuRows<T extends ModelOptionValue>({
  value,
  choices,
  onSelect,
}: {
  value: T | undefined
  choices: readonly { value: T; label: string; icon?: LucideIcon }[]
  onSelect: (value: T) => void
}) {
  return choices.map((choice) => {
    const Icon = choice.icon
    return (
      <button
        key={String(choice.value)}
        type="button"
        role="menuitemradio"
        aria-checked={choice.value === value}
        onClick={() => onSelect(choice.value)}
        className={menuRowClass(choice.value === value)}
      >
        {Icon && <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />}
        <span className="truncate">{choice.label}</span>
        {choice.value === value && (
          <CheckGlyph className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
        )}
      </button>
    )
  })
}

/** A standalone enum picker using the studio composer's pill and menu grammar. */
export function MenuPill<T extends string>({
  label,
  value,
  choices,
  onSelect,
  className,
  icon: Icon,
  trigger = 'pill',
}: {
  label: string
  value: T
  choices: readonly { value: T; label: string; icon?: LucideIcon }[]
  onSelect: (value: T) => void
  className?: string
  icon?: LucideIcon
  trigger?: 'pill' | 'text'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()
  const selected = choices.find((choice) => choice.value === value)

  return (
    <div ref={containerRef} className="relative inline-flex flex-none">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        title={label}
        aria-label={label}
        onClick={() => setOpen(!open)}
        className={`${trigger === 'text'
          ? 'inline-flex h-7 flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12.5px] font-medium text-primary transition hover:bg-accent'
          : PILL} ${className ?? ''}`}
      >
        {Icon && <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
        <span className={PILL_LABEL}>{selected?.label ?? '—'}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 ${trigger === 'text' ? 'text-primary' : 'text-muted-foreground'}`} />
      </button>

      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={MENU_PANEL}
      >
        <div className={MENU_HEADER}>{label}</div>
        <MenuRows
          value={value}
          choices={choices}
          onSelect={(next) => {
            onSelect(next)
            setOpen(false)
          }}
        />
      </PopoverSurface>
    </div>
  )
}

/**
 * A value pill and the menu it opens.
 *
 * The pill shows the VALUE and carries the parameter name in `title` and in its
 * accessible name — a band of eight labelled pills does not fit a chat card,
 * and "5s" alone tells a screen-reader user nothing about which parameter it
 * belongs to.
 */
export function OptionPill({
  label,
  value,
  choices,
  onSelect,
  bandRef,
  custom,
  icon: Icon,
}: {
  label: string
  value: ModelOptionValue | undefined
  choices: readonly OptionChoice[]
  onSelect: (value: ModelOptionValue) => void
  bandRef: RefObject<HTMLDivElement | null>
  icon?: LucideIcon
  /** A trailing row that swaps the menu to a form (the gpt-image-2 custom
   *  size). Absent for every parameter whose values are an enum. */
  custom?: {
    label: string
    render: (args: { close: () => void }) => ReactNode
  }
}) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef)

  const selected = choices.find((choice) => choice.value === value)
  const close = () => {
    setOpen(false)
    setCustomOpen(false)
  }

  return (
    <div ref={containerRef} className="relative inline-flex flex-none">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        title={label}
        aria-label={`${label}: ${selected?.label ?? 'not set'}`}
        onClick={() => {
          setCustomOpen(false)
          setOpen(!open)
        }}
        className={PILL}
      >
        {Icon && <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
        <span className={PILL_LABEL}>{selected?.label ?? '—'}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      <PopoverSurface
        open={open}
        id={panelId}
        role={customOpen ? undefined : 'menu'}
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={MENU_PANEL}
      >
        <div className={MENU_HEADER}>{label}</div>
        {customOpen && custom
          ? custom.render({ close })
          : (
            <>
              <MenuRows
                value={value}
                choices={choices}
                onSelect={(next) => {
                  onSelect(next)
                  close()
                }}
              />
              {custom && (
                <button
                  type="button"
                  onClick={() => setCustomOpen(true)}
                  className={`${menuRowClass(false)} text-muted-foreground`}
                >
                  {custom.label}
                </button>
              )}
            </>
          )}
      </PopoverSurface>
    </div>
  )
}

/**
 * The custom-size form the Size menu swaps to.
 *
 * The reason a size is refused renders next to the fields that are wrong — a
 * toast would be gone by the time the user looks back at the inputs — and Apply
 * refuses rather than disables, so the reason is always reachable.
 */
export function CustomSizeForm({
  initial,
  onApply,
  onCancel,
}: {
  initial?: string
  onApply: (size: string) => void
  onCancel: () => void
}) {
  const parsed = /^(\d+)x(\d+)$/.exec(initial ?? '')
  const [width, setWidth] = useState(parsed?.[1] ?? '')
  const [height, setHeight] = useState(parsed?.[2] ?? '')
  const [error, setError] = useState<string | null>(null)
  const fieldClass = 'h-8 w-[74px] rounded-md border border-input bg-background px-2 text-[13px] tabular-nums'

  function apply() {
    const verdict = validateCustomImageSize(Number(width), Number(height))
    if (!verdict.ok) {
      setError(verdict.reason)
      return
    }
    onApply(`${Number(width)}x${Number(height)}`)
  }

  return (
    <div className="flex w-[228px] flex-col gap-2 p-1.5">
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={width}
          aria-label="Custom width"
          onChange={(event) => {
            setWidth(event.target.value)
            setError(null)
          }}
          className={fieldClass}
        />
        <span aria-hidden className="text-muted-foreground">×</span>
        <input
          type="number"
          value={height}
          aria-label="Custom height"
          onChange={(event) => {
            setHeight(event.target.value)
            setError(null)
          }}
          className={fieldClass}
        />
      </div>
      {error
        ? <p className="text-[12px] text-destructive">{error}</p>
        : <p className="text-[12px] text-muted-foreground">Multiples of 16, long edge up to 3840, ratio between 1:3 and 3:1.</p>}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          className="rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

/**
 * The audio switch. It is a toggle rather than a menu because the parameter has
 * exactly two states, and a two-row menu to say "on" is a menu that costs a
 * click for nothing.
 */
export function AudioTogglePill({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title="Audio"
      onClick={() => onToggle(!on)}
      className={`${PILL} ${on ? '' : 'text-muted-foreground'}`}
    >
      {on
        ? <Volume2 className="h-4 w-4 shrink-0" strokeWidth={1.5} />
        : <VolumeX className="h-4 w-4 shrink-0" strokeWidth={1.5} />}
      <span className={PILL_LABEL}>{on ? 'Audio on' : 'Audio off'}</span>
    </button>
  )
}

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
export function ReferencePill({
  url,
  onAttach,
  onRemove,
  pick,
  bandRef,
}: {
  url: string | null
  onAttach: (url: string) => void
  onRemove: () => void
  pick?: () => Promise<string | null>
  bandRef: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { containerRef, triggerRef, panelRef } = usePopover(open, setOpen)
  const panelId = useId()
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef)

  if (url) {
    return (
      <div className={`${PILL} border-primary bg-primary/10 pr-1.5 text-primary hover:bg-primary/10`}>
        <img src={url} alt="" className="h-[18px] w-[18px] shrink-0 rounded-[5px] object-cover" />
        <span className={PILL_LABEL}>Reference</span>
        <button
          type="button"
          aria-label="Remove reference image"
          onClick={onRemove}
          className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition hover:bg-primary/20"
        >
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
    )
  }

  function attach() {
    const value = draft.trim()
    if (!/^https?:\/\//i.test(value)) {
      setError('Enter a URL starting with http:// or https://')
      return
    }
    onAttach(value)
    setDraft('')
    setError(null)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative inline-flex flex-none">
      <button
        type="button"
        ref={triggerRef}
        // With a `pick` seam the button opens the host's own picker, not a
        // popover — claiming `aria-haspopup` there announces a menu that never
        // appears.
        {...(pick ? {} : { 'aria-haspopup': true as const, 'aria-expanded': open, 'aria-controls': open ? panelId : undefined })}
        title="Reference image"
        onClick={() => {
          if (!pick) {
            setOpen(!open)
            return
          }
          void pick().then((picked) => {
            if (picked) onAttach(picked)
          })
        }}
        className={PILL}
      >
        <ImagePlus className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <span className={PILL_LABEL}>Reference image</span>
      </button>

      {!pick && (
        <PopoverSurface
          open={open}
          id={panelId}
          triggerRef={triggerRef}
          panelRef={panelRef}
          className={MENU_PANEL}
        >
          <div className={MENU_HEADER}>Reference image</div>
          <div className="flex w-[260px] flex-col gap-2 p-1.5">
            <input
              type="url"
              value={draft}
              aria-label="Reference image URL"
              placeholder="https://…"
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px]"
            />
            {error && <p className="text-[12px] text-destructive">{error}</p>}
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={attach}
                className="rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90"
              >
                Attach
              </button>
            </div>
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}

/**
 * The model pill — first in the band on every lane, and the only pill that is
 * always there. A model with no published option metadata renders this and
 * nothing else, which is the honest reading of "we do not know what this model
 * takes".
 */
export function ModelPill({
  models,
  value,
  displayName,
  provider,
  unavailable,
  onSelect,
  bandRef,
}: {
  models: readonly MediaModelOption[]
  value: string
  /** What the pill reads. Falls back to the id — including for a model the
   *  catalog does not list, such as an image-to-video sibling. */
  displayName: string
  provider?: string
  /** The selected model is listed but not routable — the pill carries the warning instead of any status line. */
  unavailable?: boolean
  onSelect: (id: string) => void
  bandRef: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef)

  return (
    <div ref={containerRef} className="relative inline-flex flex-none">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        title="Model"
        aria-label={`Model: ${displayName}${unavailable ? ' (unavailable)' : ''}`}
        onClick={() => setOpen(!open)}
        className={`${PILL}${unavailable ? ' border-warning/50' : ''}`}
      >
        {unavailable && <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2} />}
        {provider && <ProviderLogo provider={provider} size={14} />}
        {/* No PILL_LABEL here: text-box trim ends the box at the alphabetic
            baseline, and truncate's overflow:hidden then clips descender ink
            (the g/p tails of "gpt-image-2"). A normal line box keeps them. */}
        <span className="max-w-[168px] truncate leading-normal">{displayName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`${MENU_PANEL} max-w-[320px]`}
      >
        <div className={MENU_HEADER}>Model</div>
        {models.length === 0 && (
          <p className="px-2.5 py-2 text-[13px] text-muted-foreground">No models are available for this media type.</p>
        )}
        {models.map((model) => (
          <button
            key={model.id}
            type="button"
            role="menuitemradio"
            aria-checked={model.id === value}
            onClick={() => {
              onSelect(model.id)
              setOpen(false)
            }}
            className={menuRowClass(model.id === value)}
          >
            {model.provider && (
              <span className={model.status === 'unavailable' ? 'opacity-45' : undefined}>
                <ProviderLogo provider={model.provider} size={14} />
              </span>
            )}
            <span className={`truncate${model.status === 'unavailable' ? ' opacity-45' : ''}`}>
              {model.name || model.id}
            </span>
            {model.status === 'unavailable' ? (
              <>
                <span className="ml-auto shrink-0 text-[11px] text-warning">Unavailable</span>
                <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2} />
              </>
            ) : model.status === 'limited' && (
              <span className="ml-auto shrink-0 text-[11px] capitalize text-muted-foreground">{model.status}</span>
            )}
            {model.id === value && (
              <CheckGlyph className={`${model.status === 'available' ? 'ml-auto ' : ''}h-3.5 w-3.5 shrink-0 text-primary`} />
            )}
          </button>
        ))}
      </PopoverSurface>
    </div>
  )
}

/**
 * How a wire value reads, with the wire value itself untouched underneath.
 *
 * Keyed on the PARAMETER because the same scalar means different things across
 * them: `5` is "5s" of video and `2` is "×2" images. Anything this table has no
 * rule for reads as itself with a capital letter — never as an invented word,
 * so `std` renders "Std" and not a "Standard" nobody published.
 */
export function optionValueLabel(param: string, value: ModelOptionValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  const text = String(value)
  if (param === 'n') return `×${text}`
  if (param === 'speed') return `${text}×`
  if (text === 'auto') return 'Auto'
  if (param === 'duration') return /^\d+(\.\d+)?$/.test(text) ? `${text}s` : text
  if (param === 'size') {
    const size = /^(\d+)x(\d+)$/.exec(text)
    return size ? `${size[1]}×${size[2]}` : text
  }
  if (param === 'resolution' || param === 'aspect_ratio') return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}
