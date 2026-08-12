/**
 * `AgentSessionControls` — the CANONICAL model + harness + reasoning-effort
 * cluster a chat composer docks (see "UI chrome ownership (picker canon)" in
 * AGENTS.md). One component so every product's two composers (and every
 * product) share the same control surface and harness↔model coherence policy.
 *
 * PICKER CANON. The model menu below IS `/web-react`'s `ModelPicker` and the
 * thinking-budget pill IS `EffortPicker` — the canonical ecosystem pickers.
 * sandbox-ui's `dashboard/ModelPicker` and the model menu inside sandbox-ui's
 * `chat/AgentSessionControls` are legacy (deprecated, frozen, removed at
 * sandbox-ui's next major), and the `/chat-react` `ComposerAgentControls`
 * adapter that rendered sandbox-ui's strip is REMOVED — a surface that still
 * renders the sandbox-ui strip is showing the old design; migrate it
 * (props mapping in `docs/ui-picker-canon.md`).
 *
 * Dependency-free beyond React by design: `/web-react` must not force the
 * optional sandbox-ui peer, so this component — the canonical one — can never
 * require it.
 *
 * Two layouts, additive — the default preserves the prior hand-rolled behavior:
 *  - `layout="inline"` (default): model, harness, and effort sit side by side as
 *    pills. This is the original arrangement; existing call sites that mounted
 *    `ModelPicker` + a harness picker + `EffortPicker` in a row get the same UI.
 *  - `layout="compact"`: the model picker stays inline and visible; the agent
 *    backend ("harness") and reasoning-effort controls — internal jargon a user
 *    rarely needs — tuck behind a single gear popover with plain-English copy.
 *
 * Harness ↔ model coherence is identical in both layouts, via the substrate's
 * snap helpers (`@tangle-network/agent-app/harness`): changing the harness snaps
 * an incompatible model to that harness's best catalog option; changing the
 * model switches to the model's native harness. Catalog model ids are canonical
 * ("provider/model"), which is exactly what the snap helpers expect — no id
 * translation is needed here.
 *
 * Dependency-free beyond React: inline SVG glyphs, CSS-var / Tailwind tokens the
 * app shell defines. The harness picker is rendered inline so this needs no
 * sandbox-ui dependency.
 */

import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  snapHarnessToModel,
  snapModelToHarness,
  type Harness,
} from '../harness'
import type { CatalogModel } from '../runtime/model-catalog'
import { ModelPicker, EffortPicker, CheckGlyph, OVERLAY_SHADOW, pickerRootClass, PopoverSurface, usePopover } from './controls'
import type { EffortLevel } from './controls'
import { HarnessGlyph } from './harness-glyphs'

/** Plain-English labels for the harnesses a product is likely to expose. Unknown
 *  ids fall back to the raw value so a new backend still renders a usable label. */
const HARNESS_LABELS: Partial<Record<Harness, string>> = {
  opencode: 'OpenCode (any model)',
  'claude-code': 'Claude Code (Anthropic)',
  codex: 'Codex (OpenAI)',
  'kimi-code': 'Kimi (Moonshot)',
  amp: 'Amp',
  'factory-droids': 'Factory Droids',
  cursor: 'Cursor',
  hermes: 'Hermes',
  forge: 'Forge',
  pi: 'Pi',
  openclaw: 'OpenClaw',
  acp: 'ACP',
  'cli-base': 'CLI',
}

function harnessLabel(h: Harness): string {
  return HARNESS_LABELS[h] ?? h
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** lucide `lock` — the closed padlock on a pinned harness trigger. */
function LockGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function GearGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

/** Tailwind utilities for keyboard-visible focus on popover options + triggers. */
const FOCUS_RING =
  ''

/**
 * Pill-styled harness picker — inline, no sandbox-ui dependency. The brand
 * marks come from `./harness-glyphs` (the set the legacy sandbox-ui picker
 * shipped, vendored inline).
 *
 * `rounded-full` + `min-h-[36px]`, not `rounded-lg` at whatever height the
 * padding gives: this pill sits beside `ModelPicker` and `EffortPicker` in
 * both layouts, and both of those are 36px pills. A single odd-shaped control
 * is what made the compact popover read as a pile of unrelated widgets rather
 * than one selector stack.
 *
 * `fullWidth` is opt-in and means what it means on `EffortPicker` — see
 * {@link pickerRootClass}.
 *
 * `lockReason` PINS the control: it keeps its selector shape and keeps
 * reporting the harness the thread is on, opens nothing, and explains itself
 * on hover AND on keyboard focus. Three deliberate choices there:
 *
 *  - `aria-disabled`, never the native `disabled` attribute. A disabled button
 *    is removed from the tab order and fires no pointer events in most
 *    browsers, so the one control that has something to explain would become
 *    the one control that can never be asked.
 *  - the reason rides a permanent visually-hidden node that `aria-describedby`
 *    points at, so assistive tech has it whether or not the floating hint is
 *    up; the floating copy is `aria-hidden` so nothing is announced twice.
 *  - the hint is a {@link PopoverSurface}, not an absolutely-positioned div —
 *    the compact panel is an `overflow-y-auto` box, which clips a positioned
 *    descendant, and that surface is this package's answer to exactly that.
 */
function HarnessPicker({
  value,
  onChange,
  available,
  fullWidth = false,
  lockReason,
}: {
  value: Harness
  onChange: (h: Harness) => void
  available?: ReadonlyArray<Harness>
  fullWidth?: boolean
  lockReason?: string
}) {
  const [open, setOpen] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const hintPanelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const reasonId = useId()
  const locked = lockReason !== undefined
  const options = available ?? (Object.keys(HARNESS_LABELS) as Harness[])
  const showHint = () => setHintOpen(true)
  const hideHint = () => setHintOpen(false)
  return (
    <div ref={containerRef} className={pickerRootClass(fullWidth)}>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup={locked ? undefined : true}
        aria-expanded={locked ? undefined : open}
        aria-controls={!locked && open ? panelId : undefined}
        aria-disabled={locked || undefined}
        aria-describedby={locked ? reasonId : undefined}
        onClick={locked ? undefined : () => setOpen(!open)}
        onMouseEnter={locked ? showHint : undefined}
        onMouseLeave={locked ? hideHint : undefined}
        onFocus={locked ? showHint : undefined}
        onBlur={locked ? hideHint : undefined}
        title="Agent backend"
        className={`inline-flex min-h-[36px] w-full items-center justify-between gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition ${
          locked ? 'cursor-default' : 'hover:bg-accent'
        } ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <HarnessGlyph harness={value} className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">{harnessLabel(value)}</span>
        </span>
        {locked ? (
          <LockGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {locked && (
        <>
          <span id={reasonId} className="sr-only">
            {lockReason}
          </span>
          <PopoverSurface
            open={hintOpen}
            role="tooltip"
            triggerRef={triggerRef}
            panelRef={hintPanelRef}
            matchTriggerWidth={fullWidth}
            className={`max-w-[248px] rounded-lg border border-card-edge bg-popover px-2.5 py-1.5 text-xs leading-snug text-muted-foreground ${OVERLAY_SHADOW}`}
          >
            <span aria-hidden>{lockReason}</span>
          </PopoverSurface>
        </>
      )}
      <PopoverSurface
        open={!locked && open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        matchTriggerWidth
        className={`max-h-64 min-w-[248px] overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`}
      >
          {options.map((h) => (
            <button
              key={h}
              type="button"
              role="menuitemradio"
              aria-checked={h === value}
              onClick={() => {
                onChange(h)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition ${FOCUS_RING} ${
                h === value ? 'bg-primary/10 font-medium' : 'hover:bg-accent'
              }`}
            >
              <HarnessGlyph harness={h} className="h-4 w-4 shrink-0 text-foreground" />
              <span className="truncate">{harnessLabel(h)}</span>
              {h === value && <CheckGlyph className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}
      </PopoverSurface>
    </div>
  )
}

export interface AgentSessionControlsProps {
  /** Catalog models — canonical provider-prefixed ids. */
  models: CatalogModel[]
  modelsLoading?: boolean
  /** Selected canonical model id. */
  model: string
  onModelChange(modelId: string): void
  /** Current harness; harness↔model coherence is enforced on every change. */
  harness: Harness
  onHarnessChange(harness: Harness): void
  /** Harnesses to offer; defaults to the labeled set. */
  availableHarnesses?: ReadonlyArray<Harness>
  /** Reasoning-effort value + setter. Shown only when the selected model
   *  `supportsReasoning`, matching `EffortPicker`'s guidance. */
  effort: string
  onEffortChange(effort: string): void
  /**
   * Levels to offer, forwarded verbatim to {@link EffortPicker}. Omit for the
   * default vocabulary.
   *
   * A product whose backend applies only a SUBSET of the levels for the
   * selected harness/model passes that subset here. Without it the strip
   * offers every level and the backend silently ignores the ones it does not
   * apply — a control that reports a choice the system never made.
   *
   * This is the COMPLETE renderable set, not an allow-list layered over a
   * default one — the removed `ComposerAgentControls`' `available` list was the
   * latter, and its picker injected the `auto` sentinel itself. A list that
   * omits the current {@link effort} is still safe: `EffortPicker` reconciles
   * the selected value into the rendered list under its own name rather than
   * resolving it to a different entry (`reconcileEffortLevels`). Build the list
   * from engine ids with `effortLevelsFromIds`; the migration is in
   * `docs/ui-picker-canon.md`.
   */
  effortLevels?: readonly EffortLevel[]
  /**
   * `inline` (default): model, harness, effort side by side — the prior
   * behavior. `compact`: model inline, harness + effort behind a gear popover.
   */
  layout?: 'inline' | 'compact'
  /** Hide the harness control entirely (single-harness products). */
  showHarness?: boolean
  /**
   * PIN the harness and say why, in the user's words ("This thread already has
   * messages — start a new chat to switch backend"). Presence IS the lock:
   * there is no separate boolean, because a lock a user cannot read is the
   * thing this prop exists to replace.
   *
   * The control stays VISIBLE and reports the harness the thread is on — the
   * shape a locked selector has to keep, since a thread whose backend is fixed
   * is exactly when a user wants to know what it is. Hiding it (`showHarness:
   * false`) is what pushed products into rendering their own lock label
   * outside the panel.
   *
   * While locked, `onHarnessChange` is never called — not from the picker, and
   * not from the model↔harness coherence policy either. See
   * {@link useCoherentHandlers}.
   */
  harnessLockReason?: string
  renderProviderBadge?: (provider: string) => ReactNode
  className?: string
}

/**
 * Apply the harness↔model coherence policy and emit the resulting change(s).
 * Returned from a hook-free helper so both layouts share one implementation.
 *
 * A LOCKED harness ({@link AgentSessionControlsProps.harnessLockReason}) is
 * authoritative over the snap: picking a model whose native backend differs
 * still changes the model, and leaves the harness alone. The alternative —
 * snapping a harness the UI has just told the user cannot change — is the one
 * behaviour a lock must not have.
 */
function useCoherentHandlers(props: AgentSessionControlsProps) {
  const { model, models, harness, onModelChange, onHarnessChange, harnessLockReason } = props
  const canonicalIds = useMemo(() => models.map((m) => m.id), [models])
  const harnessLocked = harnessLockReason !== undefined

  const onModel = (next: string) => {
    onModelChange(next)
    if (harnessLocked) return
    const nextHarness = snapHarnessToModel(harness, next)
    if (nextHarness !== harness) onHarnessChange(nextHarness)
  }

  const onHarness = (next: Harness) => {
    onHarnessChange(next)
    const snapped = snapModelToHarness(next, model, canonicalIds)
    if (snapped !== model) onModelChange(snapped)
  }

  return { onModel, onHarness }
}

export function AgentSessionControls(props: AgentSessionControlsProps) {
  const {
    models,
    modelsLoading,
    model,
    harness,
    availableHarnesses,
    effort,
    onEffortChange,
    effortLevels,
    layout = 'inline',
    showHarness = true,
    harnessLockReason,
    renderProviderBadge,
    className,
  } = props
  const { onModel, onHarness } = useCoherentHandlers(props)
  const [open, setOpen] = useState(false)
  const { containerRef: popoverRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()

  const selectedModel = models.find((m) => m.id === model)
  const showEffort = selectedModel?.supportsReasoning ?? true

  const modelPicker = (
    <ModelPicker
      value={model}
      onChange={onModel}
      models={models}
      loading={modelsLoading}
      renderProviderBadge={renderProviderBadge}
    />
  )

  if (layout === 'inline') {
    return (
      <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
        {modelPicker}
        {showHarness && (
          <HarnessPicker value={harness} onChange={onHarness} available={availableHarnesses} lockReason={harnessLockReason} />
        )}
        {showEffort && <EffortPicker value={effort} onChange={onEffortChange} levels={effortLevels} />}
      </div>
    )
  }

  // compact: model inline; harness + effort behind a gear popover.
  const hasAdvanced = showHarness || showEffort
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      {modelPicker}
      {hasAdvanced && (
        <div ref={popoverRef} className="relative inline-flex">
          <button
            type="button"
            {...triggerProps}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(!open)}
            title="Model settings — pick the agent backend and how hard it thinks"
            className={`flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted ${FOCUS_RING}`}
            data-state={open ? 'open' : 'closed'}
          >
            <GearGlyph className="h-4 w-4" />
          </button>
          <PopoverSurface
            open={open}
            id={panelId}
            triggerRef={triggerRef}
            panelRef={panelRef}
            className={`w-72 space-y-3 overflow-y-auto rounded-xl border border-card-edge bg-popover p-3 ${OVERLAY_SHADOW}`}
          >
              {showHarness && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Agent backend</p>
                  <HarnessPicker
                    value={harness}
                    onChange={onHarness}
                    available={availableHarnesses}
                    fullWidth
                    lockReason={harnessLockReason}
                  />
                  <p className="text-xs leading-snug text-muted-foreground">
                    The engine that runs the agent. Switching it keeps your model choice compatible.
                  </p>
                </div>
              )}
              {showEffort && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Thinking</p>
                  <EffortPicker value={effort} onChange={onEffortChange} levels={effortLevels} label="" fullWidth />
                  <p className="text-xs leading-snug text-muted-foreground">
                    How hard the agent thinks before answering. Higher is slower but more thorough.
                  </p>
                </div>
              )}
          </PopoverSurface>
        </div>
      )}
    </div>
  )
}
