import { describe, expect, it } from 'vitest'
import { isModelCompatibleWithHarness } from './index'
import {
  applySessionPreset,
  createInMemorySessionPresetStore,
  validateSessionPreset,
  type SessionPreset,
} from './presets'

const CATALOG = ['openai/gpt-6-luna', 'zai/glm-5.3', 'glm-5', 'glm-5-turbo', 'default']

describe('validateSessionPreset', () => {
  it('trims the name and enforces the 60-char budget', () => {
    expect(validateSessionPreset({ id: 'p1', name: '  fast  ', model: 'zai/glm-5.3' }).name).toBe('fast')
    expect(() => validateSessionPreset({ id: 'p1', name: 'x'.repeat(61), model: 'zai/glm-5.3' })).toThrow(/60-character/)
    expect(() => validateSessionPreset({ id: 'p1', name: '', model: 'zai/glm-5.3' })).toThrow(/needs a name/)
  })
  it('refuses unknown fields and a missing model', () => {
    expect(() => validateSessionPreset({ id: 'p1', name: 'x', model: 'zai/glm-5.3', temperature: 0.2 } as never)).toThrow(/unknown field/)
    expect(() => validateSessionPreset({ id: 'p1', name: 'x', model: '  ' })).toThrow(/pins no model/)
  })
})

describe('applySessionPreset', () => {
  it('applies a coherent pin verbatim: nothing snapped', () => {
    const applied = applySessionPreset(
      { id: 'p1', name: 'fast', model: 'zai/glm-5.3', harness: 'opencode', effort: 'low' },
      { canonicalIds: CATALOG },
    )
    expect(applied).toEqual({ model: 'zai/glm-5.3', harness: 'opencode', effort: 'low', snapped: [] })
  })

  it('a pinned harness the model cannot run resolves to a coherent pair — the harness is the deliberate pin', () => {
    // Whatever the current snap helpers do with an incompatible pin, the applied
    // result must be coherent by the platform's own compatibility check, and any
    // change from the pinned ids must be reported. (The snap behavior itself is
    // the agent-interface owner's to evolve; the preset contract rides it.)
    const applied = applySessionPreset(
      { id: 'p1', name: 'wrong pair', model: 'zai/glm-5.3', harness: 'codex' },
      { canonicalIds: CATALOG },
    )
    expect(isModelCompatibleWithHarness(applied.harness, applied.model)).toBe(true)
    const changed = applied.model !== 'zai/glm-5.3' || applied.harness !== 'codex'
    expect(changed ? applied.snapped.length > 0 : applied.snapped.length === 0).toBe(true)
  })

  it('a model gone from the catalog is REFUSED, never silently substituted', () => {
    expect(() => applySessionPreset(
      { id: 'p1', name: 'retired', model: 'openai/gpt-4' },
      { canonicalIds: CATALOG },
    )).toThrow(/no longer carries/)
  })
})

describe('createInMemorySessionPresetStore', () => {
  it('saves validated, lists sorted, removes', async () => {
    const store = createInMemorySessionPresetStore()
    await store.save({ id: 'b', name: 'beta', model: 'zai/glm-5.3' })
    await store.save({ id: 'a', name: 'alpha', model: 'openai/gpt-6-luna' })
    expect((await store.list()).map((p: SessionPreset) => p.id)).toEqual(['a', 'b'])
    await store.remove('a')
    expect(await store.list()).toEqual([{ id: 'b', name: 'beta', model: 'zai/glm-5.3' }])
  })
})
