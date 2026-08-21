import type { ModelOptionValue } from '../studio'
import type { ComposerType } from './studio-composer'

export interface PersistedComposerSelections {
  v: 1
  type: ComposerType
  selectedModels: Partial<Record<ComposerType, string>>
  /** Option values are model-specific: two models in one lane may publish
   *  different enums for the same parameter. */
  optionsByModel: Record<string, Record<string, ModelOptionValue>>
}

const COMPOSER_TYPES = ['image', 'video', 'speech'] as const

function storageKey(workspaceId: string): string {
  return `studio-composer:${workspaceId}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isComposerType(value: unknown): value is ComposerType {
  return COMPOSER_TYPES.some((type) => type === value)
}

function isOptionValue(value: unknown): value is ModelOptionValue {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function parseSelections(value: unknown): PersistedComposerSelections | null {
  if (!isPlainObject(value) || value.v !== 1 || !isComposerType(value.type)) return null
  if (!isPlainObject(value.selectedModels) || !isPlainObject(value.optionsByModel)) return null

  const selectedModels: Partial<Record<ComposerType, string>> = {}
  for (const type of COMPOSER_TYPES) {
    const modelId = value.selectedModels[type]
    if (typeof modelId === 'string') selectedModels[type] = modelId
  }

  const optionsByModel: Record<string, Record<string, ModelOptionValue>> = {}
  for (const [modelId, rawOptions] of Object.entries(value.optionsByModel)) {
    if (!isPlainObject(rawOptions)) continue
    const options: Record<string, ModelOptionValue> = {}
    for (const [param, optionValue] of Object.entries(rawOptions)) {
      if (isOptionValue(optionValue)) options[param] = optionValue
    }
    optionsByModel[modelId] = options
  }

  return { v: 1, type: value.type, selectedModels, optionsByModel }
}

export function loadComposerSelections(workspaceId: string): PersistedComposerSelections | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId))
    return raw === null ? null : parseSelections(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveComposerSelections(
  workspaceId: string,
  snapshot: PersistedComposerSelections,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(snapshot))
  } catch {
    // Preferences are best-effort. Storage may be disabled or over quota.
  }
}
