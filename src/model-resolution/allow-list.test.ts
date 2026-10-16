import { describe, expect, it } from 'vitest'
import {
  formatModelNotAllowedRefusal,
  parseModelNotAllowed,
  resolveModelWithinAllowList,
} from './allow-list'

describe('parseModelNotAllowed', () => {
  it('parses the primary refusal shape (Model "x" is not in … Allowed: a, b)', () => {
    expect(
      parseModelNotAllowed('Model "gpt-6-luna" is not in this key\'s allow-list. Allowed: glm-5.3, gpt-5.5.'),
    ).toEqual(['glm-5.3', 'gpt-5.5'])
  })

  it('parses the fallback refusal shape (Fallback model(s) … Allowed: a, b)', () => {
    expect(
      parseModelNotAllowed('Fallback model(s) "x", "y" are not in this key\'s allow-list. Allowed: glm-5.3, opencode/deepseek/deepseek-v4-flash.'),
    ).toEqual(['glm-5.3', 'opencode/deepseek/deepseek-v4-flash'])
  })

  it('parses a set with no trailing period', () => {
    expect(parseModelNotAllowed('Model "x" is not in this key\'s allow-list. Allowed: glm-5.3')).toEqual(['glm-5.3'])
  })

  it('returns null for an unexpected shape rather than guessing', () => {
    expect(parseModelNotAllowed('This key does not allow the requested model')).toBeNull()
    expect(parseModelNotAllowed('')).toBeNull()
    expect(parseModelNotAllowed('Allowed:')).toBeNull()
  })
})

describe('resolveModelWithinAllowList', () => {
  const allowed = ['glm-5.3', 'gpt-5.5'] as const

  it('passes an unscoped key straight through', () => {
    for (const allowedModels of [undefined, null, [] as const] as const) {
      expect(resolveModelWithinAllowList({ requested: 'gpt-6-luna', allowedModels })).toEqual({
        status: 'allowed',
        model: 'gpt-6-luna',
        rerouted: false,
      })
    }
  })

  it('allows a requested model the list permits', () => {
    expect(resolveModelWithinAllowList({ requested: 'glm-5.3', allowedModels: allowed })).toEqual({
      status: 'allowed',
      model: 'glm-5.3',
      rerouted: false,
    })
  })

  it('reroutes to the FIRST permitted fallback, naming the blocked model', () => {
    expect(
      resolveModelWithinAllowList({
        requested: 'gpt-6-luna',
        allowedModels: allowed,
        fallbacks: ['claude-4.6', 'gpt-5.5', 'glm-5.3'],
      }),
    ).toEqual({ status: 'rerouted', model: 'gpt-5.5', rerouted: true, blockedModel: 'gpt-6-luna' })
  })

  it('refuses with the allowed set when no fallback is permitted (fail-closed, never silent)', () => {
    expect(
      resolveModelWithinAllowList({ requested: 'gpt-6-luna', allowedModels: allowed, fallbacks: ['claude-4.6'] }),
    ).toEqual({ status: 'refused', model: null, allowedModels: ['glm-5.3', 'gpt-5.5'] })
    expect(resolveModelWithinAllowList({ requested: 'gpt-6-luna', allowedModels: allowed }).status).toBe('refused')
  })
})

describe('formatModelNotAllowedRefusal', () => {
  it('names the blocked model, the allowed set, and the fix', () => {
    expect(formatModelNotAllowedRefusal({ requested: 'gpt-6-luna', allowedModels: ['glm-5.3'] })).toBe(
      'Model "gpt-6-luna" is not in this key\'s allow-list. Allowed: glm-5.3. Route to an allowed model or widen the key\u2019s allow-list.',
    )
  })
})
