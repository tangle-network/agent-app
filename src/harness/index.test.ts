import { describe, expect, it } from 'vitest'
import {
  coerceHarness,
  isHarness,
  resolveSessionHarness,
  DEFAULT_HARNESS,
  KNOWN_HARNESSES,
  isModelCompatibleWithHarness,
  snapModelToHarness,
  snapHarnessToModel,
  assertHarnessModelCompatible,
} from './index'

describe('harness taxonomy + coercion', () => {
  it('recognizes known harnesses, rejects everything else', () => {
    expect(isHarness('opencode')).toBe(true)
    expect(isHarness('codex')).toBe(true)
    expect(isHarness('cursor')).toBe(true)
    expect(isHarness('not-a-harness')).toBe(false)
    expect(isHarness(undefined)).toBe(false)
    expect(isHarness(42)).toBe(false)
  })

  it('coerces to a known harness or the fallback', () => {
    expect(coerceHarness('codex')).toBe('codex')
    expect(coerceHarness('bogus')).toBe(DEFAULT_HARNESS) // opencode
    expect(coerceHarness('bogus', 'claude-code')).toBe('claude-code')
    expect(coerceHarness(null)).toBe('opencode')
  })

  it('DEFAULT_HARNESS is a member of the list', () => {
    expect(KNOWN_HARNESSES).toContain(DEFAULT_HARNESS)
  })
})

describe('resolveSessionHarness — the session lock', () => {
  it('fresh session: picks requested → workspaceDefault → fallback', () => {
    expect(resolveSessionHarness({ requested: 'codex' })).toEqual({ harness: 'codex', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({ workspaceDefault: 'claude-code' })).toEqual({ harness: 'claude-code', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({ requested: 'bogus', workspaceDefault: 'amp' })).toEqual({ harness: 'amp', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({})).toEqual({ harness: 'opencode', locked: false, swapAttempted: false })
    expect(resolveSessionHarness({ fallback: 'codex' })).toEqual({ harness: 'codex', locked: false, swapAttempted: false })
  })

  it('locked session: the locked harness wins, model-change is irrelevant', () => {
    // No swap requested → just returns the lock.
    expect(resolveSessionHarness({ sessionHarness: 'codex' })).toEqual({ harness: 'codex', locked: true, swapAttempted: false })
    // Same harness re-requested → not a swap.
    expect(resolveSessionHarness({ sessionHarness: 'codex', requested: 'codex' })).toEqual({ harness: 'codex', locked: true, swapAttempted: false })
  })

  it('locked session: a differing requested harness is a forbidden swap (lock still wins)', () => {
    const r = resolveSessionHarness({ sessionHarness: 'opencode', requested: 'codex' })
    expect(r).toEqual({ harness: 'opencode', locked: true, swapAttempted: true })
  })

  it('locked session: workspaceDefault cannot override the lock', () => {
    const r = resolveSessionHarness({ sessionHarness: 'codex', workspaceDefault: 'amp' })
    expect(r.harness).toBe('codex')
    expect(r.locked).toBe(true)
  })
})

describe('harness ↔ model compatibility (server-enforced)', () => {
  const CATALOG = ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'openai/gpt-5-mini']

  it('vendor-locked harnesses only accept their provider; router harnesses accept any', () => {
    expect(isModelCompatibleWithHarness('claude-code', 'anthropic/claude-sonnet-4-6')).toBe(true)
    expect(isModelCompatibleWithHarness('claude-code', 'openai/gpt-5')).toBe(false)
    expect(isModelCompatibleWithHarness('codex', 'openai/gpt-5')).toBe(true)
    expect(isModelCompatibleWithHarness('codex', 'anthropic/claude-sonnet-4-6')).toBe(false)
    expect(isModelCompatibleWithHarness('opencode', 'openai/gpt-5')).toBe(true)
  })

  it('provider-less / sentinel ids are compatible everywhere', () => {
    expect(isModelCompatibleWithHarness('claude-code', 'default')).toBe(true)
    expect(isModelCompatibleWithHarness('codex', '')).toBe(true)
  })

  it('snapModelToHarness picks the best compatible catalog model, opus before sonnet', () => {
    expect(snapModelToHarness('claude-code', 'openai/gpt-5', CATALOG)).toBe('anthropic/claude-opus-4-6')
    expect(snapModelToHarness('codex', 'anthropic/claude-sonnet-4-6', CATALOG)).toBe('openai/gpt-5')
    // already compatible → unchanged
    expect(snapModelToHarness('claude-code', 'anthropic/claude-sonnet-4-6', CATALOG)).toBe('anthropic/claude-sonnet-4-6')
  })

  it('snapHarnessToModel adopts the model\'s native harness', () => {
    expect(snapHarnessToModel('claude-code', 'openai/gpt-5')).toBe('codex')
    expect(snapHarnessToModel('codex', 'anthropic/claude-sonnet-4-6')).toBe('claude-code')
    expect(snapHarnessToModel('claude-code', 'anthropic/claude-opus-4-6')).toBe('claude-code')
  })

  it('assertHarnessModelCompatible throws on a forbidden pair, passes a valid one', () => {
    expect(() => assertHarnessModelCompatible('claude-code', 'openai/gpt-5')).toThrow(/cannot run model/)
    expect(() => assertHarnessModelCompatible('claude-code', 'anthropic/claude-sonnet-4-6')).not.toThrow()
    expect(() => assertHarnessModelCompatible('opencode', 'openai/gpt-5')).not.toThrow()
    expect(() => assertHarnessModelCompatible('claude-code', 'default')).not.toThrow()
  })
})
