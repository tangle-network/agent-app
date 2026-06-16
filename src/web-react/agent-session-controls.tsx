/**
 * `AgentSessionControls` — the model + harness + reasoning-effort cluster a chat
 * composer docks. One component so every product's two composers (and every
 * product) share the same control surface and harness↔model coherence policy.
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  snapHarnessToModel,
  snapModelToHarness,
  type Harness,
} from '../harness'
import type { CatalogModel } from '../runtime/model-catalog'
import { ModelPicker, EffortPicker } from './index'

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

/** Close an absolutely-positioned popover on outside mousedown. */
function useClickOutside<T extends HTMLElement>(active: boolean, onOutside: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [active, onOutside])
  return ref
}

/** Pill-styled harness picker — inline, no sandbox-ui dependency. */
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
  const containerRef = useClickOutside<HTMLDivElement>(open, () => setOpen(false))
  const options = available ?? (Object.keys(HARNESS_LABELS) as Harness[])
  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Agent backend"
        className="inline-flex w-full items-center justify-between gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent/30"
      >
        <span className="truncate">{harnessLabel(value)}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full min-w-[220px] overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg">
          {options.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                onChange(h)
                setOpen(false)
              }}
              className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition ${
                h === value ? 'bg-primary/10 font-medium' : 'hover:bg-accent/30'
              }`}
            >
              {harnessLabel(h)}
            </button>
          ))}
        </div>
      )}
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
    layout = 'inline',
    showHarness = true,
    renderProviderBadge,
    className,
  } = props
  const { onModel, onHarness } = useCoherentHandlers(props)
  const [open, setOpen] = useState(false)
  const popoverRef = useClickOutside<HTMLDivElement>(open, () => setOpen(false))

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
        {showEffort && <EffortPicker value={effort} onChange={onEffortChange} />}
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
            onClick={() => setOpen((v) => !v)}
            title="Model settings — pick the agent backend and how hard it thinks"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
            data-state={open ? 'open' : 'closed'}
          >
            <GearGlyph className="h-4 w-4" />
          </button>
          {open && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-72 space-y-3 rounded-xl border border-border bg-card p-3 shadow-lg">
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
                  <p className="text-xs font-medium text-foreground">Reasoning effort</p>
                  <EffortPicker value={effort} onChange={onEffortChange} />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    How hard the agent thinks before answering. Higher is slower but more thorough.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
