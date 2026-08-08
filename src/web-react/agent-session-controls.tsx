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

import { useId, useMemo, useState, type ReactNode } from 'react'
import {
  snapHarnessToModel,
  snapModelToHarness,
  type Harness,
} from '../harness'
import type { CatalogModel } from '../runtime/model-catalog'
import { ModelPicker, EffortPicker, CheckGlyph, OVERLAY_SHADOW, PopoverSurface, usePopover } from './controls'
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

/** Pill-styled harness picker — inline, no sandbox-ui dependency. The brand
 *  marks come from `./harness-glyphs` (the set the legacy sandbox-ui picker
 *  shipped, vendored inline). */
function HarnessPicker({
  value,
  onChange,
  available,
}: {
  value: Harness
  onChange: (h: Harness) => void
  available?: ReadonlyArray<Harness>
}) {
  const [open, setOpen] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  const panelId = useId()
  const options = available ?? (Object.keys(HARNESS_LABELS) as Harness[])
  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        {...triggerProps}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        title="Agent backend"
        className={`inline-flex w-full items-center justify-between gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <HarnessGlyph harness={value} className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">{harnessLabel(value)}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="menu"
        triggerRef={triggerRef}
        panelRef={panelRef}
        matchTriggerWidth
        className={`max-h-64 min-w-[248px] overflow-y-auto rounded-xl border border-border bg-popover p-1 ${OVERLAY_SHADOW}`}
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
   */
  effortLevels?: readonly EffortLevel[]
  /**
   * `inline` (default): model, harness, effort side by side — the prior
   * behavior. `compact`: model inline, harness + effort behind a gear popover.
   */
  layout?: 'inline' | 'compact'
  /** Hide the harness control entirely (single-harness products). */
  showHarness?: boolean
  renderProviderBadge?: (provider: string) => ReactNode
  className?: string
}

/**
 * Apply the harness↔model coherence policy and emit the resulting change(s).
 * Returned from a hook-free helper so both layouts share one implementation.
 */
function useCoherentHandlers(props: AgentSessionControlsProps) {
  const { model, models, harness, onModelChange, onHarnessChange } = props
  const canonicalIds = useMemo(() => models.map((m) => m.id), [models])

  const onModel = (next: string) => {
    onModelChange(next)
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
          <HarnessPicker value={harness} onChange={onHarness} available={availableHarnesses} />
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
            className={`w-72 space-y-3 overflow-y-auto rounded-xl border border-border bg-popover p-3 ${OVERLAY_SHADOW}`}
          >
              {showHarness && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Agent backend</p>
                  <HarnessPicker value={harness} onChange={onHarness} available={availableHarnesses} />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    The engine that runs the agent. Switching it keeps your model choice compatible.
                  </p>
                </div>
              )}
              {showEffort && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Thinking</p>
                  <EffortPicker value={effort} onChange={onEffortChange} levels={effortLevels} label="" />
                  <p className="text-[11px] leading-snug text-muted-foreground">
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
