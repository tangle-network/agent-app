/**
 * Session presets — named (model, harness, effort) combinations a user pins
 * and applies in one action, beside the canonical session controls
 * (`/web-react`'s `AgentSessionControls`).
 *
 * The CONTRACT is coherence, not storage: a preset stores exact catalog ids,
 * and APPLYING it resolves through the harness module's snap helpers so the
 * result is never an invalid combination — if the catalog moved under a
 * pinned preset (model renamed, harness retired), apply snaps to the
 * harness's best compatible catalog option (or the model's native harness)
 * exactly like a manual picker change would, and reports what changed.
 * A preset naming a model the catalog no longer carries is REFUSED at
 * apply time, never silently substituted: a different model is a different
 * decision-maker.
 *
 * Storage is a port: products persist presets wherever they keep workspace
 * state (D1, KV, localStorage). The default store is in-memory for tests
 * and single-instance products — the same shape the self-mount verb uses.
 */
import { snapHarnessToModel, snapModelToHarness, type Harness } from './index'

/** A pinned session configuration. `id` is the product's stable key. */
export interface SessionPreset {
  readonly id: string
  /** User-facing label; trimmed, non-empty, ≤ 60 chars. */
  readonly name: string
  /** Canonical catalog model id ("provider/model"). */
  readonly model: string
  /** Optional pinned harness; omitted = follow the model's native harness. */
  readonly harness?: Harness
  /** Optional pinned reasoning effort (the picker canon's effort levels). */
  readonly effort?: string
}

/** What applying a preset actually set, with every snap named. */
export interface AppliedSessionPreset {
  readonly model: string
  readonly harness: Harness
  readonly effort?: string
  /** Non-empty when the catalog moved under the pinned preset. */
  readonly snapped: ReadonlyArray<'model' | 'harness'>
}

export interface SessionPresetCatalogContext {
  /** The catalog's canonical model ids. */
  readonly canonicalIds: readonly string[]
}

/** Validate one preset at save time: label budget, canonical model id, no
 *  unknown fields smuggled in. Throws with the preset's name in the message. */
export function validateSessionPreset(preset: SessionPreset): SessionPreset {
  const name = preset.name.trim()
  if (!name) throw new Error('a session preset needs a name')
  if (name.length > 60) {
    throw new Error(`session preset "${name.slice(0, 30)}…" exceeds the 60-character name budget`)
  }
  if (!preset.model.trim()) throw new Error(`session preset "${name}" pins no model`)
  const allowed = new Set(['id', 'name', 'model', 'harness', 'effort'])
  for (const key of Object.keys(preset)) {
    if (!allowed.has(key)) throw new Error(`session preset "${name}" carries an unknown field "${key}"`)
  }
  return { ...preset, name }
}

/** Apply a preset with catalog coherence. Refused (thrown) when the pinned
 *  model is gone from the catalog — never silently another model. */
export function applySessionPreset(
  preset: SessionPreset,
  context: SessionPresetCatalogContext,
): AppliedSessionPreset {
  if (!context.canonicalIds.includes(preset.model)) {
    throw new Error(
      `session preset "${preset.name}" pins model "${preset.model}", which the catalog no longer carries — `
      + `delete or re-pin the preset (a different model is a different decision-maker)`,
    )
  }
  const snapped: Array<'model' | 'harness'> = []
  const pinnedHarness = preset.harness ?? snapHarnessToModel('opencode', preset.model)
  let model = preset.model
  let harness = pinnedHarness
  // The same two-way coherence the manual pickers enforce, in the preset's
  // own order: the pinned harness snaps the model if incompatible, then the
  // (possibly snapped) model snaps the harness back if it moved families.
  const harnessCompatibleModel = snapModelToHarness(harness, model, context.canonicalIds)
  if (harnessCompatibleModel !== model) {
    model = harnessCompatibleModel
    snapped.push('model')
  }
  const modelNativeHarness = snapHarnessToModel(harness, model)
  if (modelNativeHarness !== harness) {
    harness = modelNativeHarness
    snapped.push('harness')
  }
  return {
    model,
    harness,
    ...(preset.effort !== undefined ? { effort: preset.effort } : {}),
    snapped,
  }
}

/** Durable preset storage port. Products own persistence; the default is
 *  non-durable for tests and single-instance products. */
export interface SessionPresetStore {
  list(): Promise<readonly SessionPreset[]>
  save(preset: SessionPreset): Promise<void>
  remove(id: string): Promise<void>
}

export function createInMemorySessionPresetStore(): SessionPresetStore {
  const state = new Map<string, SessionPreset>()
  return {
    async list() { return [...state.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    async save(preset) { state.set(preset.id, validateSessionPreset(preset)) },
    async remove(id) { state.delete(id) },
  }
}

/**
 * The composer/controls integration seam: presets render beside the canonical
 * pickers (picker-canon geometry) and apply through {@link applySessionPreset};
 * saving captures the CURRENT picker selection verbatim. The visual surface is
 * deliberately not owned here — the picker canon and the product's design
 * tokens define it; this module guarantees the semantics underneath.
 */
