import { useCallback, useMemo, useRef } from 'react'
import { AgentSessionControls } from '@tangle-network/sandbox-ui/chat'
import { canonicalModelId } from '@tangle-network/sandbox-ui/dashboard'
import type { ModelInfo } from '@tangle-network/sandbox-ui/dashboard'
import type { HarnessType, ReasoningEffort, ReasoningLevel } from './types'

/**
 * The model half of the composer's agent identity. `models` is the catalog the
 * picker renders; `value` may be a bare or a canonical (provider-prefixed) id —
 * the adapter maps it to canonical form for the picker and hands the canonical
 * id back to `onChange`, so a product that stores bare ids only has to accept
 * canonical ones in its setter.
 */
export interface ComposerModelSelection {
  value: string
  onChange: (next: string) => void
  models: ModelInfo[]
  loading?: boolean
  disabled?: boolean
}

export interface ComposerHarnessSelection {
  value: HarnessType
  onChange: (next: HarnessType) => void
  /** Restrict the offered backends. Omit to take the context default. */
  available?: ReadonlyArray<HarnessType>
  disabled?: boolean
  /**
   * A thread's sidecar session is pinned to one harness at its first message,
   * so once the thread has messages the picker locks. With `onNewChat` the
   * locked chip becomes the informative lock (explains the binding + a button
   * to start a fresh session on another backend).
   */
  locked?: boolean
  lockReason?: string
  onNewChat?: () => void
}

export interface ComposerEffortSelection {
  value: ReasoningLevel
  onChange: (next: ReasoningLevel) => void
  /**
   * Depths this product's backend actually applies. Omit for the default set.
   * `auto` is NOT a member: the picker adds that sentinel itself, so listing it
   * here would offer it twice.
   */
  available?: ReadonlyArray<ReasoningEffort>
  disabled?: boolean
}

export interface ComposerAgentControlsProps {
  model: ComposerModelSelection
  /** Omit on a router-backed composer: a direct model call has no CLI backend,
   *  so the picker would be inert. Model + effort still render. */
  harness?: ComposerHarnessSelection
  effort?: ComposerEffortSelection
  className?: string
  /**
   * Which surface the controls live on. `'chat'` (the default) drops the
   * shell-only `cli-base` backend — it has no conversational agent — and tells
   * the shared control to use its chat-only default set. `'all'` keeps every
   * backend for non-chat / scheduled surfaces.
   */
  context?: 'chat' | 'all'
  /**
   * Trigger layout. `'combined'` (the default) collapses the pickers behind one
   * labeled trigger reading the current selection (`harness · model · effort`).
   * `'gear'` uses an anonymous gear icon instead of the label; `'inline'` lays
   * the pickers out in a row.
   */
  layout?: 'inline' | 'gear' | 'combined'
  /**
   * Where the pickers open. `'down'` pins them downward for a composer floating
   * in open space (the centered entry surface) so a tall menu can't flip up over
   * the heading. Defaults to `'auto'` (collision-aware).
   */
  menuPlacement?: 'auto' | 'down'
  /**
   * Restrict the model catalog to what the selected harness can run instead of
   * letting an incompatible model snap the harness. ON by default: a workspace
   * harness is sandbox-bound, and a silent swap tears down and recreates the
   * sandbox. Turn OFF only on a model-first surface with no bound sandbox.
   */
  filterModelsToHarness?: boolean
}

/**
 * The chat copilot must never offer `cli-base`: it is a shell-only backend with
 * no conversational agent. sandbox-ui's `context='chat'` drops it from the
 * default set, but an explicit `available` list (a plan-filtered one may include
 * `cli-base`) overrides that trim. So strip it here at the data layer whenever
 * the surface is chat — no `cli-base` ever reaches render.
 */
function harnessesForContext(
  available: ReadonlyArray<HarnessType> | undefined,
  context: 'chat' | 'all',
): ReadonlyArray<HarnessType> | undefined {
  if (!available) return available
  if (context !== 'chat') return available
  return available.filter((h) => h !== 'cli-base')
}

/**
 * The composer's agent-identity control: harness (agent backend), model, and
 * reasoning effort, over sandbox-ui's `AgentSessionControls`.
 *
 * This is an ADAPTER, not a second implementation. sandbox-ui owns the control
 * and the harness↔model coherence policy (the catalog is filtered to the
 * selected harness, the effort re-clamps to what the harness/model pair
 * supports, and a harness that ignores a picker is marked with its dead control
 * disabled). What lives here is the app-shell wiring every product otherwise
 * re-derives:
 *
 *  - MODEL-ID BOUNDARY. Products store bare ids (what a chat send body expects)
 *    while the picker matches on canonical provider-prefixed ids. The canonical
 *    form goes in; the canonical id comes back out to `onChange`.
 *  - HARNESS-SNAP SUPPRESSION. The shared control snaps the model whenever the
 *    harness changes, calling the model `onChange` synchronously with a default
 *    compatible model. A product that remembers a per-harness pick must ignore
 *    that snap, or it both discards the remembered pick and persists it under
 *    the wrong harness's key. The guard is armed for exactly the synchronous
 *    window of a harness change and disarmed on the next microtask, so it can
 *    never stay stuck — a later genuine pick is never swallowed, even when the
 *    harness change was a no-op.
 *  - CHAT-CONTEXT TRIM. `cli-base` never reaches a conversational surface.
 *
 * Behavioral modes (a plan toggle) are NOT agent identity and do not belong
 * here — they dock on the other side of the composer via `controls`.
 */
export function ComposerAgentControls({
  model,
  harness,
  effort,
  className,
  context = 'chat',
  layout = 'combined',
  menuPlacement,
  filterModelsToHarness = true,
}: ComposerAgentControlsProps) {
  const canonicalSelected = useMemo(() => {
    const selected = model.models.find((m) => m.id === model.value)
    if (selected) return canonicalModelId(selected)
    // Already canonical, or the catalog has not loaded — pass through unchanged
    // so a provider-prefixed id still matches once models arrive.
    return model.value
  }, [model.value, model.models])

  const harnessSwitching = useRef(false)
  const harnessOnChange = harness?.onChange
  const onHarnessChange = useCallback(
    (next: HarnessType) => {
      harnessSwitching.current = true
      harnessOnChange?.(next)
      queueMicrotask(() => {
        harnessSwitching.current = false
      })
    },
    [harnessOnChange],
  )

  const modelOnChange = model.onChange
  const onModelChange = useCallback(
    (canonical: string) => {
      if (harnessSwitching.current) return
      modelOnChange(canonical)
    },
    [modelOnChange],
  )

  return (
    <AgentSessionControls
      className={className}
      context={context}
      layout={layout}
      menuPlacement={menuPlacement}
      filterModelsToHarness={filterModelsToHarness}
      model={{
        value: canonicalSelected,
        onChange: onModelChange,
        models: model.models,
        loading: model.loading,
        disabled: model.disabled,
      }}
      harness={
        harness
          ? {
              value: harness.value,
              onChange: onHarnessChange,
              available: harnessesForContext(harness.available, context),
              disabled: harness.disabled,
              locked: harness.locked,
              lockReason: harness.lockReason,
              onNewChat: harness.onNewChat,
            }
          : undefined
      }
      reasoning={
        effort
          ? {
              value: effort.value,
              onChange: effort.onChange,
              available: effort.available,
              disabled: effort.disabled,
            }
          : undefined
      }
    />
  )
}
