import { describe, expect, it } from 'vitest'
import {
  applySessionPreset,
  createInMemorySessionPresetStore,
  validateSessionPreset,
  type SessionPreset,
} from './presets'

const CATALOG = ['openai/gpt-6-luna', 'anthropic/claude-4.6', 'zai/glm-5.3', 'default']

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

  it('a pinned harness the model cannot run snaps the MODEL within it — the harness is the deliberate pin', () => {
    // claude-4.6 is Anthropic-native; pinned to codex, the harness wins and the
    // model snaps to codex's best catalog option, exactly like a manual harness change.
    const applied = applySessionPreset(
      { id: 'p1', name: 'wrong pair', model: 'anthropic/claude-4.6', harness: 'codex' },
      { canonicalIds: CATALOG },
    )
    expect(applied.harness).toBe('codex')
    expect(applied.model).not.toBe('anthropic/claude-4.6')
    expect(applied.snapped).toContain('model')
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
