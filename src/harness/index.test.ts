import { describe, expect, it } from 'vitest'
import { coerceHarness, isHarness, resolveSessionHarness, DEFAULT_HARNESS, KNOWN_HARNESSES } from './index'

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
