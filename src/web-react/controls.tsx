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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ProviderLogo } from './provider-logo'
import type { CatalogModel } from '../runtime/model-catalog'

// ── shared glyphs (no icon-library dependency) ────────────────────────────

export function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function SparkleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

/** lucide `brain` (v1.27) inlined — `/web-react` ships no icon-library
 *  dependency, so the thinking glyph follows the same pattern as the rest of
 *  this set. */
function BrainGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  )
}

/** lucide `check` — the selected-row mark in the picker menus. */
export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

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
export function usePopover(open: boolean, setOpen: (open: boolean) => void) {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      const panel = panelRef.current
      if (panel?.contains(target)) return
      // A popover opened FROM this one portals as a SIBLING at body level, so
      // `contains` cannot see it and a click on its rows would read as outside.
      // Surfaces stamp their ancestor chain, so descendancy survives the portal.
      const ownPath = panel?.getAttribute(POPOVER_SURFACE_ATTR)
      const hitPath =
        target instanceof Element
          ? target.closest(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
          : null
      if (ownPath && hitPath && (hitPath === ownPath || hitPath.startsWith(`${ownPath}${POPOVER_PATH_SEPARATOR}`))) return
      setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])

  return {
    containerRef,
    triggerRef,
    panelRef,
    triggerProps: {
      ref: triggerRef,
      'aria-haspopup': true as const,
      'aria-expanded': open,
    },
  }
}

// ── PopoverSurface ────────────────────────────────────────────────────────

/** Distance between the trigger and the panel it opens. */
const POPOVER_GAP = 8
/** Minimum distance the panel keeps from every viewport edge. */
const POPOVER_VIEWPORT_MARGIN = 16
/** Floor for the computed max-height, so a cramped side still shows rows
 *  rather than collapsing to a sliver the user cannot read. */
const POPOVER_MIN_HEIGHT = 120

/**
 * Marks the portaled panel in the DOM. Products and audits (see
 * `playground/scripts/popover-hit-test.mjs`) select on this rather than on a
 * Tailwind class, which is presentation and free to change.
 *
 * Its VALUE is the surface's ancestor path (`outer/inner`), which is what
 * restores "is this click inside my popover" after the portal flattens two
 * nested panels into two siblings of `<body>`.
 */
export const POPOVER_SURFACE_ATTR = 'data-agent-app-popover'
const POPOVER_PATH_SEPARATOR = '/'

/**
 * `PopoverSurface` is now mounted (closed) inside every server-rendered
 * composer, so its hooks run on the server once per composer per request.
 * React 18 logs "useLayoutEffect does nothing on the server" for that; React 19
 * does not (measured silent on react-dom 19.2.8). The peer floor is `react >=18`,
 * so bind the synchronous hook only where there is a DOM and the effect hook
 * elsewhere — placement never runs on the server either way.
 */
const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect

export interface PopoverSurfaceProps {
  open: boolean
  /** The trigger the panel anchors to — `usePopover`'s `triggerRef`. */
  triggerRef: RefObject<HTMLElement | null>
  /** `usePopover`'s `panelRef`; also what the outside-click test consults. */
  panelRef: RefObject<HTMLDivElement | null>
  /** Presentation classes. Placement and elevation are owned here — a caller
   *  must not pass `absolute`/`fixed`/`top-*`/`bottom-*`/`z-*`. */
  className?: string
  role?: string
  id?: string
  /** Make the panel at least as wide as its trigger. A portaled panel has no
   *  `w-full` to inherit — the trigger is no longer its offset parent — so a
   *  menu that used to stretch to a full-width trigger declares it here. */
  matchTriggerWidth?: boolean
  children: ReactNode
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
export function PopoverSurface({
  open,
  triggerRef,
  panelRef,
  className,
  role,
  id,
  matchTriggerWidth,
  children,
}: PopoverSurfaceProps) {
  const surfaceId = useId()
  const [style, setStyle] = useState<CSSProperties>(() => ({
    position: 'fixed',
    top: 0,
    left: 0,
    visibility: 'hidden',
  }))

  const place = useCallback(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const anchor = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    // `scrollHeight` is the panel's CONTENT height, so it does not feed back
    // on the `maxHeight` this function just applied — reading `offsetHeight`
    // here would measure the previous pass's clamp and ratchet the panel
    // smaller on every scroll event.
    const contentHeight = panel.scrollHeight
    const panelWidth = panel.offsetWidth

    const roomAbove = anchor.top - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN
    const roomBelow = viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN
    const above = contentHeight <= roomAbove || roomAbove >= roomBelow
    const maxHeight = Math.max(POPOVER_MIN_HEIGHT, above ? roomAbove : roomBelow)
    const height = Math.min(contentHeight, maxHeight)

    const top = above ? Math.max(POPOVER_VIEWPORT_MARGIN, anchor.top - POPOVER_GAP - height) : anchor.bottom + POPOVER_GAP
    const rightBound = Math.max(POPOVER_VIEWPORT_MARGIN, viewportWidth - panelWidth - POPOVER_VIEWPORT_MARGIN)
    const left = Math.min(Math.max(POPOVER_VIEWPORT_MARGIN, anchor.left), rightBound)

    setStyle({
      position: 'fixed',
      top,
      left,
      maxHeight,
      visibility: 'visible',
      ...(matchTriggerWidth ? { minWidth: anchor.width } : {}),
    })
  }, [matchTriggerWidth, panelRef, triggerRef])

  // Layout effect: placement is resolved before the browser paints, so the
  // panel is never seen at the origin it mounts at.
  useBrowserLayoutEffect(() => {
    if (!open) {
      setStyle({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
      return
    }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onViewportChange = () => place()
    // `capture` so the rail's OWN scroll re-anchors the panel — a scroll inside
    // an ancestor does not bubble to window.
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, place])

  if (!open || typeof document === 'undefined') return null

  const ownerPath = triggerRef.current?.closest?.(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR)
  const path = ownerPath ? `${ownerPath}${POPOVER_PATH_SEPARATOR}${surfaceId}` : surfaceId

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role={role}
      style={style}
      {...{ [POPOVER_SURFACE_ATTR]: path }}
      className={`z-[1000] ${className ?? ''}`}
    >
      {children}
    </div>,
    document.body,
  )
}

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
 * drawers, modals. The theme's `shadow-overlay` utility is landing with the
 * token work; until it does, this is the composer's raised-card literal kept
 * in a single place so every overlay paints the same shadow and the later
 * token swap is a one-line edit (`shadow-overlay` here, `shadow-raised` on
 * the composer card).
 * TODO(theme): swap to `shadow-overlay` once the preset ships it.
 */
export const OVERLAY_SHADOW =
  'shadow-[0_1px_2px_hsl(var(--foreground)/0.05),0_12px_28px_hsl(var(--foreground)/0.07)] dark:shadow-[0_1px_2px_hsl(var(--foreground)/0.14),0_12px_28px_hsl(var(--foreground)/0.22)]'

/**
 * Guard an async action against double-submit. `run` ignores re-entrant calls
 * while a promise is in flight and flips `pending` so the caller can disable
 * the control — the fix for double-charge / double-approve on a slow network.
 * Settles (success or throw) before clearing, and no-ops state updates after
 * unmount.
 */
export function usePending(): { pending: boolean; run: (action: () => void | Promise<void>) => void } {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = (action: () => void | Promise<void>) => {
    if (inFlight.current) return
    let result: void | Promise<void>
    try {
      result = action()
    } catch {
      return
    }
    if (!(result instanceof Promise)) return
    inFlight.current = true
    setPending(true)
    void result.finally(() => {
      inFlight.current = false
      if (mounted.current) setPending(false)
    })
  }
  return { pending, run }
}

// ── ModelPicker ───────────────────────────────────────────────────────────

export interface ModelPickerProps {
  value: string
  onChange: (id: string) => void
  /** Catalogue models — from `GET`ing the app's catalogue route (see
   *  `runtime/model-catalog`), plus any product-specific entries appended. */
  models: CatalogModel[]
  loading?: boolean
  /** Render a provider logo/badge; default is a generic sparkle. */
  renderProviderBadge?: (provider: string) => ReactNode
  /** Section label for `featured` models. */
  recommendedLabel?: string
  /** Pin a labeled section to the TOP of the list (above Recommended) for the
   *  models a product wants surfaced first — e.g. a tuner app's own fine-tuned
   *  models (`{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'tuner' }`).
   *  Matching models are shown only in this section, not duplicated below. */
  priorityGroup?: {
    label: string
    match: (model: CatalogModel) => boolean
  }
}

function formatPrice(p?: string): string | undefined {
  if (!p) return undefined
  const n = Number(p)
  if (isNaN(n) || n === 0) return undefined
  const perM = n * 1_000_000
  return perM >= 1 ? `$${perM.toFixed(0)}/M` : `$${perM.toFixed(2)}/M`
}

function formatContext(len?: number): string | undefined {
  if (!len) return undefined
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M ctx`
  if (len >= 1_000) return `${Math.round(len / 1_000)}K ctx`
  return `${len} ctx`
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

function ModelRow({
  model,
  selected,
  onSelect,
  renderProviderBadge,
}: {
  model: CatalogModel
  selected: boolean
  onSelect: () => void
  renderProviderBadge?: (provider: string) => ReactNode
}) {
  const price = formatPrice(model.pricing?.prompt)
  const ctx = formatContext(model.contextLength)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${
        selected ? 'bg-primary/10 font-medium' : 'hover:bg-accent'
      }`}
    >
      {renderProviderBadge ? renderProviderBadge(model.provider) : <ProviderLogo provider={model.provider} size={16} />}
      <span className="truncate">{model.name}</span>
      {!model.supportsTools && (
        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          no tools
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {ctx && <span>{ctx}</span>}
        {price && <span>{price}</span>}
      </span>
    </button>
  )
}

/**
 * Searchable model picker pill + popover: a featured/recommended section
 * first, then per-provider groups in catalogue order (the server already
 * sorts providers by tier).
 *
 * This is the CANONICAL ecosystem model picker (see "UI chrome ownership
 * (picker canon)" in AGENTS.md). sandbox-ui's `dashboard/ModelPicker` is
 * legacy — deprecated, frozen, removed at sandbox-ui's next major; new code
 * belongs here.
 */
export function ModelPicker({ value, onChange, models, loading, renderProviderBadge, recommendedLabel = 'Recommended', priorityGroup }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const selected = models.find((m) => m.id === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description?.toLowerCase() ?? '').includes(q) ||
        m.provider.toLowerCase().includes(q),
    )
  }, [models, query])

  const sections = useMemo(() => {
    const isPriority = priorityGroup ? (m: CatalogModel) => priorityGroup.match(m) : () => false
    const priority = priorityGroup ? models.filter(isPriority) : []
    const recommended = models.filter((m) => m.featured && !isPriority(m))
    const byProvider: Array<{ provider: string; items: CatalogModel[] }> = []
    for (const m of models) {
      if (m.featured || isPriority(m)) continue
      const last = byProvider[byProvider.length - 1]
      if (last && last.provider === m.provider) last.items.push(m)
      else byProvider.push({ provider: m.provider, items: [m] })
    }
    return { priority, recommended, byProvider }
  }, [models, priorityGroup])

  const select = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
      >
        {selected ? (renderProviderBadge ? renderProviderBadge(selected.provider) : <ProviderLogo provider={selected.provider} size={16} />) : <SparkleGlyph className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="max-w-[160px] truncate">{selected?.name ?? value}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      <PopoverSurface
        open={open}
        id={panelId}
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`flex w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover ${OVERLAY_SHADOW}`}
      >
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <SearchGlyph className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground"
              />
            </div>
          </div>
          {/* `min-h-0` is what lets the list absorb the surface's computed
              max-height on a short viewport instead of overflowing the panel. */}
          <div className="max-h-[400px] min-h-0 overflow-y-auto p-1 pb-2">
            {loading && <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading models...</div>}
            {!loading && filtered && (
              <>
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">No models match your search</div>
                )}
                {filtered.map((m) => (
                  <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                ))}
              </>
            )}
            {!loading && !filtered && models.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">No models available</div>
            )}
            {!loading && !filtered && models.length > 0 && (
              <>
                {priorityGroup && sections.priority.length > 0 && (
                  <>
                    <SectionHeader>{priorityGroup.label}</SectionHeader>
                    {sections.priority.map((m) => (
                      <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                    ))}
                  </>
                )}
                {sections.recommended.length > 0 && (
                  <>
                    <SectionHeader>{recommendedLabel}</SectionHeader>
                    {sections.recommended.map((m) => (
                      <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                    ))}
                  </>
                )}
                {sections.byProvider.map((g) => (
                  <div key={g.provider}>
                    <SectionHeader>{g.provider}</SectionHeader>
                    {g.items.map((m) => (
                      <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
      </PopoverSurface>
    </div>
  )
}

// ── EffortPicker ──────────────────────────────────────────────────────────

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

export const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Quick' },
  { id: 'medium', label: 'Standard' },
  { id: 'high', label: 'Extended' },
]

/**
 * The user-facing label for an engine level id: the canonical vocabulary when
 * the id is one this package names, otherwise the id itself made readable
 * (`auto` -> "Auto", `ultra-code` -> "Ultra code"). Never invents a depth word,
 * so an id nobody declared a label for still reads as ITSELF and never as some
 * other level.
 */
export function effortLevelLabel(id: string): string {
  const known = DEFAULT_EFFORT_LEVELS.find((l) => l.id === id)
  if (known) return known.label
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
 * Filled-segment count for a level: 0 for off/none (or an id the levels list
 * does not carry); otherwise the level's position among the non-off choices
 * scaled onto the meter, so the ladder reads low < medium < high and the top
 * level fills the whole scale. The canonical four levels land 0 / 1 / 2 / 4.
 */
export function effortMeterFill(
  levelId: string,
  levels: readonly EffortLevel[] = DEFAULT_EFFORT_LEVELS,
): number {
  if (OFF_LEVEL_IDS.has(levelId)) return 0
  const active = levels.filter((l) => !OFF_LEVEL_IDS.has(l.id))
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
}

/** Thinking-budget selector pill, styled to match {@link ModelPicker}. Show
 *  it only when the selected model `supportsReasoning`. "Thinking" is the
 *  plain-English name for what was internally called "effort".
 *
 *  The CANONICAL ecosystem effort picker — sandbox-ui's reasoning menu (inside
 *  its `chat/AgentSessionControls`) is legacy and frozen. */
export function EffortPicker({ value, onChange, levels = DEFAULT_EFFORT_LEVELS, label = 'Thinking' }: EffortPickerProps) {
  const [open, setOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()
  const rendered = reconcileEffortLevels(value, levels)
  // The strength ladder is computed over the DECLARED levels only, so admitting
  // the selected value cannot shift where the declared ones sit on the meter.
  // A level the declaration does not carry has no position on that ladder, so
  // it renders with NO meter — an all-ghost meter is what `off` looks like, and
  // "we cannot place this" is not "no thinking".
  const isDeclared = (id: string) => levels.some((l) => l.id === id)
  const selected = rendered.find((l) => l.id === value)

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        title={label ? `${label} — how hard the agent reasons before answering` : 'Reasoning effort'}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
      >
        <BrainGlyph className="h-3.5 w-3.5 text-muted-foreground" />
        <span>
          {label ? <span className="text-muted-foreground">{label}: </span> : null}
          {selected ? selected.label : '—'}
        </span>
        {selected && isDeclared(selected.id) && (
          <EffortMeter fill={effortMeterFill(selected.id, levels)} className="text-foreground" />
        )}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`w-44 overflow-y-auto rounded-xl border border-border bg-popover p-1 ${OVERLAY_SHADOW}`}
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
